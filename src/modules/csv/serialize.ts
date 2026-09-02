import { CsvRow, CsvTable } from './types';

export function serializeCell(value: string, quoted: boolean): string {
  return quoted ? `"${value.replace(/"/g, '""')}"` : value;
}

function serializeRow(row: CsvRow, delimiter: string): string {
  // A row nobody edited is written back byte-for-byte. This is what keeps a
  // one-cell edit to a 10,000-row file a one-line diff, and it is why `raw`
  // exists at all.
  if (row.raw !== null) {
    return row.raw;
  }
  return row.cells
    .map((cell, index) => serializeCell(cell, row.quoted[index] === true))
    .join(delimiter);
}

export function serializeCsv(table: CsvTable): string {
  const { rows, format } = table;
  const body = rows.map(row => serializeRow(row, format.delimiter)).join(format.eol);
  // No trailing eol on a file with no rows: deleting every row should leave an
  // empty file, not a lone newline.
  return format.finalNewline && rows.length > 0 ? body + format.eol : body;
}
