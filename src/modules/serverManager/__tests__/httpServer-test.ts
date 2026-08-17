import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { tokenFrom, safeJoin, contentType, createServer, listen, Handler } from '../httpServer';
import { Route } from '../router';

// The @types/node version pinned here predates fs.rmSync and the recursive
// option on fs.rmdirSync, so temp-dir cleanup needs a manual walk.
function removeDirRecursive(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      removeDirRecursive(full);
    } else {
      fs.unlinkSync(full);
    }
  }
  fs.rmdirSync(dir);
}

describe('tokenFrom', () => {
  it('prefers the query parameter', () => {
    expect(tokenFrom({ t: 'from-query' }, { 'x-sftp-token': 'from-header' })).toBe('from-query');
  });

  it('falls back to the header', () => {
    expect(tokenFrom({}, { 'x-sftp-token': 'from-header' })).toBe('from-header');
  });

  it('is empty when neither is present', () => {
    expect(tokenFrom({}, {})).toBe('');
  });

  it('ignores a repeated query parameter parsed as an array', () => {
    expect(tokenFrom({ t: ['a', 'b'] }, {})).toBe('');
  });
});

describe('safeJoin', () => {
  const ROOT = path.resolve('/tmp/webui-root');

  it('resolves a plain file', () => {
    expect(safeJoin(ROOT, '/index.html')).toBe(path.join(ROOT, 'index.html'));
  });

  it('resolves a nested asset', () => {
    expect(safeJoin(ROOT, '/assets/app.js')).toBe(path.join(ROOT, 'assets', 'app.js'));
  });

  it('contains a dot-dot escape instead of letting it out of the root', () => {
    // Normalisation strips the leading .. segments, so the request lands on a
    // path inside the root that simply does not exist, and falls through to
    // the shell page. It never reaches /etc/passwd.
    expect(safeJoin(ROOT, '/../../etc/passwd')).toBe(path.join(ROOT, 'etc', 'passwd'));
  });

  it('contains a percent-encoded dot-dot escape', () => {
    expect(safeJoin(ROOT, '/%2e%2e/%2e%2e/etc/passwd')).toBe(path.join(ROOT, 'etc', 'passwd'));
  });

  it('returns null for input that cannot be percent-decoded', () => {
    expect(safeJoin(ROOT, '/%ZZ')).toBeNull();
  });

  it('never escapes the root, for any of a list of hostile inputs', () => {
    const hostile = [
      '/../../../../../../etc/passwd',
      '/..%2f..%2fetc/passwd',
      '/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/assets/../../../../etc/passwd',
      '/./././../../etc/shadow',
      '//....//....//etc/passwd',
    ];
    hostile.forEach(input => {
      const resolved = safeJoin(ROOT, input);
      if (resolved !== null) {
        expect(resolved.indexOf(ROOT)).toBe(0);
      }
    });
  });
});

describe('contentType', () => {
  it('maps the types the UI build produces', () => {
    expect(contentType('index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('app.css')).toBe('text/css; charset=utf-8');
    expect(contentType('logo.svg')).toBe('image/svg+xml');
    expect(contentType('font.woff2')).toBe('font/woff2');
  });

  it('falls back to octet-stream for anything unknown', () => {
    expect(contentType('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('createServer', () => {
  let server: http.Server;
  let port: number;

  const routes: Route<Handler>[] = [
    { method: 'GET', path: '/api/ok', handler: ctx => ctx.json(200, { ok: true, token: ctx.token }) },
    { method: 'GET', path: '/api/echo/:name', handler: ctx => ctx.json(200, { name: ctx.params.name }) },
    { method: 'GET', path: '/api/boom', handler: () => { throw new Error('handler exploded'); } },
  ];

  beforeAll(async () => {
    server = createServer({
      root: path.resolve('/tmp/does-not-exist-webui'),
      routes,
      hasToken: token => token === 'good-token',
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
    });
    port = await listen(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function get(pathname: string, headers: any = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      });
      req.on('error', reject);
    });
  }

  it('binds loopback only', () => {
    const address = server.address() as any;
    expect(address.address).toBe('127.0.0.1');
  });

  it('serves an API route with a valid token in the query', async () => {
    const res = await get('/api/ok?t=good-token');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, token: 'good-token' });
  });

  it('serves an API route with a valid token in the header', async () => {
    const res = await get('/api/ok', { 'x-sftp-token': 'good-token' });
    expect(res.status).toBe(200);
  });

  it('rejects an API route with no token', async () => {
    const res = await get('/api/ok');
    expect(res.status).toBe(401);
  });

  it('rejects an API route with a wrong token', async () => {
    const res = await get('/api/ok?t=wrong');
    expect(res.status).toBe(401);
  });

  it('passes route parameters to the handler', async () => {
    const res = await get('/api/echo/nginx?t=good-token');
    expect(JSON.parse(res.body)).toEqual({ name: 'nginx' });
  });

  it('returns 404 for an unknown API route even with a good token', async () => {
    const res = await get('/api/nope?t=good-token');
    expect(res.status).toBe(404);
  });

  it('turns a throwing handler into a 500 rather than killing the process', async () => {
    const res = await get('/api/boom?t=good-token');
    expect(res.status).toBe(500);
    expect(res.body).toContain('handler exploded');
  });

  it('serves the fallback page at the root without a token', async () => {
    // The HTML is not secret; the data behind /api is.
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bootstrap');
  });

  it('serves the fallback page for an unknown non-API path', async () => {
    const res = await get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bootstrap');
  });
});

describe('createServer static file serving', () => {
  // No test above ever serves a real file — root is always a path that does
  // not exist, so the whole static-file branch (including its error
  // handling) had zero positive coverage. This block points root at a real
  // temp directory with real files on disk.
  let server: http.Server;
  let port: number;
  let root: string;

  // root ignores file permission bits, so the permission-based error test
  // below is meaningless (and would fail to trip) when running as root.
  const canTestPerms = !(process.getuid && process.getuid() === 0);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-webui-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>real index</title>');
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("app");');

    server = createServer({
      root,
      routes: [],
      hasToken: () => false,
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
    });
    port = await listen(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeDirRecursive(root);
  });

  function get(pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      });
      req.on('error', reject);
    });
  }

  it('serves the real index.html at the root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('real index');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('serves a nested asset with the right content-type', async () => {
    const res = await get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('falls through to the shell page for a missing file, rather than 404ing', async () => {
    const res = await get('/nope/missing.js');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bootstrap');
  });

  (canTestPerms ? it : it.skip)('turns a read failure into a 500 and keeps serving afterwards', async () => {
    const unreadable = path.join(root, 'unreadable.css');
    fs.writeFileSync(unreadable, 'body {}');
    fs.chmodSync(unreadable, 0o000);
    try {
      const res = await get('/unreadable.css');
      expect(res.status).toBe(500);

      // The important part: an open failure must not have taken the server
      // down. A follow-up request still gets served normally.
      const again = await get('/');
      expect(again.status).toBe(200);
      expect(again.body).toContain('real index');
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });
});
