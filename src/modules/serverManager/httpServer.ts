import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { Route, RouteParams, matchRoute } from './router';
import { attachWs, WsHandle, WsOpts } from './wsServer';

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: RouteParams;
  query: any;
  token: string;
  // Always an object, even for a body-less GET or a POST with no body at
  // all ({}). Consumers index into it by key and must never have to
  // null-check it.
  body: any;
  json(status: number, body: any): void;
  text(status: number, body: string, type?: string): void;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

// 1 MiB. Generous for the JSON payloads this surface carries (table/column
// names, WHERE clauses, small result-set edits) while still bounding how
// much a single request can hold in memory before it is rejected.
export const MAX_BODY_BYTES = 1048576;

// A loopback caller is the extension's own webview, on the same machine --
// there is no network hop to be slow on. 15s is generous headroom for a
// slow/contended local machine (a big JSON edit encoded on a throttled CPU)
// while still bounding the leak an idle client causes to a short window
// rather than forever: a client that sends headers with a Content-Length
// and then goes quiet fires neither 'data', 'end', nor 'error', so without
// this timer the request, response and accumulated buffer would sit alive
// until the process exits.
export const BODY_IDLE_TIMEOUT_MS = 15000;

// A signal, not a real Error subclass: readJsonBody's caller only needs the
// status code to answer with, never a stack trace (these are all client
// input problems, not bugs).
class BodyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Only ever called for POST/PUT/PATCH, after the token check and after
// matchRoute -- see the isApi branch below for why. Resolves to {} for a
// route that expects a body but the caller sent none, so callers never have
// to distinguish "no body" from "empty object". Takes res (rather than
// leaving all responding to the caller) so the size-cap and idle-timeout
// paths below can write their own response *before* the socket is torn
// down.
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, idleTimeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const contentTypeHeader = req.headers['content-type'];
    const hasContentType = typeof contentTypeHeader === 'string' && contentTypeHeader.length > 0;
    const isJson = hasContentType && /^application\/json(\s*;.*)?$/i.test((contentTypeHeader as string).trim());
    // A declared-but-wrong type is rejected up front, before waiting on any
    // bytes: the header alone already tells us this request cannot be
    // satisfied. An *absent* type is not rejected here -- see onData below,
    // which is the only place that can tell whether the body turned out to
    // be empty (allowed, per the brief) or not (still a 415).
    if (hasContentType && !isJson) {
      reject(new BodyError(415, 'Unsupported content type'));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Answer first, then destroy once the response has actually finished
    // flushing to the socket: res.end() is asynchronous with respect to the
    // underlying write, so destroying in the same tick can truncate the
    // response that was just sent. This has already bitten this function
    // once (the size cap below); the idle-timeout path a few lines down
    // hits the exact same hazard, which is why both paths share this
    // helper instead of each inlining their own ordering.
    const respondThenDestroy = (status: number, message: string) => {
      if (res.headersSent) {
        req.destroy();
        return;
      }
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(message, () => req.destroy());
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn();
    };

    // Idle, not total-duration: reset on every chunk so a legitimately slow
    // but *progressing* upload is never killed, only a connection that has
    // gone silent.
    const resetIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        finish(() => {
          respondThenDestroy(408, 'Request body idle timeout');
          reject(new BodyError(408, 'Request body idle timeout'));
        });
      }, idleTimeoutMs);
    };

    const onData = (chunk: Buffer) => {
      if (!hasContentType && total === 0) {
        // First byte of a body that never declared a type. The brief's
        // exception for a missing content-type is scoped to a zero-length
        // body (resolved in onEnd below, which this never reaches); actual
        // bytes with no declared type are exactly as unsupported as bytes
        // with the wrong declared type.
        finish(() => reject(new BodyError(415, 'Unsupported content type')));
        return;
      }
      resetIdleTimer();
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Stop accumulating and answer immediately rather than draining the
        // rest of a payload already decided to be too big.
        finish(() => {
          respondThenDestroy(413, 'Request body too large');
          reject(new BodyError(413, 'Request body too large'));
        });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      finish(() => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          reject(new BodyError(400, 'Malformed JSON body'));
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new BodyError(400, 'JSON body must be an object'));
          return;
        }
        resolve(parsed);
      });
    };

    // A client that disconnects mid-body (or any other stream error) must
    // reject rather than hang the handler forever waiting on 'end'. The
    // socket is already gone by the time this fires, so this only ever
    // unwinds the promise -- see the dispatch catch below for why it must
    // not then try to write a response on it.
    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);

    // Covers the silent-client case where 'data' never fires at all (headers
    // arrive with a Content-Length, then nothing): without this, the timer
    // would never even start, since resetIdleTimer() above is otherwise
    // only reached from inside onData.
    resetIdleTimer();
  });
}

