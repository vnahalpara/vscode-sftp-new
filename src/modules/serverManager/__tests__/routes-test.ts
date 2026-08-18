import { buildRoutes } from '../routes';
import { matchRoute, Route } from '../router';
import { Ctx, Handler } from '../httpServer';

// Distinctive on purpose: a three-letter needle like 'tok' could pass even
// against a leaky implementation, which would make the assertion worthless.
const SECRET_TOKEN = 'TOKEN-SHOULD-NEVER-APPEAR-8f3a9c2b';

type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>;

const noopExec: ExecFn = async () => ({ stdout: '', stderr: '', code: 0 });

// A fake ManagedSession. `privilegedTransport` backs routes.ts's
// opsFor(session) via session.privilegedTransport.exec(cmd) -- the real
// accessor added to ManagedSession in session.ts -- so a test's `exec` fake
// is the thing that proves a route actually reached the session's privileged
// exec channel, not just that it returned a response. `transport` (the
// unprivileged metrics lane) is included for parity with the real
// ManagedSession shape but nothing under routes.ts reads it.
function fakeSession(overrides: any = {}, token: string = 'tok') {
  const written: string[] = [];
  return {
    written,
    session: {
      id: 'abc',
      token,
      profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', privilegedAs: 'deploy' },
      transport: { exec: noopExec },
      privilegedTransport: { exec: noopExec },
      state: () => ({
        id: 'abc',
        profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', privilegedAs: 'deploy' },
        status: 'online',
        error: null,
        facts: { hostname: 'web1', linux: true },
        interval: 2000,
        lastSeen: 99,
      }),
      activity: {
        entries: () => [{ at: 1, label: 'restart nginx', command: 'systemctl', code: 0, ms: 12, error: null }],
        push: jest.fn(),
      },
      refresh: jest.fn(async () => undefined),
      subscribe: jest.fn(() => () => undefined),
      ...overrides,
    },
  };
}

