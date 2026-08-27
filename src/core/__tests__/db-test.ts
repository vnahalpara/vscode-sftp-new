// This must run before ANY import below triggers dbClient.ts's own
// `require('mysql2/promise')` -- this file's Jest preprocessor is a plain
// `tsc.transpile` per-file pass with no babel-jest-hoist step, so
// `jest.mock()` calls are NOT hoisted above imports the way they would be
// under babel-jest; it has to be textually first. Only the
// stream-transport-bypass test below needs this; every other test in this
// file forces the exec transport by making openForwardStream throw, so
// createConnection is simply never called for them.
jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
}));

import { splitStatements, applyDefaultLimit, isMutating, hasWhere, stripLiterals } from '../dbSql';
import { quoteId, buildTableSearchSql } from '../dbSearch';
import { buildMysqlCommand, buildTableDumpCommand, parseMysqlBatch, shellSingle, sqlLiteral } from '../dbExec';
import { buildWhere, buildOrderBy, buildSelect, buildCount, buildUpdate, buildDelete } from '../dbQuery';
import { DbClient } from '../dbClient';
import { createDbExecLimit } from '../dbExecLimit';
import * as mysql from 'mysql2/promise';

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('ignores semicolons inside strings', () => {
    expect(splitStatements(`SELECT ';' AS a; SELECT 2`)).toEqual([`SELECT ';' AS a`, 'SELECT 2']);
  });
  it('ignores semicolons in line comments', () => {
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2')).toEqual(['SELECT 1 -- a;b', 'SELECT 2']);
  });
  it('ignores semicolons in block comments', () => {
    expect(splitStatements('SELECT 1 /* a;b */; SELECT 2')).toEqual(['SELECT 1 /* a;b */', 'SELECT 2']);
  });
  it('keeps a single statement with no trailing semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });
});

describe('applyDefaultLimit', () => {
  it('adds LIMIT to a bare SELECT', () => {
    expect(applyDefaultLimit('SELECT * FROM t', 500)).toBe('SELECT * FROM t LIMIT 500');
  });
  it('leaves an existing LIMIT alone', () => {
    expect(applyDefaultLimit('SELECT * FROM t LIMIT 10', 500)).toBe('SELECT * FROM t LIMIT 10');
  });
  it('leaves non-SELECT alone', () => {
    expect(applyDefaultLimit('UPDATE t SET a=1', 500)).toBe('UPDATE t SET a=1');
  });
  it('leaves SELECT ... INTO alone', () => {
    expect(applyDefaultLimit('SELECT * INTO x FROM t', 500)).toBe('SELECT * INTO x FROM t');
  });
});

describe('mutation guards', () => {
  it('detects mutating statements', () => {
    expect(isMutating('DELETE FROM t')).toBe(true);
    expect(isMutating('SELECT 1')).toBe(false);
  });
  it('detects WHERE clauses', () => {
    expect(hasWhere('DELETE FROM t WHERE id=1')).toBe(true);
    expect(hasWhere('DELETE FROM t')).toBe(false);
  });
});

describe('stripLiterals', () => {
  it('blanks a block comment\'s contents but keeps the /* */ markers', () => {
    const out = stripLiterals('DELETE FROM users /* where did these come from */');
    expect(out).toBe('DELETE FROM users /*                           */');
    expect(out.length).toBe('DELETE FROM users /* where did these come from */'.length);
  });
  it('blanks a line comment\'s contents but keeps the -- marker', () => {
    const out = stripLiterals('DELETE FROM users -- where');
    expect(out).toBe('DELETE FROM users --      ');
    expect(out.length).toBe('DELETE FROM users -- where'.length);
  });
  it('blanks a string literal\'s contents but keeps the quotes', () => {
    const out = stripLiterals("INSERT INTO log (msg) VALUES ('where')");
    expect(out).toBe("INSERT INTO log (msg) VALUES ('     ')");
  });
  it('preserves a WHERE that follows a string containing a doubled-quote escape', () => {
    const out = stripLiterals("UPDATE t SET a = 'x' WHERE name = 'O''Brien'");
    expect(out).toBe("UPDATE t SET a = ' ' WHERE name = '        '");
    expect(out.length).toBe("UPDATE t SET a = 'x' WHERE name = 'O''Brien'".length);
  });
  it('blanks a WHERE sitting inside an unclosed block comment', () => {
    const out = stripLiterals('SELECT 1 /* where');
    expect(out).toBe('SELECT 1 /*      ');
  });
  it('blanks a backtick-quoted identifier literally named `where`', () => {
    const out = stripLiterals('SELECT * FROM `where`');
    expect(out).toBe('SELECT * FROM `     `');
  });
  it('leaves plain code untouched', () => {
    expect(stripLiterals('DELETE FROM t WHERE id = 1')).toBe('DELETE FROM t WHERE id = 1');
  });
});

