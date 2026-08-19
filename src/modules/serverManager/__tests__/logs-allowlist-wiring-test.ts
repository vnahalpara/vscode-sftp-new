// The seam between GET /api/logs and /ws/logs, exercised end to end against
// the REAL allowlist rather than an injected predicate.
//
// This file exists because of a specific, shipped defect that every other
// test in this milestone was structurally unable to catch: `/api/logs`
// seeded one allowlist (buildRoutes' token-keyed `allowedFiles`) while
// `/ws/logs` consulted a different, never-written one (a Set on
// ManagedSession). Unit follow worked; FILE follow was refused 100% of the
// time with "That file was not returned by a log discovery scan for this
// session." log-follow-test.ts passed throughout, because each of its cases
// supplies its own `isPathAllowed` -- a fake predicate can only ever prove
// the bridge asks the question, never that anything real answers it.
//
// So the rule for this file: nothing here may inject an allowlist. The only
// legal source of an authorization answer below is the predicate buildRoutes
// itself hands back, seeded only by really running the /api/logs handler.
import { buildRoutes, BuiltRoutes } from '../routes';
import { matchRoute, Route } from '../router';
import { Ctx, Handler } from '../httpServer';
import { bridgeLogFollow, LogStream } from '../logFollow';
import { WsLike } from '../wsBridge';
import { LOG_DISCOVERY_TEXT } from '../__fixtures__/ops';

const DISCOVERED = '/var/log/syslog';
const NEVER_DISCOVERED = '/var/log/never-scanned.log';

class FakeEmitter {
  private _listeners: { [event: string]: Array<(...args: any[]) => void> } = {};
  on(event: string, cb: (...args: any[]) => void): void {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
  }
  emit(event: string, ...args: any[]): void {
    (this._listeners[event] || []).slice().forEach(cb => cb(...args));
  }
}

class FakeSocket extends FakeEmitter implements WsLike {
  sent: Array<string | Buffer> = [];
  closed = false;
  terminated = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  bufferedAmount = 0;
  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    if (cb) {
      cb();
    }
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  terminate(): void {
    this.terminated = true;
  }
}

class FakeStream extends FakeEmitter implements LogStream {
  ended = false;
  closed = false;
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }
  pause(): void {
    return undefined;
  }
  resume(): void {
    return undefined;
  }
}

// A ManagedSession stand-in carrying only what the /api/logs handler
// touches. Deliberately has NO allowlist of its own: if a future change
// reintroduces one, these tests keep asserting against the routes-layer
// answer, which is the only one /ws/logs is allowed to consult.
function fakeSession(token: string, stdout: string = LOG_DISCOVERY_TEXT) {
  return {
    id: 'abc',
    token,
    profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', privilegedAs: 'deploy' },
    transport: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
    privilegedTransport: { exec: async () => ({ stdout, stderr: '', code: 0 }) },
    activity: { entries: () => [], push: () => undefined },
  } as any;
}

