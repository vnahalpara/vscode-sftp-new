import * as http from 'http';
import * as net from 'net';
import * as url from 'url';
import { WebSocket, WebSocketServer } from 'ws';

// The set of upgrade targets this server knows how to serve. Anything else
// (a typo, a probe, an old client hitting a removed path) is rejected before
// any of the other checks run -- there is no point spending an Origin/Host/
// token check on a path nothing will ever handle.
const KNOWN_PATHS = ['/ws/terminal', '/ws/logs'];

export interface UpgradeCheck {
  ok: boolean;
  reason: string | null;
}

// First value of a header that node may have folded into an array (repeated
// headers), or undefined if the header was never sent.
function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

// True when `hostPort` (as sent in a Host or parsed-from-Origin header) names
// this server: loopback address or the `localhost` name, on exactly this
// server's port. Anything else -- a different port, a different host, a
// bare hostname with no port -- is rejected.
//
// Lowercased first because host names are case-insensitive and both callers
// must agree: url.parse() already lowercases the host it extracts from an
// Origin, but a raw Host header is passed through verbatim, so without this
// `Host: LOCALHOST:5599` was rejected while the identical Origin was
// accepted. That was fail-CLOSED (a false rejection, never a bypass), but it
// is still wrong, and a needlessly rejected upgrade is a bug report nobody
// can reproduce.
function isOurHostPort(hostPort: string | undefined, port: number): boolean {
  const normalized = (hostPort || '').toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

// url.parse() THROWS on some inputs -- notably an unterminated IPv6 literal
// (`http://[`), which raises ERR_INVALID_URL. Both things parsed here (the
// request target and the Origin header) are fully attacker-controlled and,
// critically, are parsed BEFORE the token is checked, so an unguarded parse
// is an uncaught exception in the extension host reachable with no
// credential at all. Every parse in this module goes through here, and a
// failure to parse is simply not a request we serve.
function parseSafe(input: string, parseQuery?: boolean): url.UrlWithParsedQuery | url.Url | null {
  try {
    return parseQuery ? url.parse(input, true) : url.parse(input);
  } catch (error) {
    return null;
  }
}

// A minimal, local twin of httpServer.ts's tokenFrom (query `?t=` first, the
// `x-sftp-token` header as a fallback, a repeated query param treated as
// absent). Not imported from httpServer.ts on purpose: attachWs() below is
// wired into createServer() there, so httpServer.ts already imports THIS
// module -- importing back would make the two files a require cycle for the
// sake of three lines that cannot drift unnoticed, since both are covered by
// their own tests.
function tokenFromUpgrade(query: any, headers: any): string {
  const fromQuery = query && query.t;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) {
    return fromQuery;
  }
  const fromHeader = headers && headers['x-sftp-token'];
  return typeof fromHeader === 'string' ? fromHeader : '';
}

// checkUpgrade is a PURE function -- no socket, no server, just data in and a
// verdict out -- specifically so the security logic here can be unit tested
// exhaustively without standing up a real listener. Every branch below is a
// distinct way an upgrade can be illegitimate, and every branch returns
// before the next one runs: the checks are cheapest-and-most-structural
// first (is this even a path we serve), most expensive/most-secret last
// (the token), so a request that fails early never pays for -- or leaks
// information via timing about -- checks further down.
//
// Why Origin and Host are checked here at all, given the token already
// gates access:
//
//   A terminal on a loopback WebSocket is remote code execution as the SSH
//   user. Browsers do NOT apply the same-origin policy to WebSocket
//   upgrades the way they do to fetch()/XHR: there is no CORS preflight,
//   and ANY page the user has open in a tab can run
//   `new WebSocket('ws://127.0.0.1:<port>/ws/terminal?t=...')` and have the
//   browser send it, cookies and all is not even required here since the
//   token travels in the URL. If that URL (and therefore the token) ever
//   leaks -- a screenshot, a pasted link, shell history, a browser history
//   sync -- the token alone must not be sufficient to open the socket.
//   Checking Origin means a malicious *webpage* cannot use a leaked token
//   even if it has one, because the browser reports its own page's origin,
//   which will not be ours.
//
//   Origin does not defend against a malicious *local process* using curl
//   or a raw socket, since non-browser clients simply do not send an Origin
//   header -- so an ABSENT Origin is accepted; only a PRESENT one must
//   match. That is fine: a local process with a valid token was always
//   equally able to hit the plain HTTP /api/* surface, which has the same
//   property (see httpServer.ts's isApi() gate). Origin's job here is
//   narrowly to stop a browser tab, not a local process.
//
//   Host is a separate defence against DNS rebinding: a hostile domain can
//   be configured (by its owner, or by an attacker who has poisoned/altered
//   DNS) to resolve to 127.0.0.1. A browser that follows that resolution
//   sends a Host header of the hostile domain name, not "127.0.0.1" --
//   Origin can be forged or omitted by non-browser tooling, but Host is
//   supplied by the browser's own resolver and reflects what the attacker's
//   page actually asked for. Restricting Host to 127.0.0.1/localhost on our
//   exact port means a rebound domain simply cannot complete the handshake,
//   independent of whatever Origin it happens to send.
//
// Someone will eventually look at this and think Origin/Host duplicate the
// token check. They do not: the token proves the caller knows a secret: the
// Origin/Host checks prove the caller is not a hostile *webpage* relaying
// that secret on the victim's behalf.
export function checkUpgrade(
  req: { url?: string; headers: { [k: string]: any } },
  port: number,
  tokenIsValid: (t: string) => boolean
): UpgradeCheck {
  const parsed = parseSafe(req.url || '', true) as url.UrlWithParsedQuery | null;
  if (!parsed) {
    return { ok: false, reason: 'unparseable request target' };
  }
  const pathname = parsed.pathname || '';
  if (KNOWN_PATHS.indexOf(pathname) === -1) {
    return { ok: false, reason: 'unknown path' };
  }

  const host = headerValue(req.headers.host);
  if (!isOurHostPort(host, port)) {
    return { ok: false, reason: 'host does not match this server (possible DNS rebinding)' };
  }

  // Absent is fine (non-browser client); present-and-wrong is not. A present
  // Origin that does not even parse is present-and-wrong, not absent.
  const origin = headerValue(req.headers.origin);
  if (origin !== undefined) {
    const parsedOrigin = parseSafe(origin);
    // This server only ever speaks http on loopback, so an https (or ws:,
    // or file:) origin is not a page this server served, whatever host and
    // port it names.
    if (
      !parsedOrigin ||
      parsedOrigin.protocol !== 'http:' ||
      !isOurHostPort(parsedOrigin.host || undefined, port)
    ) {
      return { ok: false, reason: 'origin does not match this server' };
    }
  }

  // Missing and wrong collapse into the same reason on purpose: the reason
  // is for our own diagnostics (logs), and nothing downstream ever writes it
  // to the socket, but there is no reason to even compute a finer-grained
  // distinction that a future change could accidentally leak.
  const token = tokenFromUpgrade(parsed.query, req.headers);
  if (!token || !tokenIsValid(token)) {
    return { ok: false, reason: 'missing or invalid token' };
  }

  return { ok: true, reason: null };
}

