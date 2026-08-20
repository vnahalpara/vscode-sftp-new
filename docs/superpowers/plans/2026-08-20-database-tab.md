# Manage Server — Database tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the extension's existing MySQL/MariaDB engine on the Manage Server browser dashboard as a full-parity Database tab — browse, sort, filter, page, edit, delete, raw SQL, and export.

**Architecture:** Three new server modules behind the existing token-authenticated loopback HTTP server: `ops/db.ts` (pure validation and query planning, no I/O), `dbAccess.ts` (session-scoped adapter over `core/dbConnectionManager.getDbClient`), and `dbExportStream.ts` (dump → gzip → stream → clean up). The browser gets one new React component tree. No new runtime dependency.

**Tech Stack:** TypeScript, Node `node:http`, `mysql2/promise` (already present), React 18 + Vite (`.jsx` only — tsconfig has no `jsx` option), Jest.

**Spec:** `docs/superpowers/specs/2026-08-20-database-tab-design.md`

## Global Constraints

Every task's requirements implicitly include this section. These are copied verbatim
from the spec's "Safety requirements".

1. **No database password may reach the activity log.** `buildMysqlCommand` and
   `buildMysqldumpCommand` embed `MYSQL_PWD='<password>'` in the command string. The
   activity log is serialised to the browser over `GET /api/activity` AND written to
   the VS Code output channel. Every activity entry pushed by a DB route sets
   `command` to a **description** (`select from wp_posts`, `export database shop`),
   never a built command string. Do not call `runPrivileged` from any DB route —
   it logs the command.
2. **Identifiers come from an allowlist.** Every table name and every column name that
   originates in a request is checked against the live `listTables()` /
   `listColumns()` answer before any SQL is built. Unknown identifier → 400.
3. **`limit` and `offset` are spliced into SQL, not parameterised.** Coerce with
   `Number`, reject non-integer/negative, cap `limit` at 500.
4. **UPDATE/DELETE need a non-empty `where` of real columns, and `LIMIT 1` whenever
   `usingPk` is false.**
5. **Mutating raw SQL requires `confirm: true`; mutating-without-WHERE additionally
   requires `confirmUnfiltered: true`.** Enforced server-side.
6. **Cell values are truncated at 65536 bytes**, and the response says so.
7. **The export temp file is removed in a `finally`, including on client abort.**
8. New `.ts` files use the repo's existing style: no Sorbet/strict-mode ceremony, but
   explicit types on exported functions. New UI files are `.jsx`, never `.tsx`.
9. Tests go in `__tests__/` beside the module, named `<thing>-test.ts`, and run under
   the existing `npm test` (Jest). Do not add a new test runner or config.
10. **Never run a mutating statement against a real host during development.**
    `apex.stathmosgroup.com` is the only host that may be touched at all, and only for
    read-only verification.

---

### Task 1: Pure validation and query planning (`ops/db.ts`)

Everything that can be decided without touching SSH or MySQL. This is where
constraints 2, 3, 4, 5 and 6 are actually implemented; the route handlers in later
tasks call into here and are left with almost no logic of their own.

**Files:**
- Create: `src/modules/serverManager/ops/db.ts`
- Test: `src/modules/serverManager/__tests__/ops-db-test.ts`

**Interfaces:**
- Consumes: `Sort`, `Filter`, `FilterOp`, `FILTER_OPS`, `Built`, `buildWhere`,
  `buildOrderBy`, `buildSelect`, `buildUpdate`, `buildDelete`, `buildCount` from
  `../../../core/dbQuery`; `splitStatements`, `applyDefaultLimit`, `isMutating`,
  `hasWhere` from `../../../core/dbSql`; `ColumnInfo` from `../../../core/dbClient`.
- Produces (later tasks depend on these exact names and shapes):
  ```ts
  export const MAX_PAGE_SIZE = 500;
  export const DEFAULT_PAGE_SIZE = 50;
  export const MAX_CELL_BYTES = 65536;

  export class BadRequest extends Error {}

  export function requireTable(table: string, known: string[]): string;
  export function requireColumns(names: string[], columns: ColumnInfo[]): void;
  export function parsePaging(body: any): { limit: number; offset: number };
  export function parseSort(body: any, columns: ColumnInfo[]): Sort | null;
  export function parseFilter(body: any, columns: ColumnInfo[]): Filter | null;
  export function planRows(
    table: string,
    columns: ColumnInfo[],
    body: any
  ): { select: Built; count: Built };
  export function planUpdate(
    table: string,
    columns: ColumnInfo[],
    body: any
  ): Built;
  export function planDelete(
    table: string,
    columns: ColumnInfo[],
    body: any
  ): Built;
  export interface SqlPlan {
    statements: string[];
    mutating: boolean;
    unfiltered: boolean;
  }
  export function planSql(sql: string): SqlPlan;
  export function confirmationNeeded(
    plan: SqlPlan,
    body: any
  ): { reason: string } | null;
  export function truncateCell(value: any): { value: any; truncated: boolean };
  export function truncateRows(rows: any[][]): { rows: any[][]; truncated: boolean };
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/ops-db-test.ts`:

```ts
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

  it('measures bytes, not characters, so multi-byte text is capped correctly', () => {
    const out = truncateCell('é'.repeat(MAX_CELL_BYTES));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.value, 'utf8')).toBeLessThanOrEqual(MAX_CELL_BYTES);
  });

  it('renders a Buffer as a hex string it can also truncate', () => {
    const out = truncateCell(Buffer.from([0xde, 0xad]));
    expect(out.value).toBe('dead');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/serverManager/__tests__/ops-db-test.ts`
Expected: FAIL — `Cannot find module '../ops/db'`.

- [ ] **Step 3: Write `src/modules/serverManager/ops/db.ts`**