describe('hasWhere (hardened against quotes and comments)', () => {
  it('is not fooled by "where" inside a block comment', () => {
    expect(hasWhere('DELETE FROM users /* where did these come from */')).toBe(false);
  });
  it('is not fooled by "where" inside a line comment', () => {
    expect(hasWhere('DELETE FROM users -- where')).toBe(false);
  });
  it('is not fooled by "where" inside a string literal', () => {
    expect(hasWhere("INSERT INTO log (msg) VALUES ('where')")).toBe(false);
  });
  it('still detects a real WHERE clause', () => {
    expect(hasWhere('DELETE FROM t WHERE id = 1')).toBe(true);
  });
  it('still detects a WHERE that follows a string containing a quote', () => {
    expect(hasWhere("UPDATE t SET a = 'x' WHERE name = 'O''Brien'")).toBe(true);
  });
  it('is not fooled by "where" inside an unclosed block comment', () => {
    expect(hasWhere('SELECT 1 /* where')).toBe(false);
  });
  it('is not fooled by a backtick-quoted identifier literally named `where`', () => {
    expect(hasWhere('SELECT * FROM `where`')).toBe(false);
  });
});

describe('search SQL builder', () => {
  it('quotes identifiers and escapes backticks', () => {
    expect(quoteId('a`b')).toBe('`a``b`');
  });
  it('builds a per-table LIKE query', () => {
    expect(buildTableSearchSql('wp_posts', ['post_title', 'post_content'], 50)).toBe(
      'SELECT `post_title`, `post_content` FROM `wp_posts` WHERE `post_title` LIKE ? OR `post_content` LIKE ? LIMIT 50'
    );
  });
});

describe('exec transport (mysql CLI)', () => {
  it('escapes single quotes for the shell', () => {
    expect(shellSingle(`a'b`)).toBe(`'a'\\''b'`);
  });
  it('builds a mysql command with password via MYSQL_PWD', () => {
    const cmd = buildMysqlCommand({ host: 'localhost', username: 'u', password: 'p', name: 'db' });
    expect(cmd).toBe(
      `MYSQL_PWD='p' mysql --user='u' --host='localhost' --batch --default-character-set=utf8mb4 'db'`
    );
  });
  it('parses TSV batch output with headers, NULLs and escapes', () => {
    const out = 'id\tname\n1\tAlice\n2\tNULL\n3\ttab\\there';
    expect(parseMysqlBatch(out)).toEqual({
      columns: ['id', 'name'],
      rows: [['1', 'Alice'], ['2', null], ['3', 'tab\there']],
    });
  });
  it('handles empty output', () => {
    expect(parseMysqlBatch('')).toEqual({ columns: [], rows: [] });
  });
  it('builds a single-table mysqldump command', () => {
    expect(buildTableDumpCommand({ host: 'localhost', username: 'u', password: 'p', name: 'shop' }, 'sales_order')).toBe(
      `MYSQL_PWD='p' mysqldump --user='u' --host='localhost' --single-transaction --quick --no-tablespaces --default-character-set=utf8mb4 'shop' 'sales_order'`
    );
  });
});

