import { buildRoutes } from '../routes';
import { matchRoute } from '../router';

const COLUMNS = [
  { name: 'id', type: 'int(11)', nullable: false, key: 'PRI' },
  { name: 'title', type: 'varchar(255)', nullable: true, key: '' },
];

const DB_PASSWORD = 'DB-PASSWORD-SHOULD-NEVER-APPEAR-4c1f';

function fakeClient(overrides: any = {}) {
  return {
    listTables: async () => ['wp_posts'],
    listColumns: async () => COLUMNS,
    query: async () => ({ columns: ['id', 'title'], rows: [[1, 'hello']], rowCount: 1, affectedRows: 0, durationMs: 3 }),
    ...overrides,
  };
}

function fakeSession(client: any = fakeClient(), token = 'tok') {
  const pushed: any[] = [];
  return {
    pushed,
    session: {
      id: 'abc',
      token,
      profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy', privilegedAs: 'deploy' },
      transport: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
      privilegedTransport: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
      activity: { entries: () => [], push: (e: any) => pushed.push(e) },
      db: {
        list: () => [{ id: 'db0', name: 'shop', label: 'shop' }],
        config: (id: string) => (id === 'db0' ? { username: 'u', password: DB_PASSWORD, name: 'shop' } : null),
        client: (id: string) => (id === 'db0' ? client : null),
        tables: async (id: string) => (id === 'db0' ? client.listTables() : Promise.reject(new Error('no'))),
        columns: async (id: string, t: string) => (id === 'db0' ? client.listColumns(t) : Promise.reject(new Error('no'))),
      },
    },
  };
}

// Reuse the fakeCtx shape from routes-test.ts: it records status, json body and
// text body, and exposes params/query/body.
function fakeCtx(token: string, opts: any = {}) {
  const ctx: any = {
    token,
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body,
    status: 0,
    payload: null as any,
    text(status: number, message: string) {
      this.status = status;
      this.payload = message;
    },
    json(status: number, value: any) {
      this.status = status;
      this.payload = value;
    },
    req: { on: () => undefined },
    res: { writeHead: () => undefined, write: () => true, end: () => undefined },
  };
  return ctx;
}

function run(routes: any[], method: string, path: string, ctx: any) {
  const matched = matchRoute(routes, method, path);
  expect(matched).toBeTruthy();
  ctx.params = matched!.params;
  return matched!.handler(ctx);
}

function build(session: any) {
  return buildRoutes({
    sessions: { get: (t: string) => (t === session.token ? session : undefined) },
    pingMs: 1000,
    schedule: () => 1,
    cancel: () => undefined,
  }).routes;
}

describe('GET /api/db', () => {
  it('lists the configured databases', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok');
    await run(build(session), 'GET', '/api/db', ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.payload.databases).toEqual([{ id: 'db0', name: 'shop', label: 'shop' }]);
  });

  it('404s when the session is gone', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('other');
    await run(build(session), 'GET', '/api/db', ctx);
    expect(ctx.status).toBe(404);
  });
});

describe('GET /api/db/:id/tables', () => {
  it('returns the table list', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok');
    await run(build(session), 'GET', '/api/db/db0/tables', ctx);
    expect(ctx.payload.tables).toEqual(['wp_posts']);
  });

  it('404s for a database this profile does not have', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok');
    await run(build(session), 'GET', '/api/db/db9/tables', ctx);
    expect(ctx.status).toBe(404);
  });
});

describe('GET /api/db/:id/tables/:table/columns', () => {
  it('returns the column metadata', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok');
    await run(build(session), 'GET', '/api/db/db0/tables/wp_posts/columns', ctx);
    expect(ctx.payload.columns).toEqual(COLUMNS);
  });

  // Global Constraint 2.
  it('400s for a table the live listing does not contain', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok');
    await run(build(session), 'GET', '/api/db/db0/tables/wp_secrets/columns', ctx);
    expect(ctx.status).toBe(400);
  });
});

describe('POST /api/db/:id/tables/:table/rows', () => {
  it('returns rows, columns and a total', async () => {
    const client = fakeClient({
      query: async (sql: string) =>
        /COUNT/.test(sql)
          ? { columns: ['n'], rows: [[7]], rowCount: 1, affectedRows: 0, durationMs: 1 }
          : { columns: ['id', 'title'], rows: [[1, 'hello']], rowCount: 1, affectedRows: 0, durationMs: 3 },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { limit: 10, offset: 0 } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/rows', ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.payload.rows).toEqual([[1, 'hello']]);
    expect(ctx.payload.total).toBe(7);
  });

  it('400s on a limit that is not a whole number', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { limit: '5; DROP TABLE x' } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/rows', ctx);
    expect(ctx.status).toBe(400);
  });

  // Global Constraint 1: the single most important assertion in this file.
  it('never puts the database password in the activity log', async () => {
    const { session, pushed } = fakeSession();
    const ctx = fakeCtx('tok', { body: {} });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/rows', ctx);
    expect(pushed.length).toBeGreaterThan(0);
    expect(JSON.stringify(pushed)).not.toContain(DB_PASSWORD);
  });

  it('logs a description rather than a built command', async () => {
    const { session, pushed } = fakeSession();
    const ctx = fakeCtx('tok', { body: {} });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/rows', ctx);
    expect(pushed[0].command).not.toContain('MYSQL_PWD');
    expect(pushed[0].command).toContain('wp_posts');
  });

  it('reports a driver failure as a 500 with its message', async () => {
    const client = fakeClient({
      query: async () => {
        throw new Error('ER_NO_SUCH_TABLE');
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: {} });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/rows', ctx);
    expect(ctx.status).toBe(500);
    expect(String(ctx.payload)).toContain('ER_NO_SUCH_TABLE');
  });
});
