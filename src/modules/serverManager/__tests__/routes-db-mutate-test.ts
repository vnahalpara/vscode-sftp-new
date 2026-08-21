import { buildRoutes } from '../routes';
import { matchRoute, Route } from '../router';
import { Handler } from '../httpServer';

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

// Same fakeCtx shape as routes-test.ts / routes-db-test.ts: records status,
// json/text payload, exposes params/query/body.
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

// Route<Handler>[], not any[]: matchRoute is generic, so an `any[]` argument
// infers Route<unknown> and makes `matched.handler` uncallable under tsc --
// which webpack's ts-loader enforces even though ts-jest does not.
function run(routes: Route<Handler>[], method: string, path: string, ctx: any) {
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

describe('POST /api/db/:id/tables/:table/update', () => {
  it('runs a parameterised update and reports affected rows', async () => {
    const seen: any[] = [];
    const client = fakeClient({
      query: async (sql: string, params: any[]) => {
        seen.push({ sql, params });
        return { columns: [], rows: [], rowCount: 0, affectedRows: 1, durationMs: 2 };
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { set: { title: 'new' }, where: { id: 1 }, usingPk: true } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/update', ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.payload.affectedRows).toBe(1);
    expect(seen[seen.length - 1].sql).toContain('UPDATE `wp_posts`');
    expect(seen[seen.length - 1].params).toEqual(['new', 1]);
  });

  it('400s on an empty where rather than rewriting the table', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { set: { title: 'x' }, where: {} } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/update', ctx);
    expect(ctx.status).toBe(400);
  });

  it('400s on a set naming an unknown column', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { set: { nope: 'x' }, where: { id: 1 } } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/update', ctx);
    expect(ctx.status).toBe(400);
  });

  it('never puts the database password in the activity log', async () => {
    const { session, pushed } = fakeSession();
    const ctx = fakeCtx('tok', { body: { set: { title: 'x' }, where: { id: 1 }, usingPk: true } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/update', ctx);
    expect(JSON.stringify(pushed)).not.toContain(DB_PASSWORD);
  });
});

describe('POST /api/db/:id/tables/:table/delete', () => {
  it('runs a parameterised delete', async () => {
    const seen: any[] = [];
    const client = fakeClient({
      query: async (sql: string, params: any[]) => {
        seen.push({ sql, params });
        return { columns: [], rows: [], rowCount: 0, affectedRows: 1, durationMs: 2 };
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { where: { id: 1 }, usingPk: true } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/delete', ctx);
    expect(seen[seen.length - 1].sql).toContain('DELETE FROM `wp_posts`');
  });

  it('400s on an empty where', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { where: {} } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/delete', ctx);
    expect(ctx.status).toBe(400);
  });

  it('adds LIMIT 1 when the row was not identified by a primary key', async () => {
    const seen: any[] = [];
    const client = fakeClient({
      query: async (sql: string) => {
        seen.push(sql);
        return { columns: [], rows: [], rowCount: 0, affectedRows: 1, durationMs: 1 };
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { where: { id: 1, title: 'a' }, usingPk: false } });
    await run(build(session), 'POST', '/api/db/db0/tables/wp_posts/delete', ctx);
    expect(seen[seen.length - 1].endsWith(' LIMIT 1')).toBe(true);
  });
});

describe('POST /api/db/:id/sql', () => {
  it('runs a read and returns one result per statement', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { sql: 'SELECT 1; SELECT 2' } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.payload.results).toHaveLength(2);
  });

  // Global Constraint 5: the gate is enforced here, not in the browser.
  it('refuses a mutation with no confirmation and runs nothing', async () => {
    let ran = 0;
    const client = fakeClient({
      query: async () => {
        ran++;
        return { columns: [], rows: [], rowCount: 0, affectedRows: 0, durationMs: 1 };
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { sql: 'UPDATE wp_posts SET title = 1 WHERE id = 2' } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.payload.needsConfirm).toBe(true);
    expect(ran).toBe(0);
  });

  it('runs a confirmed, filtered mutation', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', {
      body: { sql: 'UPDATE wp_posts SET title = 1 WHERE id = 2', confirm: true },
    });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.payload.needsConfirm).toBeFalsy();
  });

  it('still refuses an unfiltered mutation that carries only the first confirmation', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { sql: 'DELETE FROM wp_posts', confirm: true } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.payload.needsConfirm).toBe(true);
  });

  it('runs an unfiltered mutation once both confirmations are given', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', {
      body: { sql: 'DELETE FROM wp_posts', confirm: true, confirmUnfiltered: true },
    });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.payload.needsConfirm).toBeFalsy();
  });

  it('400s on an empty script', async () => {
    const { session } = fakeSession();
    const ctx = fakeCtx('tok', { body: { sql: '  ' } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.status).toBe(400);
  });

  // A script that fails halfway must report what already ran, not lose it.
  it('reports the error alongside the results that already succeeded', async () => {
    let n = 0;
    const client = fakeClient({
      query: async () => {
        n++;
        if (n === 2) {
          throw new Error('ER_PARSE_ERROR');
        }
        return { columns: ['a'], rows: [[1]], rowCount: 1, affectedRows: 0, durationMs: 1 };
      },
    });
    const { session } = fakeSession(client);
    const ctx = fakeCtx('tok', { body: { sql: 'SELECT 1; SELECT bad; SELECT 3' } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.payload.results).toHaveLength(1);
    expect(ctx.payload.error).toContain('ER_PARSE_ERROR');
  });

  it('never puts the database password in the activity log', async () => {
    const { session, pushed } = fakeSession();
    const ctx = fakeCtx('tok', { body: { sql: 'SELECT 1' } });
    await run(build(session), 'POST', '/api/db/db0/sql', ctx);
    expect(JSON.stringify(pushed)).not.toContain(DB_PASSWORD);
  });
});
