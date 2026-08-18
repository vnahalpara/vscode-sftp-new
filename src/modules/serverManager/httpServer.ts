import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { Route, RouteParams, matchRoute } from './router';
import { attachWs } from './wsServer';

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
// handing a caller a live socket. Nothing is wired to onTerminal/onLogs yet
// -- those arrive with the features that use them -- so today an
// authenticated upgrade is accepted and then immediately closed; the point
// of doing this here, now, is that the auth boundary is live and exercised
// (including by the production build, which is what proves the `ws`
// dependency's optional native addons are excluded correctly -- see
// webpack.config.js) rather than added later alongside a feature under
// pressure to ship it.
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

  // Same predicate as the /api/* gate above (deps.hasToken): one token, one
  // set of valid sessions, whether the request arrives as a plain HTTP call
  // or a WebSocket upgrade.
  attachWs(server, { hasToken: deps.hasToken });

  return server;
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
