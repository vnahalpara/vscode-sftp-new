import { DbClient } from './dbClient';

export interface SearchHit {
  table: string;
  column: string;
  value: string;
}

export interface SearchOptions {
  maxPerTable?: number;
  concurrency?: number;
  tableFilter?: (table: string) => boolean;
}

// MySQL identifier quoting (backtick, escape embedded backticks).
export function quoteId(id: string): string {
  return '`' + String(id).replace(/`/g, '``') + '`';
}

// Pure builder — given a table and its text columns, produce the per-table LIKE query. Unit-testable.
export function buildTableSearchSql(table: string, columns: string[], limit: number): string {
  const cols = columns.map(quoteId).join(', ');
  const where = columns.map(c => `${quoteId(c)} LIKE ?`).join(' OR ');
  return `SELECT ${cols} FROM ${quoteId(table)} WHERE ${where} LIMIT ${limit}`;
}

/**
 * Search a string across all text columns of every table. Plans via information_schema,
 * then runs one LIKE query per table with bounded concurrency, streaming hits as they
 * arrive and reporting progress. Cancelable.
 */
export async function searchDatabase(
  client: DbClient,
  term: string,
  opts: SearchOptions,
  onProgress: (done: number, total: number, table: string) => void,
  onHits: (hits: SearchHit[]) => void,
  isCancelled: () => boolean
): Promise<void> {
  const textCols = await client.textColumns();
  let tables = Array.from(textCols.keys());
  if (opts.tableFilter) {
    tables = tables.filter(opts.tableFilter);
  }

  const total = tables.length;
  const limit = opts.maxPerTable || 50;
  const concurrency = Math.max(1, opts.concurrency || 3);
  const like = `%${term}%`;
  const needle = term.toLowerCase();
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < tables.length && !isCancelled()) {
      const table = tables[next++];
      const columns = textCols.get(table)!;
      try {
        const sql = buildTableSearchSql(table, columns, limit);
        const res = await client.query(sql, columns.map(() => like));
        const hits: SearchHit[] = [];
        for (const row of res.rows) {
          for (let i = 0; i < columns.length; i++) {
            const v = row[i];
            if (v !== null && v !== undefined && String(v).toLowerCase().indexOf(needle) !== -1) {
              hits.push({ table, column: columns[i], value: String(v) });
            }
          }
        }
        if (hits.length) {
          onHits(hits);
        }
      } catch (_e) {
        // a single bad table shouldn't abort the whole search
      }
      done++;
      onProgress(done, total, table);
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(concurrency, tables.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
