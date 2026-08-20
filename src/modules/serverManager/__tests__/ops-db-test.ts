import {
  BadRequest,
  MAX_PAGE_SIZE,
  MAX_CELL_BYTES,
  requireTable,
  requireColumns,
  parsePaging,
  parseSort,
  parseFilter,
  planRows,
  planUpdate,
  planDelete,
  planSql,
  confirmationNeeded,
  truncateCell,
  truncateRows,
} from '../ops/db';
import { ColumnInfo } from '../../../core/dbClient';

const COLUMNS: ColumnInfo[] = [
  { name: 'id', type: 'int(11)', nullable: false, key: 'PRI' },
  { name: 'title', type: 'varchar(255)', nullable: true, key: '' },
  { name: 'body', type: 'longtext', nullable: true, key: '' },
];

describe('requireTable', () => {
  it('returns the table when the live listing contains it', () => {
    expect(requireTable('wp_posts', ['wp_posts', 'wp_users'])).toBe('wp_posts');
  });

  // Constraint 2: the allowlist is the live listTables() answer, so a name that
  // merely LOOKS like an identifier is still refused.
  it('rejects a table the live listing does not contain', () => {
    expect(() => requireTable('wp_secrets', ['wp_posts'])).toThrow(BadRequest);
  });

  it('rejects an empty table name', () => {
    expect(() => requireTable('', ['wp_posts'])).toThrow(BadRequest);
  });
});

describe('requireColumns', () => {
  it('accepts names that are all real columns', () => {
    expect(() => requireColumns(['id', 'title'], COLUMNS)).not.toThrow();
  });

  it('rejects a name that is not a column', () => {
    expect(() => requireColumns(['id', 'nope'], COLUMNS)).toThrow(BadRequest);
  });

  // A backtick is correctly escaped by quoteId, but an identifier carrying one
  // still cannot be a real column here, so it must never reach the builder.
  it('rejects a backtick-bearing name', () => {
    expect(() => requireColumns(['id`'], COLUMNS)).toThrow(BadRequest);
  });
});

describe('parsePaging', () => {
  it('defaults to page size 50 at offset 0', () => {
    expect(parsePaging({})).toEqual({ limit: 50, offset: 0 });
  });

  it('caps limit at MAX_PAGE_SIZE', () => {
    expect(parsePaging({ limit: 100000 }).limit).toBe(MAX_PAGE_SIZE);
  });

  // Constraint 3: these are spliced into the SQL text, so a string that is not a
  // number must never survive.
  it('rejects a non-numeric limit', () => {
    expect(() => parsePaging({ limit: '5; DROP TABLE x' })).toThrow(BadRequest);
  });

  it('rejects a negative offset', () => {
    expect(() => parsePaging({ offset: -1 })).toThrow(BadRequest);
  });

  it('rejects a fractional limit', () => {
    expect(() => parsePaging({ limit: 2.5 })).toThrow(BadRequest);
  });

  // Constraint 5 [finding]: only a number or a plain-digit string is a whole
  // number here -- not whatever `Number(...)` happens to coerce.
  it('rejects a boolean limit', () => {
    expect(() => parsePaging({ limit: true })).toThrow(BadRequest);
  });

  it('rejects an array limit', () => {
    expect(() => parsePaging({ limit: [10] })).toThrow(BadRequest);
  });

  it('rejects an object limit', () => {
    expect(() => parsePaging({ limit: { value: 10 } })).toThrow(BadRequest);
  });

  it('rejects a hex-string limit rather than reinterpreting it', () => {
    expect(() => parsePaging({ limit: '0x10' })).toThrow(BadRequest);
  });

  it('rejects an exponential-notation limit rather than reinterpreting it', () => {
    expect(() => parsePaging({ limit: '1e3' })).toThrow(BadRequest);
  });
});

describe('parseSort', () => {
  it('returns null when no sort is asked for', () => {
    expect(parseSort({}, COLUMNS)).toBeNull();
  });

  it('normalises the direction to ASC when it is not DESC', () => {
    expect(parseSort({ sort: { column: 'id', dir: 'sideways' } }, COLUMNS)).toEqual({
      column: 'id',
      dir: 'ASC',
    });
  });

  it('rejects sorting by a column that does not exist', () => {
    expect(() => parseSort({ sort: { column: 'nope', dir: 'ASC' } }, COLUMNS)).toThrow(BadRequest);
  });
});

