import * as http from 'http';
import * as path from 'path';
import { tokenFrom, safeJoin, contentType, createServer, listen, Handler } from '../httpServer';
import { Route } from '../router';

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