```ts
import { ColumnInfo } from '../../../core/dbClient';
import {
  Built,
  Filter,
  FilterOp,
  FILTER_OPS,
  Sort,
  buildCount,
  buildDelete,
  buildOrderBy,
  buildSelect,
  buildUpdate,
  buildWhere,
} from '../../../core/dbQuery';
import { applyDefaultLimit, hasWhere, isMutating, splitStatements } from '../../../core/dbSql';

// A page of 500 rows is already a large JSON response; the cap exists so a
// client cannot ask for the whole table in one request. It doubles as the
// default LIMIT the raw-SQL runner appends to a bare SELECT.
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
// One longblob cell can be megabytes. See Global Constraint 6.
export const MAX_CELL_BYTES = 65536;

// Everything in this module throws this and nothing else for caller error. The
// route layer maps it to 400 -- any OTHER throw is a genuine server fault and
// must keep its 500, so the distinction has to be carried by the type rather
// than by inspecting a message.
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
    // Restores the prototype chain under the repo's ES5 target, without which
    // `instanceof BadRequest` is false and every caller error becomes a 500.
    Object.setPrototypeOf(this, BadRequest.prototype);
  }
}

// Global Constraint 2. `known` is the live listTables() answer for THIS
// database -- never a regex, and never a cached list from another database.
export function requireTable(table: string, known: string[]): string {
  if (!table) {
    throw new BadRequest('No table was named.');
  }
  if (known.indexOf(table) === -1) {
    throw new BadRequest(`No table named "${table}" in this database.`);
  }
  return table;
}

export function requireColumns(names: string[], columns: ColumnInfo[]): void {
  const known = columns.map(c => c.name);
  names.forEach(name => {
    if (known.indexOf(name) === -1) {
      throw new BadRequest(`No column named "${name}" in this table.`);
    }
  });
}

// Global Constraint 3: buildSelect splices these straight into the SQL text
// (MySQL will not accept a placeholder for LIMIT/OFFSET in a prepared
// statement), so anything that is not a plain non-negative integer is refused
// here rather than coerced.
function wholeNumber(value: any, label: string, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) {
    throw new BadRequest(`${label} must be a whole number, not ${JSON.stringify(value)}.`);
  }
  return n;
}

export function parsePaging(body: any): { limit: number; offset: number } {
  const source = body || {};
  const limit = wholeNumber(source.limit, 'limit', DEFAULT_PAGE_SIZE);
  const offset = wholeNumber(source.offset, 'offset', 0);
  return { limit: Math.min(limit, MAX_PAGE_SIZE), offset };
}

export function parseSort(body: any, columns: ColumnInfo[]): Sort | null {
  const sort = body && body.sort;
  if (!sort || !sort.column) {
    return null;
  }
  requireColumns([sort.column], columns);
  return { column: sort.column, dir: sort.dir === 'DESC' ? 'DESC' : 'ASC' };
}

export function parseFilter(body: any, columns: ColumnInfo[]): Filter | null {
  const filter = body && body.filter;
  if (!filter || !filter.op) {
    return null;
  }
  if (FILTER_OPS.indexOf(filter.op as FilterOp) === -1) {
    throw new BadRequest(`Unsupported filter operator: ${filter.op}`);
  }
  // A null column is the "anywhere" search buildWhere already understands --
  // an OR LIKE across every column. Only a NAMED column needs checking.
  if (filter.column !== null && filter.column !== undefined) {
    requireColumns([filter.column], columns);
  }
  return {
    column: filter.column === undefined ? null : filter.column,
    op: filter.op,
    value: filter.value === undefined || filter.value === null ? '' : String(filter.value),
  };
}

export function planRows(
  table: string,
  columns: ColumnInfo[],
  body: any
): { select: Built; count: Built } {
  const { limit, offset } = parsePaging(body);
  const sort = parseSort(body, columns);
  const filter = parseFilter(body, columns);
  const where = buildWhere(filter, columns.map(c => c.name));
  return {
    select: buildSelect(table, { where, orderBy: buildOrderBy(sort), limit, offset }),
    count: buildCount(table, where),
  };
}

// Global Constraint 4. `where` is the row identity the grid computed: the
// primary key when the table has one, every column otherwise. An empty
// identity is refused outright -- that is the difference between editing one
// row and rewriting the table.
function requireIdentity(where: any, columns: ColumnInfo[]): { [col: string]: any } {
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new BadRequest('No row identity was given.');
  }
  const keys = Object.keys(where);
  if (keys.length === 0) {
    throw new BadRequest('No row identity was given.');
  }
  requireColumns(keys, columns);
  return where;
}

export function planUpdate(table: string, columns: ColumnInfo[], body: any): Built {
  const source = body || {};
  const set = source.set;
  if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
    throw new BadRequest('No columns to update.');
  }
  requireColumns(Object.keys(set), columns);
  const where = requireIdentity(source.where, columns);
  // limitOne whenever the identity is NOT a primary key: two byte-identical
  // rows would otherwise both be written by one edit.
  return buildUpdate(table, set, where, !source.usingPk);
}

export function planDelete(table: string, columns: ColumnInfo[], body: any): Built {
  const source = body || {};
  const where = requireIdentity(source.where, columns);
  return buildDelete(table, where, !source.usingPk);
}

export interface SqlPlan {
  statements: string[];
  mutating: boolean;
  unfiltered: boolean;
}

export function planSql(sql: string): SqlPlan {
  if (!sql || !String(sql).trim()) {
    throw new BadRequest('Enter a SQL statement.');
  }
  const raw = splitStatements(String(sql));
  if (raw.length === 0) {
    throw new BadRequest('Enter a SQL statement.');
  }
  const statements = raw.map(s => applyDefaultLimit(s, MAX_PAGE_SIZE));
  const mutators = raw.filter(isMutating);
  return {
    statements,
    mutating: mutators.length > 0,
    // Checked against the RAW statement, not the limit-applied one:
    // applyDefaultLimit never touches a mutation, but reading the pre-transform
    // text keeps this true even if that ever changes.
    unfiltered: mutators.some(s => !hasWhere(s)),
  };
}

// Global Constraint 5. Returns null when the request may proceed, or the reason
// it may not. The browser renders a dialog off this; the server is what
// actually enforces it, so a scripted or stale client cannot skip the gate.
export function confirmationNeeded(plan: SqlPlan, body: any): { reason: string } | null {
  const source = body || {};
  if (!plan.mutating) {
    return null;
  }
  if (!source.confirm) {
    return { reason: 'This script changes data. Confirm to run it.' };
  }
  if (plan.unfiltered && !source.confirmUnfiltered) {
    return {
      reason: 'This script changes data with no WHERE clause, so it affects every row. Confirm again to run it.',
    };
  }
  return null;
}

// Global Constraint 6. Buffers (mysql2 hands back a Buffer for BLOB/BINARY
// columns) become hex, which is what the VS Code grid shows too; everything
// non-string passes through untouched so the client keeps real numbers, nulls
// and booleans rather than their stringified selves.
export function truncateCell(value: any): { value: any; truncated: boolean } {
  if (value === null || value === undefined) {
    return { value, truncated: false };
  }
  let text: string;
  if (Buffer.isBuffer(value)) {
    text = value.toString('hex');
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return { value, truncated: false };
  }
  if (Buffer.byteLength(text, 'utf8') <= MAX_CELL_BYTES) {
    return { value: text, truncated: false };
  }
  // Slice by BYTES, then drop a trailing partial code point: a naive
  // text.slice(MAX_CELL_BYTES) counts UTF-16 units and would still exceed the
  // byte cap for any multi-byte content.
  const buf = Buffer.from(text, 'utf8').slice(0, MAX_CELL_BYTES);
  return { value: buf.toString('utf8').replace(/�$/, ''), truncated: true };
}

export function truncateRows(rows: any[][]): { rows: any[][]; truncated: boolean } {
  let truncated = false;
  const out = rows.map(row =>
    row.map(cell => {
      const result = truncateCell(cell);
      if (result.truncated) {
        truncated = true;
      }
      return result.value;
    })
  );
  return { rows: out, truncated };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/serverManager/__tests__/ops-db-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/ops/db.ts src/modules/serverManager/__tests__/ops-db-test.ts
git commit -m "feat: add pure validation and query planning for the Database tab"
```

---

### Task 2: Make the CLI transport's parameter inlining sql_mode-independent

`DbClient._inline` escapes `'` as `\'`. Under `sql_mode=NO_BACKSLASH_ESCAPES` a
backslash is an ordinary character, so `\'` terminates the string: the same input that
is a harmless value under the default mode becomes a syntax error or an injection.
This affects the exec (CLI) transport only — the path Cloudways-style hosts land on,
because they disable TCP forwarding — and it is exercised by the VS Code panel today
as well as by the new routes.