export interface WsOpts {
  hasToken: (token: string) => boolean;
  // Handlers for the individual upgrade targets. Neither is required here:
  // this module only owns the handshake and the authentication boundary.
  // The interactive terminal and the log follower are separate features
  // (added by later work) that plug in by supplying these; until they do,
  // a successfully-authenticated upgrade to a path with no handler is
  // simply closed rather than left open with nothing driving it.
  // The token is passed through rather than left for the handler to
  // re-derive: checkUpgrade has already parsed req.url once to prove this
  // token valid, and handleUpgradeRequest below parses it again anyway to
  // build this register's key. A third parse in the handler would be
  // protected only by the invariant that req.url still parses the same way
  // it did a moment ago in a different function -- true today, but not a
  // property "written not to throw" survives editing.
  onTerminal?: (ws: WebSocket, req: http.IncomingMessage, token: string) => void;
  onLogs?: (ws: WebSocket, req: http.IncomingMessage, token: string) => void;
}

// Writes a minimal, bodyless HTTP response directly onto the raw socket and
// tears it down. This is the crux of "does not upgrade-then-close": the
// WebSocket handshake (a 101 Switching Protocols) never happens for a
// rejected request, so there is no window in which a socket exists that a
// caller could race to use before it gets closed. socket.destroy() (not
// end()) is deliberate too -- it drops the connection immediately rather
// than waiting on a graceful FIN, since a caller who just failed auth gets
// no benefit from a clean shutdown.
function reject(socket: net.Socket, status: number, statusText: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  } catch (error) {
    // The socket may already be half-closed by the time we get here; there
    // is nothing useful to do beyond destroying it below.
  }
  socket.destroy();
}

// attachWs is called from createServer(), before the server is listening
// and therefore before its port is assigned (this server always binds with
// port 0 -- see httpServer.ts's listen()). Rather than force every caller to
// thread the eventual port through, the port is read directly off the live
// server the moment an upgrade actually arrives, which is always after
// listen() has resolved.
function livePort(server: http.Server): number | null {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : null;
}

// What the owner of an http.Server gets back from attachWs: the two ways a
// live upgraded socket ever needs to be taken away from a client.
export interface WsHandle {
  // Stop accepting upgrades and terminate every socket already accepted.
  close(): void;
  // Terminate the sockets belonging to ONE session, leaving the server (and
  // every other session's sockets) alone.
  closeToken(token: string): void;
}