function fakeCtx(token: string, query: any = {}) {
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

function withParams(ctx: Ctx, params: { [k: string]: string }): Ctx {
  return { ...ctx, params };
}

const SERVICES_OUTPUT = [
  '@@units',
  'nginx.service                loaded active   running A web server',
  'mysql.service                loaded failed   failed  A database',
  '@@files',
  'nginx.service enabled',
  'mysql.service disabled',
].join('\n');

const DETECT_OUTPUT = [
  '@@nginx',
  'nginx version: nginx/1.18.0',
  '@@apache_bin',
  '',
  '@@apache',
  '',
  '@@active',
  'nginx|active|enabled',
  '@@ports',
  'LISTEN 0 511 *:80 *:* users:(("nginx",pid=1,fd=6))',
].join('\n');

const NGINX_CONF = ['server {', '    listen 80;', '    server_name example.com;', '    root /var/www/example;', '}'].join(
  '\n'
);
const NGINX_FILE = '/etc/nginx/sites-enabled/example.conf';
const VHOSTS_OUTPUT = [`@@${NGINX_FILE}`, NGINX_CONF].join('\n');

// A real, ordinary config file whose CONTENT contains a line beginning
// `@@` — trivially arrangeable by anyone who can write a vhost file (an
// nginx comment, a log format string, a stray heredoc). configFilesCommand
// `cat`s the file into the very stream its `@@` markers travel in, so
// splitAt cannot tell this line apart from a marker the command itself
// emitted, and `/etc/shadow` becomes a section key.
const FORGED_PATH = '/etc/shadow';
const NGINX_FORGED_CONF = [
  'server {',
  '    listen 80;',
  '    server_name forged.example.com;',
  `# @@ marker forgery follows`,
  `@@${FORGED_PATH}`,
  'root:$6$whatever:19000:0:99999:7:::',
].join('\n');
const VHOSTS_FORGED_OUTPUT = [`@@${NGINX_FILE}`, NGINX_FORGED_CONF].join('\n');

const NGINX_SSL_FILE = '/etc/nginx/sites-enabled/ssl.conf';
const NGINX_SSL_CONF = [
  'server {',
  '    listen 443 ssl;',
  '    server_name secure.example.com;',
  '    ssl_certificate /etc/ssl/certs/secure.pem;',
  '}',
].join('\n');
const VHOSTS_SSL_OUTPUT = [`@@${NGINX_SSL_FILE}`, NGINX_SSL_CONF].join('\n');

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
      services: true,
      webserver: true,
      logs: false,
      terminal: false,
      database: false,
    });
  });

  it('never exposes the token in any response body', async () => {
    const exec: ExecFn = async cmd => {
      if (cmd.indexOf('systemctl list-units') !== -1) {
        return { stdout: SERVICES_OUTPUT, stderr: '', code: 0 };
      }
      if (cmd.indexOf('sites-enabled') !== -1) {
        return { stdout: VHOSTS_OUTPUT, stderr: '', code: 0 };
      }
      return { stdout: DETECT_OUTPUT, stderr: '', code: 0 };
    };
    const { session } = fakeSession({ privilegedTransport: { exec } }, SECRET_TOKEN);
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

    const servicesCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/services')(servicesCtx.ctx);
    expect(servicesCtx.res.body).not.toContain(SECRET_TOKEN);

    const webserverCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/webserver')(webserverCtx.ctx);
    expect(webserverCtx.res.body).not.toContain(SECRET_TOKEN);

    const vhostsCtx = fakeCtx(SECRET_TOKEN);
    await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(vhostsCtx.ctx, { kind: 'nginx' }));
    expect(vhostsCtx.res.body).not.toContain(SECRET_TOKEN);
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

  describe('services', () => {
    it('lists services parsed, merged and sorted, and drives the command through the session privileged transport', async () => {
      const exec = jest.fn(async (_cmd: string) => ({ stdout: SERVICES_OUTPUT, stderr: '', code: 0 }));
      const { session } = fakeSession({ privilegedTransport: { exec } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/services')(ctx);

      // Proves the route actually reached this session's privileged transport,
      // not just that it produced a 200 -- a fake transport that was never called
      // would still let a stub response through.
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][0]).toContain('systemctl list-units');

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.services.map((s: any) => s.unit)).toEqual(['nginx.service', 'mysql.service']);
      expect(body.services[1].active).toBe('failed');
      expect(body.services[0].enabled).toBe('enabled');
    });

    it('runs a service action and reports ok with output', async () => {
      const { session } = fakeSession({
        privilegedTransport: { exec: async () => ({ stdout: 'Restarting...', stderr: '', code: 0 }) },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/services/:unit/:action')(
        withParams(ctx, { unit: 'nginx.service', action: 'restart' })
      );

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, output: 'Restarting...' });
    });

    it('reports a failed action inline as ok:false rather than a 500', async () => {
      const { session } = fakeSession({
        privilegedTransport: { exec: async () => ({ stdout: '', stderr: 'sudo: a password is required', code: 1 }) },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/services/:unit/:action')(
        withParams(ctx, { unit: 'nginx.service', action: 'restart' })
      );

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.output).toContain('NOPASSWD');
      expect(body.output).toContain('deploy@10.0.0.5');
    });

    it('names the root lane in the sudo hint when the profile has root credentials, not the session user', async () => {
      // A profile with root_user/root_password runs privileged commands as
      // root, not as the session's own `deploy` user -- so a sudo hint that
      // still named `deploy` would send the operator to grant sudo to the
      // wrong account.
      const { session } = fakeSession({
        profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', privilegedAs: 'root' },
        privilegedTransport: { exec: async () => ({ stdout: '', stderr: 'sudo: a password is required', code: 1 }) },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/services/:unit/:action')(
        withParams(ctx, { unit: 'nginx.service', action: 'restart' })
      );

      const body = JSON.parse(res.body);
      expect(body.output).toContain('root@10.0.0.5');
      expect(body.output).not.toContain('deploy@10.0.0.5');
    });

    it('rejects an unknown action with 400, not 500', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/services/:unit/:action')(
        withParams(ctx, { unit: 'nginx.service', action: 'nuke' })
      );

      expect(res.status).toBe(400);
    });

    it('rejects an unsafe unit name with 400, not 500', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/services/:unit/:action')(
        withParams(ctx, { unit: '-Hroot@evil', action: 'restart' })
      );

      expect(res.status).toBe(400);
    });

    it('returns raw status output regardless of exit code', async () => {
      const { session } = fakeSession({
        privilegedTransport: {
          exec: async () => ({
            stdout: '● nginx.service - A web server\n   Active: active (running)',
            stderr: '',
            code: 0,
          }),
        },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/services/:unit/status')(withParams(ctx, { unit: 'nginx.service' }));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).output).toContain('Active: active');
    });

    it('rejects an unsafe unit name on the status route with 400', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/services/:unit/status')(withParams(ctx, { unit: '-Hroot@evil' }));

      expect(res.status).toBe(400);
    });
  });

  describe('web server', () => {
    it('detects installed web servers', async () => {
      const { session } = fakeSession({ privilegedTransport: { exec: async () => ({ stdout: DETECT_OUTPUT, stderr: '', code: 0 }) } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/webserver')(ctx);

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.servers[0].kind).toBe('nginx');
      expect(body.listening.length).toBe(1);
    });

    it('rejects an unknown kind on /webserver/:kind/vhosts with 400', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(ctx, { kind: 'iis' }));

      expect(res.status).toBe(400);
    });

    it('rejects an unknown kind on /webserver/:kind/test with 400', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/webserver/:kind/test')(withParams(ctx, { kind: 'iis' }));

      expect(res.status).toBe(400);
    });

    it('lists vhosts with no certificates and caches the config path for /api/file', async () => {
      const { session } = fakeSession({ privilegedTransport: { exec: async () => ({ stdout: VHOSTS_OUTPUT, stderr: '', code: 0 }) } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(ctx, { kind: 'nginx' }));

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.vhosts[0].serverName).toBe('example.com');
      expect(body.certificates).toEqual([]);
      expect(body.skipped).toEqual([]);

      const fileCtx = fakeCtx('tok', { path: NGINX_FILE });
      await find(routes, 'GET', '/api/file')(fileCtx.ctx);
      expect(fileCtx.res.status).toBe(200);
    });

    it('inspects certificates referenced by vhosts', async () => {
      const certBody = ['notAfter=Dec 31 23:59:59 2030 GMT', 'subject=CN=secure.example.com', 'issuer=CN=Test CA'].join(
        '\n'
      );
      const certOutput = ['@@/etc/ssl/certs/secure.pem', certBody].join('\n');
      const exec: ExecFn = async cmd => {
        if (cmd.indexOf('openssl') !== -1) {
          return { stdout: certOutput, stderr: '', code: 0 };
        }
        return { stdout: VHOSTS_SSL_OUTPUT, stderr: '', code: 0 };
      };
      const { session } = fakeSession({ privilegedTransport: { exec } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(ctx, { kind: 'nginx' }));

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.certificates.length).toBe(1);
      expect(body.certificates[0].path).toBe('/etc/ssl/certs/secure.pem');
      expect(body.certificates[0].daysLeft).not.toBeNull();
    });

    it('never calls exec with an empty certificate command, and reports the rejected path as skipped', async () => {
      // A raw carriage return inside the ssl_certificate value survives
      // directiveRe (which only excludes \n), so it reaches certInfoCommand
      // and is rejected there for containing a control character -- the
      // only path requested, so certInfoCommand returns command: ''.
      const confWithBadCertPath = [
        'server {',
        '    listen 443 ssl;',
        '    server_name secure.example.com;',
        '    ssl_certificate /etc/ssl/certs/bad\r.pem;',
        '}',
      ].join('\n');
      const output = [`@@${NGINX_SSL_FILE}`, confWithBadCertPath].join('\n');
      const exec = jest.fn(async () => ({ stdout: output, stderr: '', code: 0 }));
      const { session } = fakeSession({ privilegedTransport: { exec } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(ctx, { kind: 'nginx' }));

      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.certificates).toEqual([]);
      expect(body.skipped.length).toBe(1);
      expect(body.skipped[0]).toContain('/etc/ssl/certs/bad');
      // Only the one call for the config files themselves -- never a second
      // call for an empty certificate command.
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it('reports config test success with the real output', async () => {
      const { session } = fakeSession({
        privilegedTransport: { exec: async () => ({ stdout: 'nginx: configuration file test is successful', stderr: '', code: 0 }) },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/webserver/:kind/test')(withParams(ctx, { kind: 'nginx' }));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        output: 'nginx: configuration file test is successful',
      });
    });

    it('reports a real config test failure using stdout, not a generic exit-code message', async () => {
      // testConfigCommand redirects nginx -t's own stderr into stdout, so a
      // genuine failure has empty stderr -- exactly the case runPrivileged's
      // stderr-only error mapping would turn into a useless "command exited
      // with code 1" and lose the diagnostic.
      const diagnostic = 'nginx: [emerg] unexpected "}" in /etc/nginx/nginx.conf:12';
      const { session } = fakeSession({ privilegedTransport: { exec: async () => ({ stdout: diagnostic, stderr: '', code: 1 }) } });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/webserver/:kind/test')(withParams(ctx, { kind: 'nginx' }));

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.output).toBe(diagnostic);
    });

    it('maps a sudo failure on config test to the sudo hint', async () => {
      const { session } = fakeSession({
        privilegedTransport: { exec: async () => ({ stdout: '', stderr: 'sudo: a password is required', code: 1 }) },
      });
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok');

      await find(routes, 'POST', '/api/webserver/:kind/test')(withParams(ctx, { kind: 'nginx' }));

      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.output).toContain('NOPASSWD');
    });
  });

  describe('/api/file', () => {
    it('rejects a path never returned by a vhost listing for this session', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok', { path: '/etc/passwd' });

      await find(routes, 'GET', '/api/file')(ctx);

      expect(res.status).toBe(403);
    });

    it('rejects a missing path query', async () => {
      const { session } = fakeSession();
      store.set('tok', session);
      const { ctx, res } = fakeCtx('tok', {});

      await find(routes, 'GET', '/api/file')(ctx);

      expect(res.status).toBe(403);
    });

    it('serves a path that a prior vhost listing returned for this session, but not for a different session', async () => {
      const exec: ExecFn = async cmd => {
        if (cmd.indexOf('sed -n') !== -1) {
          return { stdout: NGINX_CONF, stderr: '', code: 0 };
        }
        return { stdout: VHOSTS_OUTPUT, stderr: '', code: 0 };
      };
      const { session } = fakeSession({ privilegedTransport: { exec } });
      store.set('tok', session);

      const { session: otherSession } = fakeSession({}, 'other-tok');
      store.set('other-tok', otherSession);

      const listCtx = fakeCtx('tok');
      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(listCtx.ctx, { kind: 'nginx' }));

      const okCtx = fakeCtx('tok', { path: NGINX_FILE });
      await find(routes, 'GET', '/api/file')(okCtx.ctx);
      expect(okCtx.res.status).toBe(200);
      expect(JSON.parse(okCtx.res.body).content).toBe(NGINX_CONF);

      const otherCtx = fakeCtx('other-tok', { path: NGINX_FILE });
      await find(routes, 'GET', '/api/file')(otherCtx.ctx);
      expect(otherCtx.res.status).toBe(403);
    });

    // The allowlist is seeded from splitAt's section keys, and those keys are
    // parsed out of a stream that also carries the config files' own bytes.
    // Without intersecting them against configFilesCommand's hard-coded
    // globs, a `@@/etc/shadow` line inside any file under those directories
    // put /etc/shadow in the allowlist, and this request returned it.
    it('does not allow a path forged by a config file\'s own CONTENT', async () => {
      const exec: ExecFn = async cmd => {
        if (cmd.indexOf('sed -n') !== -1) {
          return { stdout: 'root:$6$whatever:19000:0:99999:7:::', stderr: '', code: 0 };
        }
        return { stdout: VHOSTS_FORGED_OUTPUT, stderr: '', code: 0 };
      };
      const { session } = fakeSession({ privilegedTransport: { exec } });
      store.set('tok', session);

      const listCtx = fakeCtx('tok');
      await find(routes, 'GET', '/api/webserver/:kind/vhosts')(withParams(listCtx.ctx, { kind: 'nginx' }));
      expect(listCtx.res.status).toBe(200);
      // The forged section must not even surface as a vhost row.
      const listed = JSON.parse(listCtx.res.body).vhosts.map((v: any) => v.file);
      expect(listed).not.toContain(FORGED_PATH);

      const forgedCtx = fakeCtx('tok', { path: FORGED_PATH });
      await find(routes, 'GET', '/api/file')(forgedCtx.ctx);
      expect(forgedCtx.res.status).toBe(403);
      expect(forgedCtx.res.body).not.toContain('root:$6$');

      // The genuine file from the same listing is still readable.
      const okCtx = fakeCtx('tok', { path: NGINX_FILE });
      await find(routes, 'GET', '/api/file')(okCtx.ctx);
      expect(okCtx.res.status).toBe(200);
    });
  });
});