The fix is a hex literal with an explicit character-set introducer,
`_utf8mb4 X'<hex>'`, which parses identically under both modes and avoids the
"illegal mix of collations" a bare `X'…'` can raise when compared against a utf8mb4
column.

**Files:**
- Modify: `src/core/dbExec.ts` (add `sqlLiteral`)
- Modify: `src/core/dbClient.ts` (`_inline` uses it)
- Test: `src/core/__tests__/db-test.ts` (extend)

**Interfaces:**
- Produces: `export function sqlLiteral(value: any): string` in `src/core/dbExec.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/__tests__/db-test.ts`:

```ts
import { sqlLiteral } from '../dbExec';

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
});
```

Also add, in the same file, a test that `DbClient` uses it on the exec transport:

```ts
import { DbClient } from '../dbClient';

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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/core/__tests__/db-test.ts`
Expected: FAIL — `sqlLiteral` is not exported.

- [ ] **Step 3: Add `sqlLiteral` to `src/core/dbExec.ts`**

Insert after `shellSingle`:

```ts
// Render a JS value as a MySQL literal for the exec (CLI) transport, which has
// no parameter binding.
//
// Strings become `_utf8mb4 X'<hex>'` rather than a quoted string. A quoted
// string has to escape the quote character, and the ONLY two ways to do that
// disagree across server configurations: `\'` is an escape under the default
// sql_mode and an ordinary backslash followed by a string terminator under
// NO_BACKSLASH_ESCAPES, while doubling (`''`) is right in both but leaves the
// backslash itself needing mode-dependent treatment. A hex literal has no
// quoting inside it to subvert, so it is exact under every mode.
//
// The `_utf8mb4` introducer matters: a bare X'..' is a BINARY string, and
// comparing one against a utf8mb4 column raises "Illegal mix of collations".
// A Buffer is genuinely binary and deliberately gets no introducer.
export function sqlLiteral(value: any): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  // isFinite excludes NaN and Infinity, neither of which is a MySQL literal.
  if (typeof value === 'number' && isFinite(value)) {
    return String(value);
  }
  if (Buffer.isBuffer(value)) {
    return `X'${value.toString('hex')}'`;
  }
  return `_utf8mb4 X'${Buffer.from(String(value), 'utf8').toString('hex')}'`;
}
```

- [ ] **Step 4: Use it in `src/core/dbClient.ts`**

Replace the body of `_inline` with:

```ts
  // Inline ? placeholders for the exec (CLI) transport, which has no parameter
  // binding. sqlLiteral (dbExec.ts) renders every value as a hex literal, which
  // parses identically under NO_BACKSLASH_ESCAPES and the default sql_mode --
  // the quoted-string escaping this used to do did not.
  private _inline(sql: string, params?: any[]): string {
    if (!params || params.length === 0) {
      return sql;
    }
    let i = 0;
    return sql.replace(/\?/g, () => sqlLiteral(params[i++]));
  }
```

and extend the existing import:

```ts
import { buildMysqlCommand, parseMysqlBatch, mysqlError, sqlLiteral } from './dbExec';
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/core/__tests__/db-test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite to check nothing else depended on the old escaping**

Run: `npm test`
Expected: the suite's usual result — one known pre-existing time-offset failure, everything else passing.

- [ ] **Step 7: Commit**

```bash
git add src/core/dbExec.ts src/core/dbClient.ts src/core/__tests__/db-test.ts
git commit -m "fix: inline CLI-transport parameters as sql_mode-independent hex literals"
```

---

### Task 3: Session-scoped database access (`dbAccess.ts`)

Which databases this profile has, what the browser may be told about them, and how a
route gets a `DbClient` for one. Built in `ensureSession` so it closes over
`fileService` and `config` — no database password ever becomes a field on
`ManagedSession`.

**Files:**
- Create: `src/modules/serverManager/dbAccess.ts`
- Modify: `src/modules/serverManager/session.ts` (add the `db` field)
- Modify: `src/modules/serverManager/index.ts` (build it in `ensureSession`)
- Test: `src/modules/serverManager/__tests__/db-access-test.ts`

**Interfaces:**
- Consumes: `DatabaseConfig`, `DbClient` from `../../core/dbClient`.
- Produces:
  ```ts
  export interface DbDescriptor { id: string; name: string; label: string }
  export interface DbAccess {
    list(): DbDescriptor[];
    config(id: string): DatabaseConfig | null;
    client(id: string): DbClient | null;
    tables(id: string): Promise<string[]>;
    columns(id: string, table: string): Promise<ColumnInfo[]>;
  }
  export function createDbAccess(
    databases: DatabaseConfig[],
    open: (dbConfig: DatabaseConfig) => DbClient
  ): DbAccess;
  export function normaliseDatabases(config: any): DatabaseConfig[];
  ```
  `ManagedSession` gains `readonly db: DbAccess`, passed as the sixth constructor
  argument (after `cloudflareConfig`), defaulting to an empty access so every existing
  construction site and test keeps working unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/db-access-test.ts`:

```ts
import { createDbAccess, normaliseDatabases } from '../dbAccess';

const DBS = [
  { username: 'u1', password: 'p1', name: 'shop' },
  { username: 'u2', password: 'p2', name: 'blog', label: 'Blog (staging)' },
];

function accessWith(open: any = () => ({} as any)) {
  return createDbAccess(DBS as any, open);
}

describe('normaliseDatabases', () => {
  it('returns the configured databases', () => {
    expect(normaliseDatabases({ database: DBS })).toHaveLength(2);
  });

  it('returns an empty array when none are configured', () => {
    expect(normaliseDatabases({})).toEqual([]);
    expect(normaliseDatabases({ database: 'not-an-array' })).toEqual([]);
  });

  it('drops entries missing the fields a connection needs', () => {
    expect(normaliseDatabases({ database: [{ name: 'x' }] })).toEqual([]);
  });
});

describe('createDbAccess.list', () => {
  it('gives each database a positional id', () => {
    expect(accessWith().list().map(d => d.id)).toEqual(['db0', 'db1']);
  });

  it('falls back to the name when no label is set', () => {
    expect(accessWith().list()[0].label).toBe('shop');
  });

  it('uses the label when one is set', () => {
    expect(accessWith().list()[1].label).toBe('Blog (staging)');
  });

  // The descriptor list is serialised straight to the browser. Same contract
  // RedactedProfile upholds: an allowlist of named fields, built fresh.
  it('never carries a username or password', () => {
    const json = JSON.stringify(accessWith().list());
    expect(json).not.toContain('p1');
    expect(json).not.toContain('u1');
  });
});

describe('createDbAccess.client', () => {
  it('opens a client for a known id', () => {
    const marker = { marker: true } as any;
    expect(accessWith(() => marker).client('db0')).toBe(marker);
  });

  it('returns null for an unknown id', () => {
    expect(accessWith().client('db9')).toBeNull();
    expect(accessWith().client('nonsense')).toBeNull();
  });

  // 'db1x' must not be parsed as 1, and '' must not be parsed as 0.
  it('rejects an id that is not exactly dbN', () => {
    expect(accessWith().client('db1x')).toBeNull();
    expect(accessWith().client('')).toBeNull();
    expect(accessWith().client('db-1')).toBeNull();
  });

  it('passes the matching config to the opener', () => {
    const seen: any[] = [];
    accessWith((cfg: any) => {
      seen.push(cfg);
      return {} as any;
    }).client('db1');
    expect(seen[0].name).toBe('blog');
  });
});

