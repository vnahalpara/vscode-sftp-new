import { buildRoutes } from '../routes';
import { matchRoute, Route } from '../router';
import { Ctx, Handler } from '../httpServer';

// Distinctive on purpose: a three-letter needle like 'tok' could pass even
// against a leaky implementation, which would make the assertion worthless.
const SECRET_TOKEN = 'TOKEN-SHOULD-NEVER-APPEAR-8f3a9c2b';

function fakeSession(overrides: any = {}, token: string = 'tok') {
  const written: string[] = [];
  return {
    written,
    session: {
      id: 'abc',
      token,
      state: () => ({
        id: 'abc',
        profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy' },
        status: 'online',
        error: null,
        facts: { hostname: 'web1', linux: true },
        interval: 2000,
        lastSeen: 99,
      }),
      activity: { entries: () => [{ at: 1, label: 'restart nginx', command: 'systemctl', code: 0, ms: 12, error: null }] },
      refresh: jest.fn(async () => undefined),
      subscribe: jest.fn(() => () => undefined),
      ...overrides,
    },
  };
}

function fakeCtx(token: string) {
  const res: any = {
    headers: null as any,
    ended: false,
    writeHead(status: number, headers: any) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
    },
    end(body?: string) {
      this.ended = true;
      if (body !== undefined) {
        this.body = body;
      }
    },
    on() {
      return this;
    },
    chunks: [] as string[],
    status: 0,
    body: '',
  };
  const ctx: Ctx = {
    req: { on: () => undefined } as any,
    res,
    params: {},
    query: {},
    token,
    json(status, body) {
      res.status = status;
      res.body = JSON.stringify(body);
    },
    text(status, body) {
      res.status = status;
      res.body = body;
    },
  };
  return { ctx, res };
}

function find(routes: Route<Handler>[], method: string, pathname: string): Handler {
  const match = matchRoute(routes, method, pathname);
  if (!match) {
    throw new Error(`no route for ${method} ${pathname}`);
  }
  return match.handler;
}

describe('buildRoutes', () => {
  let routes: Route<Handler>[];
  let store: Map<string, any>;

  beforeEach(() => {
    store = new Map();
    routes = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 1,
      cancel: () => undefined,
    });
  });

  it('returns the session state and capability flags', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/session')(ctx);

    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.status).toBe('online');
    expect(body.profile.host).toBe('10.0.0.5');
    expect(body.capabilities).toEqual({
      services: false,
      webserver: false,
      logs: false,
      terminal: false,
      database: false,
    });
  });

  it('never exposes the token in any response body', async () => {
    const { session } = fakeSession({}, SECRET_TOKEN);
    store.set(SECRET_TOKEN, session);

    const sessionCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/session')(sessionCtx.ctx);
    expect(sessionCtx.res.body).not.toContain(SECRET_TOKEN);

    const hostCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/host')(hostCtx.ctx);
    expect(hostCtx.res.body).not.toContain(SECRET_TOKEN);

    const activityCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/activity')(activityCtx.ctx);
    expect(activityCtx.res.body).not.toContain(SECRET_TOKEN);
  });

  it('answers 404 when the token maps to no session', async () => {
    const { ctx, res } = fakeCtx('stale');

    await find(routes, 'GET', '/api/session')(ctx);

    expect(res.status).toBe(404);
  });

  it('returns the host state', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/host')(ctx);

    expect(JSON.parse(res.body).facts.hostname).toBe('web1');
  });

  it('runs a refresh and reports ok', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'POST', '/api/host/refresh')(ctx);

    expect(session.refresh).toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('reports a refresh failure as a 500 with the message', async () => {
    const { session } = fakeSession({
      refresh: jest.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      }),
    });
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'POST', '/api/host/refresh')(ctx);

    expect(res.status).toBe(500);
    expect(res.body).toContain('ETIMEDOUT');
  });

  it('returns the activity entries', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/activity')(ctx);

    expect(JSON.parse(res.body).entries.length).toBe(1);
  });

  it('opens an event stream with the right headers and subscribes', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/stream')(ctx);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(session.subscribe).toHaveBeenCalled();
  });

  it('unsubscribes and stops the heartbeat when the client goes away', async () => {
    const unsubscribe = jest.fn();
    const { session } = fakeSession({ subscribe: jest.fn(() => unsubscribe) });
    store.set('tok', session);

    const cancel = jest.fn();
    routes = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 7,
      cancel,
    });

    let closeHandler = () => undefined;
    const { ctx } = fakeCtx('tok');
    (ctx.req as any).on = (event: string, handler: any) => {
      if (event === 'close') {
        closeHandler = handler;
      }
    };

    await find(routes, 'GET', '/api/stream')(ctx);
    closeHandler();

    expect(unsubscribe).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('tolerates the client close event firing twice', async () => {
    const unsubscribe = jest.fn();
    const { session } = fakeSession({ subscribe: jest.fn(() => unsubscribe) });
    store.set('tok', session);

    const cancel = jest.fn();
    routes = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 7,
      cancel,
    });

    let closeHandler = () => undefined;
    const { ctx } = fakeCtx('tok');
    (ctx.req as any).on = (event: string, handler: any) => {
      if (event === 'close') {
        closeHandler = handler;
      }
    };

    await find(routes, 'GET', '/api/stream')(ctx);
    closeHandler();
    closeHandler();

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
