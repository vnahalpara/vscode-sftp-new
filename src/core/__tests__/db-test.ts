import { splitStatements, applyDefaultLimit, isMutating, hasWhere } from '../dbSql';
import { quoteId, buildTableSearchSql } from '../dbSearch';
import { buildMysqlCommand, parseMysqlBatch, shellSingle } from '../dbExec';
import { buildWhere, buildOrderBy, buildSelect, buildCount, buildUpdate } from '../dbQuery';
import { DbClient } from '../dbClient';

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
});