describe('data-browser query builder', () => {
  it('builds a column = filter with a param', () => {
    expect(buildWhere({ column: 'parent_id', op: '=', value: '2' }, [])).toEqual({
      sql: '`parent_id` = ?',
      params: ['2'],
    });
  });
  it('wraps LIKE value with wildcards', () => {
    expect(buildWhere({ column: 'name', op: 'LIKE', value: 'abc' }, [])).toEqual({
      sql: '`name` LIKE ?',
      params: ['%abc%'],
    });
  });
  it('builds IS NULL with no params', () => {
    expect(buildWhere({ column: 'x', op: 'IS NULL', value: '' }, [])).toEqual({
      sql: '`x` IS NULL',
      params: [],
    });
  });
  it('builds an "anywhere" OR-LIKE across all columns', () => {
    expect(buildWhere({ column: null, op: 'LIKE', value: 'q' }, ['a', 'b'])).toEqual({
      sql: '(`a` LIKE ? OR `b` LIKE ?)',
      params: ['%q%', '%q%'],
    });
  });
  it('returns null for an empty filter value', () => {
    expect(buildWhere({ column: 'a', op: '=', value: '' }, [])).toBeNull();
  });
  it('builds ORDER BY', () => {
    expect(buildOrderBy({ column: 'created_at', dir: 'DESC' })).toBe(' ORDER BY `created_at` DESC');
    expect(buildOrderBy(null)).toBe('');
  });
  it('builds a paginated SELECT', () => {
    const where = buildWhere({ column: 'id', op: '>', value: '5' }, []);
    expect(buildSelect('wp_posts', { where, orderBy: ' ORDER BY `id` ASC', limit: 30, offset: 60 })).toEqual({
      sql: 'SELECT * FROM `wp_posts` WHERE `id` > ? ORDER BY `id` ASC LIMIT 30 OFFSET 60',
      params: ['5'],
    });
  });
  it('builds COUNT with and without WHERE', () => {
    expect(buildCount('t', null)).toEqual({ sql: 'SELECT COUNT(*) AS n FROM `t`', params: [] });
    expect(buildCount('t', { sql: '`a` = ?', params: ['1'] })).toEqual({
      sql: 'SELECT COUNT(*) AS n FROM `t` WHERE `a` = ?',
      params: ['1'],
    });
  });
});

describe('buildUpdate', () => {
  it('updates changed columns by primary key', () => {
    expect(buildUpdate('wp_posts', { post_title: 'Hi', post_status: 'publish' }, { ID: 42 })).toEqual({
      sql: 'UPDATE `wp_posts` SET `post_title` = ?, `post_status` = ? WHERE `ID` = ?',
      params: ['Hi', 'publish', 42],
    });
  });
  it('adds LIMIT 1 when not using a primary key (full-row match)', () => {
    const r = buildUpdate('t', { a: '1' }, { a: '0', b: 'x' }, true);
    expect(r.sql).toBe('UPDATE `t` SET `a` = ? WHERE `a` = ? AND `b` = ? LIMIT 1');
    expect(r.params).toEqual(['1', '0', 'x']);
  });
  it('uses IS NULL for null where-values (no param)', () => {
    expect(buildUpdate('t', { a: '1' }, { id: 5, note: null })).toEqual({
      sql: 'UPDATE `t` SET `a` = ? WHERE `id` = ? AND `note` IS NULL',
      params: ['1', 5],
    });
  });
});

describe('buildDelete', () => {
  it('deletes by primary key', () => {
    expect(buildDelete('wp_posts', { ID: 42 })).toEqual({
      sql: 'DELETE FROM `wp_posts` WHERE `ID` = ?',
      params: [42],
    });
  });
  it('adds LIMIT 1 for a full-row match (no primary key)', () => {
    const r = buildDelete('t', { a: '0', b: 'x' }, true);
    expect(r.sql).toBe('DELETE FROM `t` WHERE `a` = ? AND `b` = ? LIMIT 1');
    expect(r.params).toEqual(['0', 'x']);
  });
  it('uses IS NULL for null where-values (no param)', () => {
    expect(buildDelete('t', { id: 5, note: null })).toEqual({
      sql: 'DELETE FROM `t` WHERE `id` = ? AND `note` IS NULL',
      params: [5],
    });
  });
});