function fakeCtx(token: string, query: any = {}): { ctx: Ctx; res: any } {
  const res: any = { status: 0, body: '' };
  const ctx: Ctx = {
    req: { on: () => undefined } as any,
    res,
    params: {},
    query,
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

function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

// Opens a follow exactly the way index.ts's onLogs does: the ONLY
// authorization input is built.isLogPathAllowed, closed over this socket's
// own token.
async function follow(
  built: BuiltRoutes,
  token: string,
  path: string
): Promise<{ socket: FakeSocket; stream: FakeStream; execStream: jest.Mock }> {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const execStream = jest.fn(async () => stream as LogStream);
  bridgeLogFollow(
    {
      isPathAllowed: p => built.isLogPathAllowed(token, p),
      execStream,
    },
    socket,
    { kind: 'file', path }
  );
  await flush();
  return { socket, stream, execStream };
}

describe('GET /api/logs seeds the allowlist /ws/logs actually authorizes against', () => {
  let built: BuiltRoutes;
  let store: Map<string, any>;
  let listeners: Array<(token: string) => void>;

  beforeEach(() => {
    store = new Map();
    listeners = [];
    built = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 1,
      cancel: () => undefined,
      onTokenDisposed: listener => listeners.push(listener),
    });
    store.set('tok', fakeSession('tok'));
  });

  // THE regression test. Before this fix the socket closed 1011 here every
  // single time, for every user, on every file in the Logs tab.
  it('follows a file the discovery scan returned for this session', async () => {
    const { ctx, res } = fakeCtx('tok');
    await find(built.routes, 'GET', '/api/logs')(ctx);
    expect(JSON.parse(res.body).files.map((f: any) => f.path)).toContain(DISCOVERED);

    const { socket, execStream } = await follow(built, 'tok', DISCOVERED);

    expect(execStream).toHaveBeenCalledTimes(1);
    expect(execStream.mock.calls[0][0]).toContain('tail');
    expect(execStream.mock.calls[0][0]).toContain(DISCOVERED);
    expect(socket.closed).toBe(false);
  });

  it('streams the followed file to the socket', async () => {
    await find(built.routes, 'GET', '/api/logs')(fakeCtx('tok').ctx);
    const { socket, stream } = await follow(built, 'tok', DISCOVERED);

    stream.emit('data', Buffer.from('Aug 19 00:00:01 web1 sshd[1]: ok\n'));

    expect(socket.sent).toEqual([Buffer.from('Aug 19 00:00:01 web1 sshd[1]: ok\n')]);
  });

  // Fails closed before discovery has run at all: holding a valid session
  // token is not, on its own, permission to read a file under /var/log.
  it('refuses a follow when no discovery scan has run for this session yet', async () => {
    const { socket, execStream } = await follow(built, 'tok', DISCOVERED);

    expect(execStream).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
  });

  it('refuses a well-formed /var/log path the scan never returned', async () => {
    await find(built.routes, 'GET', '/api/logs')(fakeCtx('tok').ctx);

    const { socket, execStream } = await follow(built, 'tok', NEVER_DISCOVERED);

    expect(execStream).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1011);
  });

  it('is per-session: session As discovery does not authorize session Bs socket', async () => {
    store.set('other-tok', fakeSession('other-tok'));
    await find(built.routes, 'GET', '/api/logs')(fakeCtx('tok').ctx);

    const { socket, execStream } = await follow(built, 'other-tok', DISCOVERED);

    expect(execStream).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1011);
  });

  // allowedFiles is shared with /api/file, which a vhost listing also seeds
  // with /etc config paths. A log follow must never be able to `tail -F`
  // one of those just because the Web server tab was opened first.
  it('does not authorize a config path that only a vhost listing surfaced', async () => {
    const conf = '/etc/nginx/sites-enabled/example.conf';
    store.set('vh', {
      ...fakeSession('vh'),
      token: 'vh',
      privilegedTransport: {
        exec: async (cmd: string) => ({
          stdout: cmd.indexOf('openssl') === -1 ? `@@${conf}\nserver { listen 80; }\n` : '',
          stderr: '',
          code: 0,
        }),
      },
    });
    const { ctx } = fakeCtx('vh');
    await find(built.routes, 'GET', '/api/webserver/:kind/vhosts')({ ...ctx, params: { kind: 'nginx' } });

    // Seeded for /api/file...
    const fileCtx = fakeCtx('vh', { path: conf });
    await find(built.routes, 'GET', '/api/file')(fileCtx.ctx);
    expect(fileCtx.res.status).toBe(200);

    // ...but never followable.
    expect(built.isLogPathAllowed('vh', conf)).toBe(false);
    const { socket, execStream } = await follow(built, 'vh', conf);
    expect(execStream).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1011);
  });

  // One allowlist means one prune. The session-scoped copy this replaced was
  // never pruned at all.
  it('stops authorizing follows once the token is disposed', async () => {
    await find(built.routes, 'GET', '/api/logs')(fakeCtx('tok').ctx);
    expect(built.isLogPathAllowed('tok', DISCOVERED)).toBe(true);

    expect(listeners.length).toBe(1);
    listeners[0]('tok');

    const { socket, execStream } = await follow(built, 'tok', DISCOVERED);
    expect(execStream).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1011);
  });
});
