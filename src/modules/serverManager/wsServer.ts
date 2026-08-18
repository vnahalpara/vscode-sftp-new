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
function isOurHostPort(hostPort: string | undefined, port: number): boolean {
  return hostPort === `127.0.0.1:${port}` || hostPort === `localhost:${port}`;
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
  const parsed = url.parse(req.url || '', true);
  const pathname = parsed.pathname || '';
  if (KNOWN_PATHS.indexOf(pathname) === -1) {
    return { ok: false, reason: 'unknown path' };
  }

  const host = headerValue(req.headers.host);
  if (!isOurHostPort(host, port)) {
    return { ok: false, reason: 'host does not match this server (possible DNS rebinding)' };
  }

  // Absent is fine (non-browser client); present-and-wrong is not.
  const origin = headerValue(req.headers.origin);
  if (origin !== undefined) {
    const originHostPort = url.parse(origin).host || undefined;
    if (!isOurHostPort(originHostPort, port)) {
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
  onTerminal?: (ws: WebSocket, req: http.IncomingMessage) => void;
  onLogs?: (ws: WebSocket, req: http.IncomingMessage) => void;
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

export function attachWs(server: http.Server, opts: WsOpts): { close(): void } {
  // noServer: true means `ws` never binds a listener of its own -- upgrades
  // arrive only via the http.Server's 'upgrade' event, which we handle
  // below so checkUpgrade runs before `ws` ever sees the request.
  const wss = new WebSocketServer({ noServer: true });

  function onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
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

    wss.handleUpgrade(req, socket, head, ws => {
      const pathname = url.parse(req.url || '', true).pathname;
      if (pathname === '/ws/terminal' && opts.onTerminal) {
        opts.onTerminal(ws, req);
        return;
      }
      if (pathname === '/ws/logs' && opts.onLogs) {
        opts.onLogs(ws, req);
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
      // Terminates every currently-open connection this server accepted;
      // sockets rejected in onUpgrade were never handed to `wss` and are
      // unaffected.
      wss.close();
    },
  };
}