export function attachWs(server: http.Server, opts: WsOpts): WsHandle {
  // noServer: true means `ws` never binds a listener of its own -- upgrades
  // arrive only via the http.Server's 'upgrade' event, which we handle
  // below so checkUpgrade runs before `ws` ever sees the request.
  const wss = new WebSocketServer({ noServer: true });

  // Every socket this server has accepted and not yet seen close, and the
  // session token it was opened under.
  //
  // This register exists because NOTHING else can take these sockets away.
  // Once an HTTP connection is upgraded, http.Server#close() stops accepting
  // new connections and then simply waits -- it does not touch an upgraded
  // socket. WebSocketServer#close() in noServer mode is no help either: it
  // removes listeners and waits for its own 'close', and never calls
  // terminate() on a client. So without this, a disposed dashboard (or a
  // session evicted because its credentials changed) left the browser's
  // Terminal socket live, and with it a real shell running on the user's
  // production host, until the tab was closed or the shell exited on its
  // own.
  //
  // Terminating the socket is enough to reap the remote end as well, without
  // this module needing to know anything about shells or log follows: every
  // handler tears its own resources down off the socket's 'close'. That is
  // what makes this general enough for /ws/logs to inherit unchanged.
  const live = new Map<WebSocket, string>();

  function terminate(ws: WebSocket): void {
    try {
      ws.terminate();
    } catch (error) {
      // Already gone is exactly what we wanted.
    }
  }

  // Node calls this straight out of the parser, inside the raw socket's
  // 'data' callback: there is no promise, no request object and no framework
  // between us and the event loop, so anything that throws in here is an
  // UNCAUGHT exception in the extension host (taking every other extension
  // and the user's unsaved work with it) and additionally leaks the socket,
  // which nothing is left to destroy. checkUpgrade is written not to throw,
  // but "written not to throw" is not a property that survives editing, and
  // an upgrade request is reachable with no token at all. Refusing is always
  // a safe answer here, so refuse.
  function onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    try {
      handleUpgradeRequest(req, socket, head);
    } catch (error) {
      reject(socket, 403, 'Forbidden');
    }
  }

  function handleUpgradeRequest(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): void {
    const port = livePort(server);
    // Not listening yet (or listening on a pipe/UDS, which this server never
    // does): there is no port to validate Host/Origin against, so there is
    // nothing to do but refuse.
    if (port === null) {
      reject(socket, 403, 'Forbidden');
      return;
    }
    const check = checkUpgrade(req, port, opts.hasToken);
    if (!check.ok) {
      // A wrong/missing token reads as 401 (Unauthorized -- same status the
      // /api/* path uses for the same failure); a request that fails the
      // path/Host/Origin checks never gets far enough to be "about" a
      // credential at all, so it reads as 403 (Forbidden). Either way the
      // body carries no detail -- the distinction that matters (which
      // check failed) lives only in `check.reason`, for our own logs.
      const status = check.reason === 'missing or invalid token' ? 401 : 403;
      const statusText = status === 401 ? 'Unauthorized' : 'Forbidden';
      reject(socket, status, statusText);
      return;
    }

    // The token the upgrade authenticated with -- checkUpgrade has already
    // proved it valid, but does not hand it back, and the register needs it
    // to answer closeToken().
    const parsedForToken = parseSafe(req.url || '', true) as url.UrlWithParsedQuery | null;
    const token = tokenFromUpgrade(parsedForToken && parsedForToken.query, req.headers);

    wss.handleUpgrade(req, socket, head, ws => {
      live.set(ws, token);
      ws.on('close', () => {
        live.delete(ws);
      });
      // `ws` installs NO default 'error' handler on the sockets it accepts,
      // and both receiverOnError and senderOnError re-emit as 'error' -- so
      // an 'error' with no listener is EventEmitter's ERR_UNHANDLED_ERROR
      // throw, i.e. an extension host crash. A single frame with a reserved
      // bit set, from any client that got past the gate, is enough to reach
      // it. Attached BEFORE dispatch so there is no window in which the
      // socket is live and unguarded, and so a handler that forgets to
      // attach its own is still not a crash. (Handlers should attach their
      // own anyway -- this one only keeps the process alive; it does not
      // tear the handler's own state down.)
      ws.on('error', () => terminate(ws));
      const pathname = parsedForToken ? parsedForToken.pathname : undefined;
      if (pathname === '/ws/terminal' && opts.onTerminal) {
        opts.onTerminal(ws, req, token);
        return;
      }
      if (pathname === '/ws/logs' && opts.onLogs) {
        opts.onLogs(ws, req, token);
        return;
      }
      // Authenticated and structurally valid, but nothing is wired up to
      // drive this connection yet. Close rather than leave it open and
      // silent.
      ws.close();
    });
  }

  server.on('upgrade', onUpgrade);

  return {
    close(): void {
      server.removeListener('upgrade', onUpgrade);
      // Snapshot first: terminate() makes `ws` emit 'close', which deletes
      // from the map we would otherwise be iterating.
      Array.from(live.keys()).forEach(terminate);
      live.clear();
      // Releases `wss`'s own listeners. Deliberately AFTER the loop above,
      // and not relied on to do the terminating: in noServer mode
      // WebSocketServer#close() removes listeners and waits, and never
      // terminates a client.
      wss.close();
    },
    closeToken(token: string): void {
      Array.from(live.keys())
        .filter(ws => live.get(ws) === token)
        .forEach(ws => {
          live.delete(ws);
          terminate(ws);
        });
    },
  };
}
