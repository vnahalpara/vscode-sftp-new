import { quoteId } from './dbSearch';

export type SortDir = 'ASC' | 'DESC';
export interface Sort {
  column: string;
  dir: SortDir;
}

export type FilterOp = '=' | '!=' | 'LIKE' | '>' | '<' | '>=' | '<=' | 'IS NULL' | 'IS NOT NULL';
export const FILTER_OPS: FilterOp[] = ['=', '!=', 'LIKE', '>', '<', '>=', '<=', 'IS NULL', 'IS NOT NULL'];

export interface Filter {
  // null column => "anywhere" (OR LIKE across all columns)
  column: string | null;
  op: FilterOp;
  value: string;
}

export interface Built {
  sql: string;
  params: any[];
}

function isNullOp(op: FilterOp): boolean {
  return op === 'IS NULL' || op === 'IS NOT NULL';
}

// Build the WHERE body (no "WHERE" keyword). Returns null when the filter is inactive.
export function buildWhere(filter: Filter | null, allColumns: string[]): Built | null {
  if (!filter) {
    return null;
  }
  if (!isNullOp(filter.op) && (filter.value === '' || filter.value === undefined)) {
    return null;
  }

  if (filter.column) {
    if (isNullOp(filter.op)) {
      return { sql: `${quoteId(filter.column)} ${filter.op}`, params: [] };
    }
    const value = filter.op === 'LIKE' ? `%${filter.value}%` : filter.value;
    return { sql: `${quoteId(filter.column)} ${filter.op} ?`, params: [value] };
  }

  // "anywhere": OR LIKE across every column
  if (!allColumns || allColumns.length === 0) {
    return null;
  }
  const like = `%${filter.value}%`;
  const sql = '(' + allColumns.map(c => `${quoteId(c)} LIKE ?`).join(' OR ') + ')';
  return { sql, params: allColumns.map(() => like) };
}

export function buildOrderBy(sort: Sort | null): string {
  if (!sort) {
    return '';
  }
  return ` ORDER BY ${quoteId(sort.column)} ${sort.dir === 'DESC' ? 'DESC' : 'ASC'}`;
}

export function buildSelect(
  table: string,
  opts: { where: Built | null; orderBy: string; limit: number; offset: number }
): Built {
  let sql = `SELECT * FROM ${quoteId(table)}`;
  const params: any[] = [];
  if (opts.where) {
    sql += ` WHERE ${opts.where.sql}`;
    params.push(...opts.where.params);
  }
  sql += opts.orderBy;
  sql += ` LIMIT ${opts.limit} OFFSET ${opts.offset}`;
  return { sql, params };
}

// Build an UPDATE from changed columns (`set`) and an identifying `where` (PK or all columns).
// NULL where-values become `IS NULL`; everything else is parameterized.
export function buildUpdate(
  table: string,
  set: { [col: string]: any },
  where: { [col: string]: any },
  limitOne?: boolean
): Built {
  const setCols = Object.keys(set);
  const whereCols = Object.keys(where);
  const setSql = setCols.map(c => `${quoteId(c)} = ?`).join(', ');
  const whereSql = whereCols
    .map(c => (where[c] === null || where[c] === undefined ? `${quoteId(c)} IS NULL` : `${quoteId(c)} = ?`))
    .join(' AND ');
  const params: any[] = [
    ...setCols.map(c => set[c]),
    ...whereCols.filter(c => where[c] !== null && where[c] !== undefined).map(c => where[c]),
  ];
  let sql = `UPDATE ${quoteId(table)} SET ${setSql} WHERE ${whereSql}`;
  if (limitOne) {
    sql += ' LIMIT 1';
  }
  return { sql, params };
}

export function buildCount(table: string, where: Built | null): Built {
  let sql = `SELECT COUNT(*) AS n FROM ${quoteId(table)}`;
  const params: any[] = [];
  if (where) {
    sql += ` WHERE ${where.sql}`;
    params.push(...where.params);
  }
  return { sql, params };
}
