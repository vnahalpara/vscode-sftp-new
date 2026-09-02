import { needsQuote } from './format';
import { CsvOp, SortDirection } from './protocol';
import { CsvFormat, CsvRow, CsvTable } from './types';

// Every operation is a pure (table, args) => table. Nothing here mutates its
// input, which is what lets the provider keep the old table when a
// WorkspaceEdit fails.
//
// Each one sets `raw = null` on EXACTLY the rows it changes, and no others:
// that is the difference between a one-line diff and a whole-file rewrite.

export function tableWidth(table: CsvTable): number {
  let width = 0;
  for (const row of table.rows) {
    if (row.cells.length > width) {
      width = row.cells.length;
    }
  }
  return width;
}

export function tableRows(table: CsvTable): string[][] {
  return table.rows.map(row => row.cells.slice());
}

function blankRow(format: CsvFormat, width: number): CsvRow {
  const cells: string[] = [];
  const quoted: boolean[] = [];
  for (let i = 0; i < width; i += 1) {
    cells.push('');
    quoted.push(format.quoteAll);
  }
  return { cells, quoted, raw: null };
}

// A copy of `row` at least `length` cells wide. Always a copy, so the caller
// may write to it.
function padTo(row: CsvRow, length: number, format: CsvFormat): CsvRow {
  const cells = row.cells.slice();
  const quoted = row.quoted.slice();
  if (cells.length >= length) {
    return { cells, quoted, raw: row.raw };
  }
  while (cells.length < length) {
    cells.push('');
    quoted.push(format.quoteAll);
  }
  return { cells, quoted, raw: null };
}

// Sorted, de-duplicated, in-range row indices.
function indexSet(values: number[], length: number): number[] {
  const out: number[] = [];
  values.forEach(value => {
    if (value >= 0 && value < length && out.indexOf(value) === -1) {
      out.push(value);
    }
  });
  return out.sort((a, b) => a - b);
}

export function setCell(table: CsvTable, row: number, col: number, value: string): CsvTable {
  if (row < 0 || row >= table.rows.length || col < 0) {
    return table;
  }
  const format = table.format;
  const target = padTo(table.rows[row], col + 1, format);
  target.cells[col] = value;
  target.quoted[col] = format.quoteAll || needsQuote(value, format.delimiter);
  target.raw = null;
  const rows = table.rows.slice();
  rows[row] = target;
  return { rows, format };
}

export function insertRows(table: CsvTable, at: number, count: number): CsvTable {
  if (count <= 0) {
    return table;
  }
  // An empty file still needs somewhere to type, so its first row gets one cell.
  const width = Math.max(1, tableWidth(table));
  const index = Math.min(Math.max(0, at), table.rows.length);
  const made: CsvRow[] = [];
  for (let i = 0; i < count; i += 1) {
    made.push(blankRow(table.format, width));
  }
  return {
    rows: table.rows.slice(0, index).concat(made, table.rows.slice(index)),
    format: table.format,
  };
}

export function duplicateRows(table: CsvTable, targets: number[]): CsvTable {
  const set = indexSet(targets, table.rows.length);
  if (set.length === 0) {
    return table;
  }
  const rows: CsvRow[] = [];
  table.rows.forEach((row, index) => {
    rows.push(row);
    if (set.indexOf(index) !== -1) {
      // The copy keeps the original's raw: it serializes identically, so
      // duplicating a row rewrites nothing.
      rows.push({ cells: row.cells.slice(), quoted: row.quoted.slice(), raw: row.raw });
    }
  });
  return { rows, format: table.format };
}

export function deleteRows(table: CsvTable, targets: number[]): CsvTable {
  const set = indexSet(targets, table.rows.length);
  if (set.length === 0) {
    return table;
  }
  return {
    rows: table.rows.filter((_, index) => set.indexOf(index) === -1),
    format: table.format,
  };
}

export function insertColumn(table: CsvTable, at: number): CsvTable {
  if (at < 0) {
    return table;
  }
  const format = table.format;
  const rows = table.rows.map(row => {
    const next = padTo(row, at, format);
    next.cells.splice(at, 0, '');
    next.quoted.splice(at, 0, format.quoteAll);
    next.raw = null;
    return next;
  });
  return { rows, format };
}

