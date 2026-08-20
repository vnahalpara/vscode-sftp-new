import * as http from 'http';
import * as path from 'path';
import { createServer, listen, Handler, MAX_BODY_BYTES } from '../httpServer';
import { Route } from '../router';

// Exercises ctx.body end to end through a real server rather than a
// hand-built Ctx, since the parsing happens in the request pipeline itself
// (between matchRoute and the handler call), not in anything a directly
// constructed Ctx would touch.
describe('createServer request body parsing', () => {
  let server: http.Server;
  let port: number;
  let seenBody: any;
  let handlerCalls: number;

  const routes: Route<Handler>[] = [
    {
      method: 'POST',
      path: '/api/echo-body',
      handler: ctx => {
        handlerCalls++;
        seenBody = ctx.body;
        ctx.json(200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/echo-body',
      handler: ctx => {
        handlerCalls++;
        seenBody = ctx.body;
        ctx.json(200, { ok: true });
      },
    },
  ];

  beforeAll(async () => {
    server = createServer({
      root: path.resolve('/tmp/does-not-exist-webui-body'),
      routes,
      hasToken: token => token === 'good-token',
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
    });
    port = await listen(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    seenBody = undefined;
    handlerCalls = 0;
  });

  function request(
    method: string,
    pathname: string,
    opts: { body?: string; headers?: any } = {}
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, opts.headers);
      // agent: false forces a fresh socket per request. Several tests here
      // deliberately have the server destroy or abandon the connection
      // (413, an unauthenticated POST) without draining it, and a pooled
      // socket carried over from one of those into the next request's
      // client-side reuse is a source of flaky ECONNRESET/hang-up noise
      // that has nothing to do with what each test is actually asserting.
      const req = http.request(
        { host: '127.0.0.1', port, path: pathname, method, headers, agent: false },
        res => {
          let body = '';
          res.on('data', chunk => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        }
      );
      req.on('error', reject);
      if (opts.body !== undefined) {
        req.write(opts.body);
      }
      req.end();
    });
  }

  it('parses a valid JSON object into ctx.body', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: JSON.stringify({ a: 1, b: 'two' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(seenBody).toEqual({ a: 1, b: 'two' });
  });

  it('accepts content-type with parameters', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(res.status).toBe(200);
    expect(seenBody).toEqual({ a: 1 });
  });

  it('gives the handler {} for a POST with no body at all', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token');
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(seenBody).toEqual({});
  });

  it('gives a GET handler {} and does not hang waiting on a body', async () => {
    const res = await request('GET', '/api/echo-body?t=good-token');
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(seenBody).toEqual({});
  });

  it('rejects malformed JSON with 400 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: '{not valid json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a JSON array with 400 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: JSON.stringify([1, 2]),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a JSON scalar (string) with 400 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: JSON.stringify('a string'),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a JSON scalar (number) with 400 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: '42',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a JSON null with 400 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: 'null',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a non-JSON content-type with 415 and never runs the handler', async () => {
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: 'hello=world',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(415);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a body over the byte cap with 413 and never runs the handler', async () => {
    const oversized = JSON.stringify({ big: 'x'.repeat(MAX_BODY_BYTES + 1) });
    const res = await request('POST', '/api/echo-body?t=good-token', {
      body: oversized,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(handlerCalls).toBe(0);
  });

  it('rejects an unauthenticated POST with 401 and never reads the body', async () => {
    const res = await request('POST', '/api/echo-body', {
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(handlerCalls).toBe(0);
  });
});