describe('parseFilter', () => {
  it('returns null when no filter is asked for', () => {
    expect(parseFilter({}, COLUMNS)).toBeNull();
  });

  it('allows a null column, meaning "anywhere"', () => {
    expect(parseFilter({ filter: { column: null, op: 'LIKE', value: 'x' } }, COLUMNS)).toEqual({
      column: null,
      op: 'LIKE',
      value: 'x',
    });
  });

  it('rejects an operator outside FILTER_OPS', () => {
    expect(() =>
      parseFilter({ filter: { column: 'id', op: 'UNION SELECT', value: '1' } }, COLUMNS)
    ).toThrow(BadRequest);
  });

  it('rejects a filter on a column that does not exist', () => {
    expect(() => parseFilter({ filter: { column: 'nope', op: '=', value: '1' } }, COLUMNS)).toThrow(
      BadRequest
    );
  });
});

describe('planRows', () => {
  it('builds a parameterised select and a matching count', () => {
    const plan = planRows('wp_posts', COLUMNS, {
      sort: { column: 'id', dir: 'DESC' },
      filter: { column: 'title', op: 'LIKE', value: 'hello' },
      limit: 10,
      offset: 20,
    });
    expect(plan.select.sql).toBe(
      'SELECT * FROM `wp_posts` WHERE `title` LIKE ? ORDER BY `id` DESC LIMIT 10 OFFSET 20'
    );
    expect(plan.select.params).toEqual(['%hello%']);
    expect(plan.count.sql).toBe('SELECT COUNT(*) AS n FROM `wp_posts` WHERE `title` LIKE ?');
    expect(plan.count.params).toEqual(['%hello%']);
  });
});

describe('planUpdate', () => {
  it('builds a parameterised update keyed by the primary key', () => {
    const built = planUpdate('wp_posts', COLUMNS, {
      set: { title: 'new' },
      where: { id: 7 },
      usingPk: true,
    });
    expect(built.sql).toBe('UPDATE `wp_posts` SET `title` = ? WHERE `id` = ?');
    expect(built.params).toEqual(['new', 7]);
  });

  // Constraint 4: without a primary key the row was identified by matching every
  // column, and two identical rows must not both be written.
  it('adds LIMIT 1 when the row was not identified by a primary key', () => {
    const built = planUpdate('wp_posts', COLUMNS, {
      set: { title: 'new' },
      where: { id: 7, title: 'old' },
      usingPk: false,
    });
    expect(built.sql.endsWith(' LIMIT 1')).toBe(true);
  });

  it('rejects an empty where', () => {
    expect(() => planUpdate('wp_posts', COLUMNS, { set: { title: 'x' }, where: {} })).toThrow(
      BadRequest
    );
  });

  it('rejects an empty set', () => {
    expect(() => planUpdate('wp_posts', COLUMNS, { set: {}, where: { id: 1 } })).toThrow(BadRequest);
  });

  it('rejects a set naming a column that does not exist', () => {
    expect(() =>
      planUpdate('wp_posts', COLUMNS, { set: { nope: 'x' }, where: { id: 1 } })
    ).toThrow(BadRequest);
  });
});

describe('planDelete', () => {
  it('builds a parameterised delete keyed by the primary key', () => {
    const built = planDelete('wp_posts', COLUMNS, { where: { id: 7 }, usingPk: true });
    expect(built.sql).toBe('DELETE FROM `wp_posts` WHERE `id` = ?');
    expect(built.params).toEqual([7]);
  });

  it('adds LIMIT 1 when the row was not identified by a primary key', () => {
    const built = planDelete('wp_posts', COLUMNS, { where: { id: 7, title: 'old' }, usingPk: false });
    expect(built.sql.endsWith(' LIMIT 1')).toBe(true);
  });

  it('rejects an empty where so it can never become a whole-table delete', () => {
    expect(() => planDelete('wp_posts', COLUMNS, { where: {} })).toThrow(BadRequest);
  });
});

describe('planSql', () => {
  it('splits statements and applies a default limit to a bare select', () => {
    const plan = planSql('SELECT * FROM a; SELECT 1');
    expect(plan.statements).toEqual([`SELECT * FROM a LIMIT ${MAX_PAGE_SIZE}`, `SELECT 1 LIMIT ${MAX_PAGE_SIZE}`]);
    expect(plan.mutating).toBe(false);
  });

  it('leaves an existing LIMIT alone', () => {
    expect(planSql('SELECT * FROM a LIMIT 3').statements).toEqual(['SELECT * FROM a LIMIT 3']);
  });

  it('flags a mutating statement', () => {
    const plan = planSql('UPDATE a SET b = 1 WHERE id = 2');
    expect(plan.mutating).toBe(true);
    expect(plan.unfiltered).toBe(false);
  });

  it('flags a mutating statement with no WHERE as unfiltered', () => {
    const plan = planSql('DELETE FROM a');
    expect(plan.mutating).toBe(true);
    expect(plan.unfiltered).toBe(true);
  });

  it('rejects an empty script', () => {
    expect(() => planSql('   ')).toThrow(BadRequest);
  });
});