export interface ServerDeps {
  root: string;
  routes: Route<Handler>[];
  hasToken(token: string): boolean;
  fallbackHtml(): string;
  // Wired by index.ts (see ensureServer()) once the Terminal tab has a
  // session to bridge to. Left undefined here still means what it always
  // has: an authenticated upgrade to /ws/terminal is accepted and then
  // immediately closed -- see attachWs's WsOpts.onTerminal.
  onTerminal?: WsOpts['onTerminal'];
  // Wired by index.ts the same way onTerminal is, once there is a session to
  // resolve the token against -- see serverManager/logFollow.ts. Left
  // undefined still means what onTerminal's absence always has: an
  // authenticated upgrade to /ws/logs is accepted and then immediately
  // closed, never left open with nothing driving it.
  onLogs?: WsOpts['onLogs'];
  // Overrides BODY_IDLE_TIMEOUT_MS for readJsonBody. Production code never
  // sets this; it exists so a test can inject a short timeout instead of
  // making the suite actually wait out the real one.
  bodyIdleTimeoutMs?: number;
}

const TYPES: { [ext: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// A repeated ?t= parses to an array; treating that as "no token" avoids having
// to decide which of two tokens the caller meant.
export function tokenFrom(query: any, headers: any): string {
  const fromQuery = query && query.t;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) {
    return fromQuery;
  }
  const fromHeader = headers && headers['x-sftp-token'];
  return typeof fromHeader === 'string' ? fromHeader : '';
}

// Decode first, then normalise, then prove the result is still under the root.
// Normalisation strips leading .. segments before the join happens, so
// traversal input resolves to a path *inside* the root that simply does not
// exist on disk (the caller falls through to the shell page) rather than
// escaping it. The containment check below is defence in depth for anything
// that could still slip past normalisation.
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (error) {
    return null;
  }
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  if (target !== base && target.indexOf(base + path.sep) !== 0) {
    return null;
  }
  return target;
}

function isApi(pathname: string): boolean {
  return pathname === '/api' || pathname.indexOf('/api/') === 0;
}

// The WebSocket upgrade paths (/ws/terminal, /ws/logs) share this same
// server and the same per-session token as /api/*: attachWs() installs its
// own 'upgrade' listener and re-checks Origin/Host on top of the token (see
// wsServer.ts's checkUpgrade for why that extra check exists) before ever
// handing a caller a live socket. Both /ws/terminal and /ws/logs now have
// real handlers (deps.onTerminal/deps.onLogs, wired by index.ts once it can
// resolve a token to a session); an authenticated upgrade to either path
// with no handler wired (e.g. a test server built without one) is still
// accepted and then immediately closed rather than left open with nothing
// driving it. The auth boundary being live and exercised even before either
// feature existed (including by the production build, which is what proves
// the `ws` dependency's optional native addons are excluded correctly -- see
// webpack.config.js) was the point of standing this up first, rather than
// alongside one of them under pressure to ship it.
// The WebSocket side of a server built by createServer(), kept beside the
// http.Server rather than returned from it so createServer keeps its
// single-value signature and every existing caller keeps working. A WeakMap
// so a discarded server takes its entry with it.
const wsHandles = new WeakMap<http.Server, WsHandle>();