describe('DbClient auto-reconnect', () => {
  it('drops a dead transport and retries once on a "Not connected" error', async () => {
    let providerCalls = 0;
    let execCalls = 0;
    const provider = async () => {
      providerCalls++;
      return {
        // force the exec transport (no TCP forwarding)
        openForwardStream: async () => {
          throw new Error('open failed');
        },
        exec: async () => {
          execCalls++;
          if (execCalls === 1) {
            throw new Error('Not connected');
          }
          return { stdout: 'n\n1', stderr: '', code: 0 };
        },
      };
    };
    const client = new DbClient({ username: 'u', password: 'p', name: 'db' }, provider);
    const res = await client.query('SELECT 1 AS n');
    expect(res.rows).toEqual([['1']]);
    expect(providerCalls).toBe(2); // reconnected with a fresh ssh client
  });

  // Fix 3: _isConnectionError is fuzzy (it matches a bare `indexOf('closed')`
  // among other things), so it cannot tell "the connection dropped before the
  // server ever saw this statement" from "it dropped after the UPDATE/DELETE/
  // INSERT was already applied, and only the response was lost". Retrying a
  // mutation in the latter case would double-apply it, so query() must not
  // retry ANY mutating statement on a connection error -- only a read (the
  // preceding test) is safe to retry.
  it('does not retry a mutating statement on a connection error, to avoid double-applying it', async () => {
    let providerCalls = 0;
    let execCalls = 0;
    const provider = async () => {
      providerCalls++;
      return {
        openForwardStream: async () => {
          throw new Error('open failed');
        },
        exec: async () => {
          execCalls++;
          throw new Error('Not connected');
        },
      };
    };
    const client = new DbClient({ username: 'u', password: 'p', name: 'db' }, provider);
    await expect(client.query('UPDATE t SET a = 1 WHERE id = 1')).rejects.toThrow('Not connected');
    expect(execCalls).toBe(1); // never retried
    expect(providerCalls).toBe(1); // never reconnected either
  });
});

describe('sqlLiteral', () => {
  it('renders null as the NULL keyword', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
  });

  it('renders a finite number bare', () => {
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(-1.5)).toBe('-1.5');
  });

  // NaN/Infinity are not MySQL literals; emitting them bare would be a syntax
  // error, so they go through the string path like any other value.
  it('does not emit NaN or Infinity as bare numbers', () => {
    expect(sqlLiteral(NaN)).not.toBe('NaN');
    expect(sqlLiteral(Infinity)).not.toBe('Infinity');
  });

  it('renders a string as an introduced hex literal', () => {
    expect(sqlLiteral('ab')).toBe("_utf8mb4 X'6162'");
  });

  // The whole point: under NO_BACKSLASH_ESCAPES a backslash-escaped quote is
  // not an escape at all. A hex literal has no quoting to subvert.
  it('is unaffected by quotes and backslashes in the value', () => {
    const evil = "' OR 1=1 -- \\";
    const out = sqlLiteral(evil);
    expect(out).toBe("_utf8mb4 X'" + Buffer.from(evil, 'utf8').toString('hex') + "'");
    // The only quotes in the output are the two delimiting the hex literal --
    // nothing from the value itself survives as syntax.
    expect(out.split("'")).toHaveLength(3);
  });

  it('renders the empty string as a valid empty hex literal', () => {
    expect(sqlLiteral('')).toBe("_utf8mb4 X''");
  });

  it('renders a Buffer as a binary hex literal with no character-set introducer', () => {
    expect(sqlLiteral(Buffer.from([0x00, 0xff]))).toBe("X'00ff'");
  });

  it('renders a boolean as 1 or 0', () => {
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
  });

  // The motivating case for hex-literal inlining under LIKE: a wildcarded
  // search term must survive as bytes inside the hex payload, with no literal
  // "%" character left in the output for LIKE to (mis)parse as syntax.
  it('renders a LIKE wildcard term as hex bytes, with no literal % in the output', () => {
    const out = sqlLiteral('%term%');
    expect(out).toBe("_utf8mb4 X'" + Buffer.from('%term%', 'utf8').toString('hex') + "'");
    expect(out).not.toContain('%');
  });
});