describe('createDbAccess.tables', () => {
  it('lists tables through the client', async () => {
    const access = accessWith(() => ({ listTables: async () => ['a', 'b'] } as any));
    await expect(access.tables('db0')).resolves.toEqual(['a', 'b']);
  });

  it('rejects for an unknown id', async () => {
    await expect(accessWith().tables('db9')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/db-access-test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/modules/serverManager/dbAccess.ts`**

```ts
import { ColumnInfo, DatabaseConfig, DbClient } from '../../core/dbClient';

// What the browser is told about a configured database: enough to name it in a
// picker, and nothing else. This object is serialised straight over
// GET /api/db -- the same contract RedactedProfile (registry.ts) upholds, and
// for the same reason: it is built fresh from named fields, never by stripping
// keys off the raw config, so a new credential field cannot leak by omission.
export interface DbDescriptor {
  id: string;
  name: string;
  label: string;
}

export interface DbAccess {
  list(): DbDescriptor[];
  config(id: string): DatabaseConfig | null;
  client(id: string): DbClient | null;
  tables(id: string): Promise<string[]>;
  columns(id: string, table: string): Promise<ColumnInfo[]>;
}

// Ids are positional (`db0`, `db1`, ...) and match the `database[]` array
// order. Not the name: two entries may legitimately share a `name` (the same
// schema name on a different host), and `label` is free text. The id is opaque
// to the browser, which learns the mapping from list().
const ID_PATTERN = /^db(0|[1-9][0-9]*)$/;

function indexOfId(id: string, count: number): number {
  const match = ID_PATTERN.exec(String(id || ''));
  if (!match) {
    return -1;
  }
  const index = Number(match[1]);
  return index < count ? index : -1;
}

// A `database[]` entry with no username, password or name cannot open a
// connection; surfacing it would put a picker entry in the UI whose every
// request fails with a driver error. Joi already requires all three, but a
// config can reach here from a hand-edited file that failed validation
// earlier in the load, so this filters rather than trusts.
export function normaliseDatabases(config: any): DatabaseConfig[] {
  const raw = config && config.database;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry: any) =>
      entry &&
      typeof entry.name === 'string' &&
      entry.name !== '' &&
      typeof entry.username === 'string' &&
      typeof entry.password === 'string'
  );
}

// `open` is injected rather than importing getDbClient directly so this whole
// module is testable without an SSH connection -- index.ts supplies the real
// one, which closes over fileService and config.
export function createDbAccess(
  databases: DatabaseConfig[],
  open: (dbConfig: DatabaseConfig) => DbClient
): DbAccess {
  function configFor(id: string): DatabaseConfig | null {
    const index = indexOfId(id, databases.length);
    return index === -1 ? null : databases[index];
  }

  function clientFor(id: string): DbClient | null {
    const dbConfig = configFor(id);
    return dbConfig ? open(dbConfig) : null;
  }

  function require(id: string): DbClient {
    const client = clientFor(id);
    if (!client) {
      throw new Error(`No database "${id}" is configured for this profile.`);
    }
    return client;
  }

  return {
    list: () =>
      databases.map((dbConfig, index) => ({
        id: `db${index}`,
        name: dbConfig.name,
        label: dbConfig.label || dbConfig.name,
      })),
    config: configFor,
    client: clientFor,
    tables: id => require(id).listTables(),
    columns: (id, table) => require(id).listColumns(table),
  };
}

// The access a session with no `database[]` gets. Exported so every existing
// ManagedSession construction site (and every existing test) keeps working
// without being edited.
export const NO_DATABASES: DbAccess = createDbAccess([], () => {
  throw new Error('No databases are configured for this profile.');
});
```

- [ ] **Step 4: Add the field to `ManagedSession`**

In `src/modules/serverManager/session.ts`, add the import and the field:

```ts
import { DbAccess, NO_DATABASES } from './dbAccess';
```

After the `cloudflareConfig` field declaration, add:

```ts
  // How the /api/db/* routes reach this profile's databases. A FUNCTION-shaped
  // adapter, deliberately, not the raw `database[]` array: the array carries a
  // username and password per entry, and this object lives for as long as the
  // dashboard stays open. DbAccess closes over the credentials inside
  // index.ts's ensureSession instead, so they are reachable only from the code
  // that opens a connection. Like cloudflareConfig, this must never be added
  // to state()/SessionState -- that object goes straight to the browser.
  readonly db: DbAccess;
```

Extend the constructor signature with a seventh parameter and assign it:

```ts
    cloudflareConfig: { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_API_TOKEN?: string } = {},
    db: DbAccess = NO_DATABASES
  ) {
    ...
    this.cloudflareConfig = cloudflareConfig;
    this.db = db;
  }
```

- [ ] **Step 5: Wire it in `src/modules/serverManager/index.ts`**

Add imports:

```ts
import { getDbClient } from '../../core/dbConnectionManager';
import { createDbAccess, normaliseDatabases } from './dbAccess';
```

In `ensureSession`, immediately before `const session = new ManagedSession(`:

```ts
  // Closes over fileService and config so no database password becomes a field
  // on the session object. getDbClient pools one client per (connection,
  // database), so the dashboard and the VS Code panel share a connection
  // rather than opening a second one per database.
  const dbAccess = createDbAccess(normaliseDatabases(config), dbConfig =>
    getDbClient(fileService, config, dbConfig)
  );
```

and pass `dbAccess` as the argument after the Cloudflare object.

- [ ] **Step 6: Run the tests**

Run: `npx jest src/modules/serverManager/__tests__/db-access-test.ts src/modules/serverManager/__tests__/session-test.ts`
Expected: PASS — including every existing session test, unchanged, because the new parameter has a default.

- [ ] **Step 7: Commit**

```bash
git add src/modules/serverManager/dbAccess.ts src/modules/serverManager/session.ts src/modules/serverManager/index.ts src/modules/serverManager/__tests__/db-access-test.ts
git commit -m "feat: give the managed session scoped access to its databases"
```

---

### Task 4: JSON request bodies on the loopback HTTP server

Found in the pre-flight scan: `Ctx` (`httpServer.ts`) carries `req`, `res`, `params`,
`query` and `token` — but **no body**. No existing POST route reads one
(`/api/host/refresh` and the service actions are all path-parameterised), so nothing has
ever needed it. Every DB route in Tasks 5–7 does. This lands first, on its own, because
it changes the request pipeline every route shares.

**Files:**
- Modify: `src/modules/serverManager/httpServer.ts`
- Test: `src/modules/serverManager/__tests__/httpServer-body-test.ts`

**Interfaces:**
- Produces: `Ctx` gains `body: any`, always an object — `{}` when the request carried no
  body. Tasks 5–7 read `ctx.body` and may assume it is never null or undefined.
  ```ts
  export const MAX_BODY_BYTES = 1048576;
  ```

Requirements:

- Only methods that can carry a body are read (`POST`, `PUT`, `PATCH`). A `GET` must
  never wait on a body — `GET /api/stream` is a long-lived SSE response, and blocking it
  behind a body read would hang the dashboard's whole event stream.
- The body is read **after** the token check and **after** `matchRoute`. Reading it
  earlier would let an unauthenticated caller stream a megabyte into this process, and
  would read a body for a path that has no route at all.
- `content-type` must be JSON (`application/json`, with or without parameters). Anything
  else is a 415. An absent `content-type` with a zero-length body is fine and yields `{}`.
- Over `MAX_BODY_BYTES` → 413, and the request is destroyed rather than drained.
- Malformed JSON → 400, before the handler runs.
- A JSON body that is not an object (`"a string"`, `42`, `null`, `[1,2]`) → 400. Every
  consumer indexes into it by key; an array or a scalar would silently read as `{}`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/httpServer-body-test.ts`. Drive a real
server through `createServer` + `listen` — the pattern `httpServer-test.ts` already uses
— and assert:

```
POST with a valid JSON object       -> handler sees the parsed object
POST with no body at all            -> handler sees {}
GET on a route that reads the body  -> handler sees {}, and does not hang
POST with malformed JSON            -> 400, handler never runs
POST with a JSON array              -> 400, handler never runs
POST with a JSON scalar             -> 400, handler never runs
POST with content-type: text/plain  -> 415, handler never runs
POST with a body over the cap       -> 413, handler never runs
POST with no token                  -> 401, and the body is never read
```

The "handler never runs" assertions are the load-bearing half: use a handler that
increments a counter, and assert the counter is still 0.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/httpServer-body-test.ts`
Expected: FAIL — `ctx.body` is undefined.

- [ ] **Step 3: Implement it**

Add a `readJsonBody(req)` helper to `httpServer.ts` and make the `isApi(pathname)`
branch async, awaiting the body between `ctx.params = match.params` and the
`match.handler(ctx)` call. Assign through a mutable local rather than making `Ctx.body`
optional, so no consumer has to null-check it.

Notes the implementation must honour:

- Accumulate into a `Buffer[]` and track the running byte total; abort as soon as the
  total exceeds `MAX_BODY_BYTES`, without buffering the rest.
- On the size abort, respond 413 and call `req.destroy()` — draining a megabyte you have
  already decided to reject is the thing the cap exists to avoid.
- Reject on the request's own `'error'` event too (a client that disconnects mid-body),
  and make sure that path does not then try to respond on a destroyed socket.
- The existing `try/catch` plus `.catch(error => fail(ctx, error, true))` around the
  handler must still see handler rejections; awaiting the body must not swallow them.

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx jest src/modules/serverManager/__tests__/` then `npm test`
Expected: PASS. Every existing route test still passes — they construct `Ctx` directly
and never go through this path.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/httpServer.ts src/modules/serverManager/__tests__/httpServer-body-test.ts
git commit -m "feat: parse JSON request bodies on the manage-server HTTP surface"
```

---

### Task 5: Read routes — list, tables, columns, rows

**Files:**
- Modify: `src/modules/serverManager/routes.ts`
- Test: `src/modules/serverManager/__tests__/routes-db-test.ts`

**Interfaces:**
- Consumes: `ops/db.ts` (Task 1), `dbAccess.ts` (Task 3).
- Produces: the four read routes in the spec's table. A shared `dbHandler` helper in
  `routes.ts` that resolves the session, resolves the client, maps `BadRequest` to 400,
  and pushes an activity entry whose `command` is a description.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/routes-db-test.ts`. Extend the existing
`fakeSession`/`fakeCtx` pattern from `routes-test.ts` (copy them; do not export them
from that file — it keeps each test file readable on its own):

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/routes-db-test.ts`
Expected: FAIL — no `/api/db` route matches.

- [ ] **Step 3: Add the routes to `src/modules/serverManager/routes.ts`**

Add imports:

```ts
import { BadRequest, planRows, requireTable, truncateRows } from './ops/db';
```

Add this helper above `buildRoutes` (beside `opsFor`/`readOpsFor`):

```ts
// The DB equivalent of runPrivileged -- with one deliberate difference that is
// the whole reason it is a separate function rather than a reuse.
//
// runPrivileged records the COMMAND STRING it ran. For a database operation
// that string would be built by buildMysqlCommand/buildMysqldumpCommand, both
// of which embed `MYSQL_PWD='<password>'` literally. The activity log is
// serialised to the browser over GET /api/activity AND written to the VS Code
// output channel, so logging the command would put the database password in
// both -- the same class of leak as the Cloudflare token leak fixed in 1.27.0.
// `label`/`description` are written by US, from the table and operation names,
// and never from a credential-bearing string.
async function runDb<T>(
  session: ManagedSession,
  label: string,
  description: string,
  call: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  const start = Date.now();
  try {
    const value = await call();
    session.activity.push({
      at: Date.now(),
      label,
      command: description,
      code: 0,
      ms: Date.now() - start,
      error: null,
    });
    return { ok: true, value };
  } catch (error) {
    session.activity.push({
      at: Date.now(),
      label,
      command: description,
      code: 1,
      ms: Date.now() - start,
      error: (error as Error).message,
    });
    return { ok: false, error: error as Error };
  }
}

// Resolve the session and the DbClient together. A missing session is the
// existing 404; a database id this profile does not carry is also a 404 (the
// resource genuinely does not exist), which is distinct from the 400 an
// unknown TABLE gets (the resource exists; the request about it is wrong).
function resolveDb(
  deps: RouteDeps,
  ctx: Ctx
): { session: ManagedSession; client: DbClient } | null {
  const session = resolve(deps, ctx);
  if (!session) {
    return null;
  }
  const client = session.db.client(ctx.params.id);
  if (!client) {
    ctx.text(404, `No database "${ctx.params.id}" is configured for this profile.`);
    return null;
  }
  return { session, client };
}

// BadRequest (ops/db.ts) is caller error and maps to 400. Anything else is a
// genuine fault -- a dead SSH channel, a driver error -- and keeps its 500.
// Distinguishing by TYPE rather than by inspecting the message is what stops a
// real server fault from being reported to the user as their own mistake.
function dbError(ctx: Ctx, error: Error): void {
  if (error instanceof BadRequest) {
    ctx.text(400, error.message);
    return;
  }
  ctx.text(500, error.message);
}

// Resolve a table name against the live listing for THIS database -- Global
// Constraint 2 -- and hand back its columns, which every plan* function needs
// for its own allowlist checks.
async function tableContext(
  client: DbClient,
  table: string
): Promise<{ table: string; columns: ColumnInfo[] }> {
  const known = await client.listTables();
  const resolved = requireTable(table, known);
  return { table: resolved, columns: await client.listColumns(resolved) };
}
```

Add the routes to the `routes` array, after the Cloudflare entries:

```ts
    {
      method: 'GET',
      path: '/api/db',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        // Descriptors only -- id, name and label. dbAccess.list() builds them
        // fresh from named fields, so no credential can ride along.
        ctx.json(200, { databases: session.db.list() });
      },
    },
    {
      method: 'GET',
      path: '/api/db/:id/tables',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }
        const result = await runDb(resolved.session, 'list tables', `database ${ctx.params.id}`, () =>
          resolved.client.listTables()
        );
        if (!result.ok) {
          dbError(ctx, result.error);
          return;
        }
        ctx.json(200, { tables: result.value });
      },
    },
    {
      method: 'GET',
      path: '/api/db/:id/tables/:table/columns',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }
        const result = await runDb(
          resolved.session,
          'read table structure',
          `${ctx.params.table} structure`,
          () => tableContext(resolved.client, ctx.params.table)
        );
        if (!result.ok) {
          dbError(ctx, result.error);
          return;
        }
        ctx.json(200, { columns: result.value.columns });
      },
    },
    {
      method: 'POST',
      path: '/api/db/:id/tables/:table/rows',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }
        const result = await runDb(resolved.session, 'select rows', `select from ${ctx.params.table}`, async () => {
          const context = await tableContext(resolved.client, ctx.params.table);
          const plan = planRows(context.table, context.columns, ctx.body);
          const page = await resolved.client.query(plan.select.sql, plan.select.params);
          const counted = await resolved.client.query(plan.count.sql, plan.count.params);
          const capped = truncateRows(page.rows);
          return {
            columns: page.columns,
            rows: capped.rows,
            truncated: capped.truncated,
            // COUNT(*) comes back as a number over the stream transport and a
            // string over the CLI one; normalise so the client's arithmetic
            // works on both.
            total: counted.rows.length ? Number(counted.rows[0][0]) : 0,
            durationMs: page.durationMs,
          };
        });
        if (!result.ok) {
          dbError(ctx, result.error);
          return;
        }
        ctx.json(200, result.value);
      },
    },