export function deleteColumn(table: CsvTable, col: number): CsvTable {
  if (col < 0) {
    return table;
  }
  const rows = table.rows.map(row => {
    if (col >= row.cells.length) {
      return row;
    }
    const cells = row.cells.slice();
    const quoted = row.quoted.slice();
    cells.splice(col, 1);
    quoted.splice(col, 1);
    return { cells, quoted, raw: null };
  });
  return { rows, format: table.format };
}

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

export function compareValues(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function cellAt(row: CsvRow, col: number): string {
  return col >= 0 && col < row.cells.length ? row.cells[col] : '';
}

export function sortRows(
  table: CsvTable,
  col: number,
  direction: SortDirection,
  hasHeader: boolean
): CsvTable {
  const start = hasHeader && table.rows.length > 0 ? 1 : 0;
  const head = table.rows.slice(0, start);
  // Decorated with the original index so stability is a property of this code
  // rather than of the engine's sort.
  const data = table.rows.slice(start).map((row, index) => ({ row, index }));

  data.sort((a, b) => {
    const av = cellAt(a.row, col);
    const bv = cellAt(b.row, col);
    const aEmpty = av === '';
    const bEmpty = bv === '';
    if (aEmpty || bEmpty) {
      // Blanks sink in BOTH directions, so this branch is never negated.
      if (aEmpty && bEmpty) {
        return a.index - b.index;
      }
      return aEmpty ? 1 : -1;
    }
    const compared = compareValues(av, bv);
    if (compared !== 0) {
      return direction === 'desc' ? -compared : compared;
    }
    return a.index - b.index;
  });

  return { rows: head.concat(data.map(entry => entry.row)), format: table.format };
}

// Plain-substring replace of every occurrence. Hand-rolled because
// String.prototype.replaceAll is ES2021 and a RegExp would make the user's
// search text a pattern, which is explicitly out of scope for 1.32.0.
function replacePlain(value: string, find: string, replace: string, matchCase: boolean): string {
  const haystack = matchCase ? value : value.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) {
      return out + value.slice(i);
    }
    out += value.slice(i, at) + replace;
    i = at + needle.length;
  }
}

export function replaceAll(
  table: CsvTable,
  find: string,
  replace: string,
  col: number | undefined,
  matchCase: boolean,
  hasHeader: boolean
): CsvTable {
  if (find === '') {
    return table;
  }
  const format = table.format;
  const start = hasHeader && table.rows.length > 0 ? 1 : 0;
  let changedAny = false;

  const rows = table.rows.map((row, index) => {
    if (index < start) {
      return row;
    }
    const cells = row.cells.slice();
    const quoted = row.quoted.slice();
    let changed = false;
    for (let c = 0; c < cells.length; c += 1) {
      if (col !== undefined && c !== col) {
        continue;
      }
      const next = replacePlain(cells[c], find, replace, matchCase);
      if (next !== cells[c]) {
        cells[c] = next;
        quoted[c] = format.quoteAll || needsQuote(next, format.delimiter);
        changed = true;
      }
    }
    if (!changed) {
      return row;
    }
    changedAny = true;
    return { cells, quoted, raw: null };
  });

  return changedAny ? { rows, format } : table;
}

export function applyOp(table: CsvTable, op: CsvOp): CsvTable {
  switch (op.type) {
    case 'setCell':
      return setCell(table, op.row, op.col, op.value);
    case 'insertRows':
      return insertRows(table, op.at, op.count);
    case 'duplicateRows':
      return duplicateRows(table, op.rows);
    case 'deleteRows':
      return deleteRows(table, op.rows);
    case 'insertColumn':
      return insertColumn(table, op.at);
    case 'deleteColumn':
      return deleteColumn(table, op.col);
    case 'sort':
      return sortRows(table, op.col, op.direction, op.hasHeader);
    case 'replaceAll':
      return replaceAll(table, op.find, op.replace, op.col, op.matchCase, op.hasHeader);
    default:
      return table;
  }
}
