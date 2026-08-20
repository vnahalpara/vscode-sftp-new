import { DatabaseConfig } from './dbClient';

// Escape a value for embedding inside a single-quoted shell argument.
export function shellSingle(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

// Build the `mysql` CLI invocation (password via MYSQL_PWD so it stays out of argv).
// SQL is piped to stdin by the caller, so it never needs shell-escaping.
export function buildMysqlCommand(dbConfig: DatabaseConfig): string {
  const parts = [`MYSQL_PWD=${shellSingle(dbConfig.password)}`, 'mysql'];
  parts.push(`--user=${shellSingle(dbConfig.username)}`);
  if (dbConfig.host) {
    parts.push(`--host=${shellSingle(dbConfig.host)}`);
  }
  if (dbConfig.port) {
    parts.push(`--port=${dbConfig.port}`);
  }
  parts.push('--batch', '--default-character-set=utf8mb4', shellSingle(dbConfig.name));
  return parts.join(' ');
}

// Shared mysqldump invocation (auth via MYSQL_PWD, safe streaming flags) without the target tables.
function dumpBase(dbConfig: DatabaseConfig): string {
  const base = [`MYSQL_PWD=${shellSingle(dbConfig.password)}`, 'mysqldump', `--user=${shellSingle(dbConfig.username)}`];
  if (dbConfig.host) {
    base.push(`--host=${shellSingle(dbConfig.host)}`);
  }
  if (dbConfig.port) {
    base.push(`--port=${dbConfig.port}`);
  }
  base.push('--single-transaction', '--quick', '--no-tablespaces', '--default-character-set=utf8mb4');
  return base.join(' ');
}

// Build a mysqldump command. Tables in `noDataTables` are dumped structure-only:
// pass 1 dumps their schema with --no-data; pass 2 dumps everything else (with data + routines).
export function buildMysqldumpCommand(dbConfig: DatabaseConfig, noDataTables: string[]): string {
  const baseStr = dumpBase(dbConfig);
  const db = shellSingle(dbConfig.name);

  if (noDataTables.length === 0) {
    return `${baseStr} --routines ${db}`;
  }
  const tables = noDataTables.map(shellSingle).join(' ');
  const ignores = noDataTables.map(t => `--ignore-table=${shellSingle(dbConfig.name + '.' + t)}`).join(' ');
  return `{ ${baseStr} --no-data ${db} ${tables}; ${baseStr} --routines ${ignores} ${db}; }`;
}

// Build a mysqldump command for a single table (schema + data).
export function buildTableDumpCommand(dbConfig: DatabaseConfig, table: string): string {
  return `${dumpBase(dbConfig)} ${shellSingle(dbConfig.name)} ${shellSingle(table)}`;
}

function unescapeCell(s: string): string {
  if (s.indexOf('\\') === -1) {
    return s;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      out += n === 't' ? '\t' : n === 'n' ? '\n' : n === '0' ? '\0' : n === '\\' ? '\\' : n;
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Parse `mysql --batch` TSV output: first line = headers, rest = rows.
// NULL prints as the literal "NULL" (ambiguous with a "NULL" string — a known CLI limitation).
export function parseMysqlBatch(out: string): { columns: string[]; rows: any[][] } {
  if (!out) {
    return { columns: [], rows: [] };
  }
  const lines = out.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = lines[0].split('\t').map(unescapeCell);
  const rows = lines.slice(1).map(line =>
    line.split('\t').map(cell => (cell === 'NULL' ? null : unescapeCell(cell)))
  );
  return { columns, rows };
}

// mysql CLI reports errors on stderr like "ERROR 1146 (42S02) at line 1: ...".
export function mysqlError(stderr: string): string | null {
  const match = /ERROR\s+\d+.*/.exec(stderr || '');
  return match ? match[0] : null;
}