```

Add the missing imports at the top: `ColumnInfo`, `DbClient` from `'../../core/dbClient'`.

- [ ] **Step 4: (already verified — no work needed)**

`matchRoute` (`router.ts`) is generic over segment count and matches
`/api/db/:id/tables/:table/columns` as-is. It also splits on `/` BEFORE
`decodeURIComponent`, so a table name containing a slash survives correctly as one
percent-encoded segment. No router change is needed; do not make one.

Note its return shape: `matchRoute` returns `{ handler, params }` — **not**
`{ route, params }`. Call it as `matched.handler(ctx)`.

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/serverManager/__tests__/routes-db-test.ts src/modules/serverManager/__tests__/routes-test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/serverManager/routes.ts src/modules/serverManager/__tests__/routes-db-test.ts
git commit -m "feat: serve database listings, structure and paged rows"
```

---

### Task 6: Mutation routes — update, delete, raw SQL

**Files:**
- Modify: `src/modules/serverManager/routes.ts`
- Test: `src/modules/serverManager/__tests__/routes-db-mutate-test.ts`

**Interfaces:**
- Consumes: `planUpdate`, `planDelete`, `planSql`, `confirmationNeeded` from
  `./ops/db`; the `runDb`/`resolveDb`/`dbError`/`tableContext` helpers from Task 5.