export function createServer(deps: ServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';
    const token = tokenFrom(parsed.query, req.headers);

    const ctx: Ctx = {
      req,
      res,
      params: {},
      query: parsed.query,
      token,
      // Reassigned below for POST/PUT/PATCH once readJsonBody resolves; every
      // other method keeps this default rather than waiting on a body that
      // was never going to arrive (GET /api/stream is a long-lived SSE
      // response -- blocking it on a body read hangs the whole dashboard).
      body: {},
      json(status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(payload);
      },
      text(status, body, type) {
        res.writeHead(status, {
          'content-type': type || 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
      },
    };

    // Only the data is secret. Static assets and the shell page are not, and
    // requiring a token for them would break every <script src> the UI emits.
    if (isApi(pathname)) {
      if (!deps.hasToken(token)) {
        ctx.text(401, 'Unauthorized');
        return;
      }
      const match = matchRoute(deps.routes, req.method || 'GET', pathname);
      if (!match) {
        ctx.text(404, 'Not found');
        return;
      }
      ctx.params = match.params;

      const dispatch = async () => {
        // Only these methods can carry a body. A GET must never wait on one
        // -- see the ctx.body comment above -- and reading a body before
        // this point (before the token check, before matchRoute) would let
        // an unauthenticated caller stream a megabyte into this process for
        // a path that might not even be a real route.
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const idleTimeoutMs =
            typeof deps.bodyIdleTimeoutMs === 'number' ? deps.bodyIdleTimeoutMs : BODY_IDLE_TIMEOUT_MS;
          ctx.body = await readJsonBody(req, res, idleTimeoutMs);
        }
        await match.handler(ctx);
      };

      dispatch().catch(error => {
        if (error instanceof BodyError) {
          // The 413 path already wrote its own response before rejecting
          // (see readJsonBody) and headersSent will be true here; every
          // other BodyError (400/415) reaches this still unanswered.
          if (!ctx.res.headersSent) {
            ctx.text(error.status, error.message);
          }
          return;
        }
        // A body-read rejection that is not a BodyError is the request
        // socket's own 'error' event (client disconnected mid-body): the
        // socket is already gone, so there is nothing left to answer on.
        if (req.socket && req.socket.destroyed) {
          return;
        }
        fail(ctx, error as Error, true);
      });
      return;
    }

    serveStatic(deps, ctx, pathname);
  });

  // Same predicate as the /api/* gate above: one token, one set of valid
  // sessions, whether the request arrives as a plain HTTP call or a
  // WebSocket upgrade. Wrapped rather than passed by reference so hasToken
  // is always invoked as a method of deps -- an unbound method that later
  // grows a `this` would break here, silently and only on the upgrade path.
  const ws = attachWs(server, {
    hasToken: token => deps.hasToken(token),
    onTerminal: deps.onTerminal,
    onLogs: deps.onLogs,
  });
  wsHandles.set(server, ws);

  return server;
}

// Shut a server down for real. http.Server#close() alone is NOT a teardown
// when WebSockets are involved: it stops accepting new connections and waits
// for existing ones to end, and an already-upgraded socket never ends on its
// own -- so a disposed dashboard would leave a live Terminal socket, and a
// live shell on the user's production host, running until the browser tab
// was closed. Terminate the sockets first, then close the listener.
export function closeServer(server: http.Server): void {
  const ws = wsHandles.get(server);
  if (ws) {
    ws.close();
  }
  server.close();
}

// Terminate the WebSockets belonging to one session, leaving the server up
// for every other session. Used when a single session is disposed or evicted
// (its credentials changed under it) while the dashboard stays open.
export function closeSessionSockets(server: http.Server, token: string): void {
  const ws = wsHandles.get(server);
  if (ws) {
    ws.closeToken(token);
  }
}

// `detail` is only ever true on the /api path, which is behind the token check.
// The static path is reachable without a token, and its errors are filesystem
// errors: an EACCES/ENOENT message carries the absolute extension install path,
// which no unauthenticated caller has any business learning.
function fail(ctx: Ctx, error: Error, detail: boolean): void {
  if (ctx.res.headersSent) {
    ctx.res.end();
    return;
  }
  ctx.text(500, (detail && error.message) || 'Internal error');
}

function serveStatic(deps: ServerDeps, ctx: Ctx, pathname: string): void {
  const target = safeJoin(deps.root, pathname === '/' ? '/index.html' : pathname);
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    const stream = fs.createReadStream(target);
    // pipe() does not forward the source's 'error' event, and an unhandled
    // 'error' on a stream throws synchronously — which in an extension host
    // means taking the whole extension process down. The file can vanish or
    // lose read permission between the statSync above and the open below.
    stream.on('error', error => {
      stream.destroy();
      fail(ctx, error as Error, false);
    });
    // Hold the header back until the file is actually open, so a failure to
    // open is answered with a real 500 rather than a truncated 200.
    stream.on('open', () => {
      ctx.res.writeHead(200, { 'content-type': contentType(target) });
      stream.pipe(ctx.res);
    });
    return;
  }
  // No build on disk, or a client-side route: hand back the shell page.
  ctx.text(200, deps.fallbackHtml(), 'text/html; charset=utf-8');
}

// Always loopback, always an OS-assigned port. There is no host or port
// parameter on purpose: there must be no way to bind this to 0.0.0.0.
export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      resolve(address.port);
    });
  });
}