describe('confirmationNeeded', () => {
  it('is satisfied for a pure read', () => {
    expect(confirmationNeeded(planSql('SELECT 1'), {})).toBeNull();
  });

  // Constraint 5: the gate is server-side, so a client that forgets to ask is
  // refused rather than obeyed.
  it('demands confirm for a mutating statement', () => {
    expect(confirmationNeeded(planSql('UPDATE a SET b=1 WHERE id=1'), {})).not.toBeNull();
  });

  it('is satisfied for a filtered mutation once confirm is given', () => {
    expect(confirmationNeeded(planSql('UPDATE a SET b=1 WHERE id=1'), { confirm: true })).toBeNull();
  });

  it('still refuses an unfiltered mutation when only confirm is given', () => {
    expect(confirmationNeeded(planSql('DELETE FROM a'), { confirm: true })).not.toBeNull();
  });

  it('is satisfied for an unfiltered mutation once both flags are given', () => {
    expect(
      confirmationNeeded(planSql('DELETE FROM a'), { confirm: true, confirmUnfiltered: true })
    ).toBeNull();
  });
});

describe('truncateCell', () => {
  it('leaves a short string alone', () => {
    expect(truncateCell('hello')).toEqual({ value: 'hello', truncated: false });
  });

  it('leaves null and numbers alone', () => {
    expect(truncateCell(null)).toEqual({ value: null, truncated: false });
    expect(truncateCell(7)).toEqual({ value: 7, truncated: false });
  });

  // Constraint 6: one longblob cell must not be able to put megabytes into a
  // single JSON response.
  it('truncates a value past MAX_CELL_BYTES', () => {
    const out = truncateCell('x'.repeat(MAX_CELL_BYTES + 10));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.value, 'utf8')).toBeLessThanOrEqual(MAX_CELL_BYTES);
  });

  // '€' is 3 bytes in UTF-8 and MAX_CELL_BYTES is not a multiple of 3, so the
  // byte cut lands mid-character -- a splitter that merely sliced bytes
  // without trimming the partial sequence would still pass a length-only
  // assertion, so this also checks the decoded text carries no U+FFFD.
  it('measures bytes, not characters, so multi-byte text is capped correctly', () => {
    const out = truncateCell('€'.repeat(MAX_CELL_BYTES));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.value, 'utf8')).toBeLessThanOrEqual(MAX_CELL_BYTES);
    expect(out.value).not.toContain('�');
  });

  // A leading ASCII byte shifts every 4-byte emoji off the 4-byte alignment
  // MAX_CELL_BYTES would otherwise land on, forcing the cut mid-character and
  // exercising the 4-byte lead-byte branch of the trim separately from the
  // 3-byte case above.
  it('trims a partial 4-byte code point at the cut without corrupting it', () => {
    const out = truncateCell('x' + '😀'.repeat(MAX_CELL_BYTES));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.value, 'utf8')).toBeLessThanOrEqual(MAX_CELL_BYTES);
    expect(out.value).not.toContain('�');
  });

  it('renders a Buffer as a hex string it can also truncate', () => {
    const out = truncateCell(Buffer.from([0xde, 0xad]));
    expect(out.value).toBe('dead');
  });

  // Hex rendering is 2 chars per byte, so a Buffer well under MAX_CELL_BYTES
  // in its own right can still overflow the cap once rendered.
  it('truncates a large Buffer once its hex rendering exceeds MAX_CELL_BYTES', () => {
    const out = truncateCell(Buffer.alloc(MAX_CELL_BYTES, 0xab));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.value, 'utf8')).toBeLessThanOrEqual(MAX_CELL_BYTES);
  });
});

describe('truncateRows', () => {
  it('reports truncation when any cell was truncated', () => {
    const out = truncateRows([['ok'], ['y'.repeat(MAX_CELL_BYTES + 1)]]);
    expect(out.truncated).toBe(true);
  });

  it('reports no truncation for small rows', () => {
    expect(truncateRows([['a', 1, null]]).truncated).toBe(false);
  });
});