- Produces: three routes. `POST /sql` returns `{needsConfirm: true, reason, statements}`
  with status 200 when the confirmation gate is not satisfied — it is a normal answer
  the UI acts on, not an error.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/routes-db-mutate-test.ts`, reusing the same
fakes as Task 4:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/routes-db-mutate-test.ts`
Expected: FAIL — no matching routes.

- [ ] **Step 3: Add the three routes**

```ts
    {
      method: 'POST',
      path: '/api/db/:id/tables/:table/update',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }
        const result = await runDb(resolved.session, 'update row', `update ${ctx.params.table}`, async () => {
          const context = await tableContext(resolved.client, ctx.params.table);
          const built = planUpdate(context.table, context.columns, ctx.body);
          return resolved.client.query(built.sql, built.params);
        });
        if (!result.ok) {
          dbError(ctx, result.error);
          return;
        }
        ctx.json(200, { ok: true, affectedRows: result.value.affectedRows });
      },
    },
    {
      method: 'POST',
      path: '/api/db/:id/tables/:table/delete',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }
        const result = await runDb(resolved.session, 'delete row', `delete from ${ctx.params.table}`, async () => {
          const context = await tableContext(resolved.client, ctx.params.table);
          const built = planDelete(context.table, context.columns, ctx.body);
          return resolved.client.query(built.sql, built.params);
        });
        if (!result.ok) {
          dbError(ctx, result.error);
          return;
        }
        ctx.json(200, { ok: true, affectedRows: result.value.affectedRows });
      },
    },
    {
      method: 'POST',
      path: '/api/db/:id/sql',
      handler: async ctx => {
        const resolved = resolveDb(deps, ctx);
        if (!resolved) {
          return;
        }

        let plan;
        try {
          plan = planSql(ctx.body && ctx.body.sql);
        } catch (error) {
          dbError(ctx, error as Error);
          return;
        }

        // Global Constraint 5. Answered BEFORE anything runs, and answered
        // here rather than in the browser: a stale tab, a replayed request or
        // a script driving this API must hit the same gate the dialog does.
        // 200 rather than 4xx because it is a normal answer the UI acts on --
        // it renders the confirmation and resends -- not a failure.
        const needed = confirmationNeeded(plan, ctx.body);
        if (needed) {
          ctx.json(200, { needsConfirm: true, reason: needed.reason, statements: plan.statements });
          return;
        }

        // Statements run in sequence and stop at the first failure, but the
        // results that already succeeded are still returned: half a script
        // having run is exactly what the user needs to know, and discarding
        // those results to report only the error would hide it.
        const results: any[] = [];
        let failure: string | null = null;
        const start = Date.now();
        for (const statement of plan.statements) {
          try {
            const res = await resolved.client.query(statement);
            const capped = truncateRows(res.rows);
            results.push({
              columns: res.columns,
              rows: capped.rows,
              truncated: capped.truncated,
              rowCount: res.rowCount,
              affectedRows: res.affectedRows,
              durationMs: res.durationMs,
            });
          } catch (error) {
            failure = (error as Error).message;
            break;
          }
        }

        resolved.session.activity.push({
          at: Date.now(),
          label: 'run sql',
          // The statement COUNT and the mutating flag, never the SQL text --
          // a raw statement can carry values a user pasted in, and the
          // activity log goes to the browser and the output channel alike.
          command: `${plan.statements.length} statement(s)${plan.mutating ? ', mutating' : ''}`,
          code: failure ? 1 : 0,
          ms: Date.now() - start,
          error: failure,
        });

        ctx.json(200, { results, error: failure });
      },
    },
```