describe('DbClient exec transport inlining', () => {
  it('inlines parameters as hex literals rather than quoted strings', async () => {
    const seen: string[] = [];
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async (_cmd: string, input?: string) => {
        seen.push(input || '');
        return { stdout: 'a\n1\n', stderr: '', code: 0 };
      },
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any
    );
    await client.query('SELECT * FROM t WHERE c = ?', ["it's"]);
    expect(seen[0]).toContain("_utf8mb4 X'" + Buffer.from("it's", 'utf8').toString('hex') + "'");
    expect(seen[0]).not.toContain("\\'");
  });

  // End-to-end: a LIKE wildcard param must decode back to "%term%" via the hex
  // literal, so LIKE still matches -- this is the regression a wrong-direction
  // encoding of "%" would cause.
  it('inlines a LIKE wildcard parameter as a hex literal that decodes to the wildcarded string', async () => {
    const seen: string[] = [];
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async (_cmd: string, input?: string) => {
        seen.push(input || '');
        return { stdout: 'a\n1\n', stderr: '', code: 0 };
      },
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any
    );
    await client.query('SELECT a FROM t WHERE a LIKE ?', ['%term%']);
    expect(seen[0]).toContain("LIKE _utf8mb4 X'" + Buffer.from('%term%', 'utf8').toString('hex') + "'");
    expect(seen[0]).not.toContain("'%term%'");
  });

  // The real call path: buildTableSearchSql (dbSearch.ts) builds a multi-column
  // OR-LIKE query with one placeholder per column; both must get substituted.
  it('inlines every placeholder from a buildTableSearchSql query with multiple columns', async () => {
    const seen: string[] = [];
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async (_cmd: string, input?: string) => {
        seen.push(input || '');
        return { stdout: 'a\tb\n1\t2\n', stderr: '', code: 0 };
      },
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any
    );
    const sql = buildTableSearchSql('wp_posts', ['post_title', 'post_content'], 50);
    await client.query(sql, ['%t%', '%t%']);
    const hex = "_utf8mb4 X'" + Buffer.from('%t%', 'utf8').toString('hex') + "'";
    expect(seen[0].split(hex).length - 1).toBe(2); // both placeholders substituted
    expect(seen[0]).not.toContain('?');
  });
});

// Fix 2: the mysql-CLI exec transport is capped so it cannot alone exhaust
// OpenSSH's MaxSessions; the forwarded-TCP transport must never be gated by
// the same limiter, since a direct-tcpip channel is not counted by it.
describe('DbClient exec channel cap', () => {
  it('refuses a query once the exec-channel cap is reached, naming the limit', async () => {
    const limit = createDbExecLimit(1);
    let resolveFirst: (() => void) | null = null;
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async () =>
        new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
          resolveFirst = () => resolve({ stdout: 'n\n1', stderr: '', code: 0 });
        }),
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any,
      limit
    );
    const first = client.query('SELECT 1 AS n');
    // Let the first query's _execQuery acquire its slot before the second is issued.
    await new Promise(resolve => setImmediate(resolve));
    await expect(client.query('SELECT 2 AS n')).rejects.toThrow(/limit 1/i);
    resolveFirst!();
    await expect(first).resolves.toMatchObject({ rows: [['1']] });
  });

  it('frees the slot once a query completes, letting the next one through', async () => {
    const limit = createDbExecLimit(1);
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async () => ({ stdout: 'n\n1', stderr: '', code: 0 }),
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any,
      limit
    );
    await client.query('SELECT 1 AS n');
    await expect(client.query('SELECT 2 AS n')).resolves.toMatchObject({ rows: [['1']] });
  });

  it('frees the slot even when the query fails, so the cap cannot leak on error', async () => {
    const limit = createDbExecLimit(1);
    let calls = 0;
    const ssh = {
      openForwardStream: async () => {
        throw new Error('forwarding disabled');
      },
      exec: async () => {
        calls++;
        return { stdout: '', stderr: "ERROR 1146 (42S02): Table doesn't exist", code: 1 };
      },
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any,
      limit
    );
    await expect(client.query('SELECT * FROM nope')).rejects.toThrow();
    await expect(client.query('SELECT * FROM nope')).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('never gates the forwarded-TCP transport, even when the exec cap is exhausted', async () => {
    // A cap of 0 would refuse every single exec-transport query -- proving
    // this passes shows the stream transport never consults the limiter.
    const limit = createDbExecLimit(0);
    const fakeConn = {
      query: jest.fn(async () => [[{ n: 1 }], [{ name: 'n' }]]),
      on: jest.fn(),
      end: jest.fn(async () => undefined),
    };
    (mysql.createConnection as jest.Mock).mockResolvedValue(fakeConn);
    const ssh = {
      openForwardStream: async () => ({}),
      exec: async () => {
        throw new Error('exec transport must not be used on the forwarded-TCP path');
      },
    };
    const client = new DbClient(
      { username: 'u', password: 'p', name: 'db' },
      async () => ssh as any,
      limit
    );
    const res = await client.query('SELECT 1 AS n');
    expect(res.rows).toEqual([[1]]);
  });
});
