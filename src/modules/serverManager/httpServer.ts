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
  json(status: number, body: any): void;
  text(status: number, body: string, type?: string): void;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export interface ServerDeps {
  root: string;
  routes: Route<Handler>[];
  hasToken(token: string): boolean;
  fallbackHtml(): string;
  // Wired by index.ts (see ensureServer()) once the Terminal tab has a
  // session to bridge to. Left undefined here still means what it always
  // has: an authenticated upgrade to /ws/terminal is accepted and then
  // immediately closed -- see attachWs's WsOpts.onTerminal. /ws/logs has no
  // equivalent field yet on purpose; that arrives with the log follower.
  onTerminal?: WsOpts['onTerminal'];
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
// handing a caller a live socket. /ws/terminal now has a real handler
// (deps.onTerminal, wired by index.ts once it can resolve a token to a
// session); /ws/logs still has nothing plugged into it -- that arrives with
// the log follower -- so an authenticated upgrade to THAT path is still
// accepted and then immediately closed. The auth boundary being live and
// exercised even for the still-unwired path (including by the production
// build, which is what proves the `ws` dependency's optional native addons
// are excluded correctly -- see webpack.config.js) was the point of standing
// this up before either feature existed, rather than alongside one of them
// under pressure to ship it.
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
      try {
        const result = match.handler(ctx);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(error => fail(ctx, error, true));
        }
      } catch (error) {
        fail(ctx, error as Error, true);
      }
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