Extend the import from `./ops/db` with `planUpdate`, `planDelete`, `planSql`,
`confirmationNeeded`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/serverManager/__tests__/routes-db-mutate-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/routes.ts src/modules/serverManager/__tests__/routes-db-mutate-test.ts
git commit -m "feat: serve row edits, row deletes and a guarded SQL runner"
```

---

### Task 7: Export download (`dbExportStream.ts`)

The VS Code path (`src/modules/dbExport.ts`) dumps to a gzip on the server, pulls it
back over SFTP, and writes it to a chosen local path. The browser path is the same dump
staged the same way, but streamed into the HTTP response — and it has one case the
VS Code path never had: the browser can abandon the download mid-stream, and the temp
file must still be removed.

**Files:**
- Create: `src/modules/serverManager/dbExportStream.ts`
- Modify: `src/modules/serverManager/routes.ts` (the `GET /api/db/:id/export` route)
- Modify: `src/modules/serverManager/dbAccess.ts` (add `dump`, below)
- Test: `src/modules/serverManager/__tests__/db-export-stream-test.ts`

**Interfaces:**
- `DbAccess` gains exactly one method. It deliberately does NOT gain a
  `dump(): Promise<ReadableStream>` — that would move the SFTP staging and cleanup
  plumbing into `dbAccess.ts`, whose whole job is credential scoping. `dbAccess` hands
  out only what `dbExportStream` cannot get for itself:
  ```ts
  exporter(id: string): { deps: ExportDeps; dbConfig: DatabaseConfig } | null;
  ```
  where `ExportDeps` is defined in `dbExportStream.ts`:
  ```ts
  export interface ExportDeps {
    exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
    get(remoteFile: string): Promise<NodeJS.ReadableStream>;
    remotePath: string;
    randomName(): string;
  }
  export interface ExportTarget { dbConfig: DatabaseConfig; table: string | null }
  export function exportFilename(dbName: string, table: string | null, stamp: string): string;
  export async function streamExport(
    deps: ExportDeps,
    target: ExportTarget,
    sink: { write(chunk: Buffer): boolean; end(): void; onAbort(fn: () => void): void }
  ): Promise<void>;
  ```
  `index.ts` supplies `ExportDeps` from `getSshClient`/`getRemoteFs`, exactly as
  `dbExport.ts` does.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/serverManager/__tests__/db-export-stream-test.ts`:

```ts
import { Readable } from 'stream';
import { exportFilename, streamExport } from '../dbExportStream';

const DB = { username: 'u', password: 'DB-PASSWORD-4c1f', name: 'shop' };

function fakeDeps(overrides: any = {}) {
  const execs: string[] = [];
  return {
    execs,
    deps: {
      exec: async (cmd: string) => {
        execs.push(cmd);
        return { stdout: '', stderr: '', code: 0 };
      },
      get: async () => Readable.from([Buffer.from('gzipbytes')]),
      remotePath: '/var/www/html',
      randomName: () => 'abc123',
      ...overrides,
    },
  };
}

function fakeSink() {
  const chunks: Buffer[] = [];
  let abort: () => void = () => undefined;
  return {
    chunks,
    ended: false,
    fireAbort: () => abort(),
    sink: {
      write(chunk: Buffer) {
        chunks.push(chunk);
        return true;
      },
      end() {
        (this as any).ended = true;
      },
      onAbort(fn: () => void) {
        abort = fn;
      },
    },
  };
}

describe('exportFilename', () => {
  it('names a whole-database dump', () => {
    expect(exportFilename('shop', null, '2026-08-20')).toBe('shop-2026-08-20.sql.gz');
  });

  it('names a single-table dump', () => {
    expect(exportFilename('shop', 'wp_posts', '2026-08-20')).toBe('shop.wp_posts-2026-08-20.sql.gz');
  });

  // The filename lands in a Content-Disposition header. A name carrying a
  // quote or a newline could forge a second header.
  it('replaces characters that are not safe in a header', () => {
    expect(exportFilename('a"b\nc', null, 's')).toBe('a_b_c-s.sql.gz');
  });
});

describe('streamExport', () => {
  it('streams the dump to the sink and ends it', async () => {
    const { deps } = fakeDeps();
    const sink = fakeSink();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, sink.sink as any);
    expect(Buffer.concat(sink.chunks).toString()).toBe('gzipbytes');
  });

  it('stages the dump under remotePath so a chrooted SFTP can read it back', async () => {
    const { deps, execs } = fakeDeps();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    expect(execs[0]).toContain('/var/www/html/.sftp-db-export-tmp');
  });

  // Global Constraint 7.
  it('removes the temp file after a successful stream', async () => {
    const { deps, execs } = fakeDeps();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    expect(execs[execs.length - 1]).toContain('rm -f');
  });

  it('removes the temp file when the dump command fails', async () => {
    const { deps, execs } = fakeDeps({
      exec: async (cmd: string) => {
        execs.push(cmd);
        return cmd.indexOf('rm -f') === -1
          ? { stdout: '', stderr: 'mysqldump: got error 1045', code: 1 }
          : { stdout: '', stderr: '', code: 0 };
      },
    });
    await expect(
      streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any)
    ).rejects.toThrow(/1045/);
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  it('removes the temp file when the download fails', async () => {
    const { deps, execs } = fakeDeps({
      get: async () => {
        throw new Error('sftp closed');
      },
    });
    await expect(
      streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any)
    ).rejects.toThrow('sftp closed');
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  it('removes the temp file when the browser aborts mid-stream', async () => {
    let push: (chunk: Buffer | null) => void = () => undefined;
    const stream = new Readable({ read() {} });
    push = chunk => (chunk === null ? stream.push(null) : stream.push(chunk));
    const { deps, execs } = fakeDeps({ get: async () => stream });
    const sink = fakeSink();
    const pending = streamExport(deps as any, { dbConfig: DB as any, table: null }, sink.sink as any);
    push(Buffer.from('partial'));
    sink.fireAbort();
    await pending.catch(() => undefined);
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  // Global Constraint 1: the dump command embeds MYSQL_PWD. It must never
  // become part of an error message the caller might log or return.
  it('does not put the password in the error it throws', async () => {
    const { deps } = fakeDeps({
      exec: async (cmd: string) =>
        cmd.indexOf('rm -f') === -1
          ? { stdout: '', stderr: 'failed', code: 1 }
          : { stdout: '', stderr: '', code: 0 },
    });
    // toThrow() does not accept an asymmetric matcher, so assert on the
    // caught error directly.
    let caught: Error | null = null;
    try {
      await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('DB-PASSWORD-4c1f');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/db-export-stream-test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/modules/serverManager/dbExportStream.ts`**

Model it on `src/modules/dbExport.ts`'s `dumpAndDownload`, with three differences:
the sink is an HTTP response rather than a local file; the gzip is passed through
unchanged (the browser saves a `.sql.gz`); and the cleanup runs on abort as well as on
success and failure. Key points the implementation must honour:

- Build the dump with `buildMysqldumpCommand(dbConfig, [])` for a whole database and
  `buildTableDumpCommand(dbConfig, table)` for one table — both from `core/dbExec`.
- Stage at `${remotePath}/.sftp-db-export-tmp/${randomName()}.sql.gz`, created with
  `mkdir -p`, using `shellSingle` for every interpolated path.
- On a non-zero exit, throw an error built from `stderr` **only** — never from the
  command string, which carries `MYSQL_PWD`.
- Register the abort handler through `sink.onAbort` BEFORE the first `write`, and have
  it destroy the source stream so the SFTP read stops rather than draining into a
  socket nobody is reading.
- Clean up in a `finally` with `rm -f … ; rmdir … 2>/dev/null || true`, wrapped in its
  own try/catch so a cleanup failure never replaces the real error.
- `exportFilename` replaces anything outside `[A-Za-z0-9_.-]` with `_`.

- [ ] **Step 4: Add `exporter(id)` to `DbAccess` and the route**

`createDbAccess` takes a second optional injected function,
`openExport?: (dbConfig: DatabaseConfig) => ExportDeps`, and `exporter(id)` returns
`{ deps, dbConfig }` or null. `index.ts` supplies it from `getSshClient`/`getRemoteFs`
with `config.remotePath` and `crypto.randomBytes(8).toString('hex')`.

