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
    // TypeScript's `extends Error` loses the prototype chain when the
    // compiled target's `super(message)` goes through the plain ES `Error`
    // constructor (the repo targets es6, not es5 -- this is TS's built-in
    // extends quirk, not a target-specific one). Without this,
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
// Only a `number`, or a string of plain decimal digits, is accepted -- not
// whatever `Number(...)` happens to parse. `Number('0x10')`, `Number('1e3')`,
// `Number(true)` and `Number([])` all produce safe non-negative integers
// today, but accepting them means the meaning of a value silently depends on
// JS coercion rules rather than on what the client actually sent.
function wholeNumber(value: any, label: string, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    n = Number(value);
  } else {
    throw new BadRequest(`${label} must be a whole number, not ${JSON.stringify(value)}.`);
  }
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

// The client's `usingPk` flag is a HINT, never a fact we trust: a stale or
// scripted client could send `usingPk: true` alongside a `where` that is not
// the primary key, which would switch off the LIMIT 1 below and turn one
// request into a table-wide UPDATE/DELETE. So the claim is verified against
// the live listColumns() answer (`key === 'PRI'`) before it is honoured --
// `where`'s keys must be exactly the table's primary-key column set (all of
// them, for a composite key; order does not matter). Anything else silently
// falls back to `usingPk: false` (LIMIT 1) rather than being rejected, which
// is both the safe interpretation and keeps a legitimate client working.
function isVerifiedPkIdentity(where: { [col: string]: any }, columns: ColumnInfo[]): boolean {
  const pkColumns = columns.filter(c => c.key === 'PRI').map(c => c.name);
  if (pkColumns.length === 0) {
    return false;
  }
  const whereKeys = Object.keys(where);
  if (whereKeys.length !== pkColumns.length) {
    return false;
  }
  return pkColumns.every(name => whereKeys.indexOf(name) !== -1);
}

export function planUpdate(table: string, columns: ColumnInfo[], body: any): Built {
  const source = body || {};
  const set = source.set;
  if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
    throw new BadRequest('No columns to update.');
  }
  requireColumns(Object.keys(set), columns);
  const where = requireIdentity(source.where, columns);
  // limitOne unless the identity is a VERIFIED primary key: two byte-identical
  // rows would otherwise both be written by one edit.
  const usingPk = !!source.usingPk && isVerifiedPkIdentity(where, columns);
  return buildUpdate(table, set, where, !usingPk);
}

export function planDelete(table: string, columns: ColumnInfo[], body: any): Built {
  const source = body || {};
  const where = requireIdentity(source.where, columns);
  const usingPk = !!source.usingPk && isVerifiedPkIdentity(where, columns);
  return buildDelete(table, where, !usingPk);
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
  // Slice by BYTES -- a naive text.slice(MAX_CELL_BYTES) counts UTF-16 units
  // and would still exceed the byte cap for any multi-byte content.
  const buf = Buffer.from(text, 'utf8').slice(0, MAX_CELL_BYTES);
  return { value: buf.slice(0, completeUtf8Prefix(buf)).toString('utf8'), truncated: true };
}

// Finds how many leading bytes of `buf` form complete UTF-8 code points,
// dropping a lead byte's sequence whole if the cut fell before it finished.
//
// This has to work on the raw BYTES, not on the decoded string: once
// buf.toString('utf8') has run, Node has already replaced any incomplete
// trailing sequence with U+FFFD, and a genuine U+FFFD that was present in
// the SOURCE data looks identical to that replacement. A regex trimming a
// trailing U+FFFD off the decoded string (the previous approach here) is
// therefore the wrong layer -- it cannot tell "the source really had this
// character" from "decoding produced this because we cut mid-sequence", and
// so can silently delete real data. Working on bytes avoids the ambiguity.
//
// Exported (rather than kept private) purely so the malformed-input path
// below can be unit tested directly: truncateCell can never actually feed it
// malformed bytes, because its input always comes from
// Buffer.from(text, 'utf8'), which is well-formed by construction. The
// guard exists because this function reads as a general-purpose byte
// helper, not because that path is reachable today.
export function completeUtf8Prefix(buf: Buffer): number {
  let i = buf.length - 1;
  // Walk back over continuation bytes (10xxxxxx) to find the lead byte of
  // whatever sequence ends at (or was cut off at) the buffer's end. Bounded
  // by `i >= 0` so this can never walk past the start of the buffer.
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    i--;
  }
  if (i < 0) {
    // Either `buf` is empty, or it is nothing BUT continuation bytes (no
    // lead byte anywhere) -- malformed UTF-8 with no complete sequence in
    // it at all, so the complete prefix is deliberately empty rather than
    // the whole (garbage) buffer.
    return 0;
  }
  const lead = buf[i];
  const seqLen = (lead & 0xf8) === 0xf0 ? 4 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xe0) === 0xc0 ? 2 : 1;
  // The lead byte's declared sequence length reaches past the end of the
  // buffer, so its continuation bytes were cut off -- drop the whole
  // incomplete sequence rather than decode a partial one.
  return i + seqLen > buf.length ? i : buf.length;
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