The route:

```ts
    {
      method: 'GET',
      path: '/api/db/:id/export',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const exporter = session.db.exporter(ctx.params.id);
        if (!exporter) {
          ctx.text(404, `No database "${ctx.params.id}" is configured for this profile.`);
          return;
        }
        const table = typeof ctx.query.table === 'string' && ctx.query.table ? ctx.query.table : null;
        // Global Constraint 2 applies to the export target too: a table name
        // reaches a shell command here (shellSingle-quoted, but still), so it
        // is checked against the live listing before it is used.
        if (table) {
          const client = session.db.client(ctx.params.id)!;
          try {
            requireTable(table, await client.listTables());
          } catch (error) {
            dbError(ctx, error as Error);
            return;
          }
        }
        const filename = exportFilename(exporter.dbConfig.name, table, stamp());
        ctx.res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        });
        const label = table ? `export table ${table}` : `export database ${exporter.dbConfig.name}`;
        // runDb, so the activity entry's `command` is this description and
        // never the mysqldump invocation, which embeds MYSQL_PWD.
        const result = await runDb(session, 'export', label, () =>
          streamExport(exporter.deps, { dbConfig: exporter.dbConfig, table }, {
            write: chunk => ctx.res.write(chunk),
            end: () => ctx.res.end(),
            onAbort: fn => ctx.req.on('close', fn),
          })
        );
        if (!result.ok) {
          // The headers are already sent, so there is no status left to change:
          // destroy the response so the browser sees a truncated download
          // rather than a silently short, apparently complete file.
          ctx.res.destroy();
        }
      },
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/modules/serverManager/__tests__/db-export-stream-test.ts src/modules/serverManager/__tests__/routes-db-test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/serverManager/dbExportStream.ts src/modules/serverManager/dbAccess.ts src/modules/serverManager/routes.ts src/modules/serverManager/index.ts src/modules/serverManager/__tests__/db-export-stream-test.ts
git commit -m "feat: stream database and table exports to the browser"
```

---

### Task 8: The Database tab UI

**Files:**
- Create: `webui/src/components/Database.jsx`
- Create: `webui/src/components/DbGrid.jsx`
- Create: `webui/src/components/DbSqlRunner.jsx`
- Modify: `webui/src/App.jsx` (add the tab; add it to `PERSISTENT_TABS`; route the
  sidebar entry to it)
- Modify: `src/modules/serverManager/routes.ts` (`CAPABILITIES.database = true`)
- Modify: `src/modules/serverManager/__tests__/routes-test.ts` (the capabilities
  assertion at line ~194 pins `database: false` and must be updated)
- Modify: `webui/dev/mock-server.js` (fixtures for the new routes)

**Interfaces:**
- Consumes: `apiGet`, `apiPost` from `../api.js`; `Card`, `Badge`, `ConfirmDialog` from
  `./ui.jsx` (`ConfirmDialog` already takes a `dismissible` prop, added in 1.27.0).
- Produces: the default-exported `Database` component, taking `{ profile }`.

Requirements:

- Left rail: a `<select>` of databases from `GET /api/db`, then the table list from
  `GET /api/db/:id/tables` with a client-side name filter.
- Grid: `POST …/rows` on every change of table, sort, filter, page. Sortable headers
  (click cycles ASC → DESC → none). A filter row with a column picker (including
  "anywhere"), an operator picker from `FILTER_OPS`, and a value box. Pagination
  showing `offset+1–offset+rows.length of total`.
- Cell editing: click a cell to edit, Enter commits via `POST …/update`, Escape
  cancels. The row identity is the primary key when the table has one (`key === 'PRI'`
  in the column metadata) with `usingPk: true`, and every column's current value
  otherwise with `usingPk: false` — the same rule `dbDataBrowser/index.ts` uses.
- Row delete behind a `ConfirmDialog`.
- SQL runner in a collapsible panel: a textarea, Ctrl/Cmd+Enter to run, one result
  table per statement. When the response carries `needsConfirm`, show the `reason` in
  a `ConfirmDialog` and resend with `confirm: true` (and `confirmUnfiltered: true`
  when the server asks a second time).
- Export buttons: "Export table" and "Export database". These CANNOT be a plain
  `<a href="/api/db/:id/export?…">`: the token travels in the `x-sftp-token` header
  (see `api.js`) and an anchor cannot set one, so the request would 401. Fetch the URL
  with the same headers `api.js` sends, read the response as a Blob, and trigger the
  save through a temporary object-URL anchor — revoking the object URL afterwards.
  Take the filename from the response's `content-disposition`.
- When `rows.truncated` is true, show a note that some cell values were shortened.
- Empty state when the profile has no `database[]` entries: say so, and name
  `sftp.json` as where to add one.

- [ ] **Step 1: Flip the capability and fix the pinned assertion**

In `routes.ts` set `database: true`. In `routes-test.ts` update the capabilities
expectation. Run `npx jest src/modules/serverManager/__tests__/routes-test.ts` and
confirm it passes.

- [ ] **Step 2: Add the tab in `App.jsx`**

Add `['database', 'Database', 'database']` to `TABS`, add `'database'` to
`PERSISTENT_TABS`, update the `PERSISTENT_TABS` comment to say that the set is now
"tabs that hold a live connection OR state the user would have to retype", render
`<Database profile={profile} />` in the persistent-mount branch, and make the sidebar's
Database `NavItem` `active={page === 'database'}`.

- [ ] **Step 3: Write the components**

- [ ] **Step 4: Add mock fixtures**

Extend `webui/dev/mock-server.js` with the five read routes and the three write ones so
`npm run dev:webui` works without a real server. Use the existing fixture identity
(`mock-fixture-host`) — never a real hostname, database name, or username.

- [ ] **Step 5: Build the UI and confirm it compiles**

Run: `npm run build:webui`
Expected: a clean Vite build into `media/webui`.

- [ ] **Step 6: Commit**

```bash
git add webui/src src/modules/serverManager/routes.ts src/modules/serverManager/__tests__/routes-test.ts webui/dev/mock-server.js
git commit -m "feat: add the Database tab to the dashboard"
```

---

### Task 9: Documentation, changelog and release

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version → `1.28.0`)

- [ ] **Step 1: Document the tab in `README.md`**

Add a "Database" subsection under the Manage Server documentation covering: it appears
only when the profile has `database[]` entries; what full parity means; that the SQL
runner requires a confirmation for mutations and a second one for mutations with no
WHERE; that pages are capped at 500 rows and cell values at 64 KiB; and that exports
download a `.sql.gz`. State plainly that the tab has the same reach as the Terminal
tab — anyone with the dashboard URL and its token can already run `mysql` — so the
dashboard should not be left open on a shared screen.

- [ ] **Step 2: Add the changelog entry**

`## 1.28.0` with the feature and, as a separate bullet, the `sql_mode`-independent
parameter inlining fix from Task 2 (it fixes the VS Code panel too, on hosts running
`NO_BACKSLASH_ESCAPES`).

- [ ] **Step 3: Bump the version and run everything**

```bash
npm test
npm run build:webui
npx vsce package
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: document the Database tab; bump to 1.28.0"
```
