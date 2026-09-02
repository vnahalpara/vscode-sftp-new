import { applyOp } from '../../src/modules/csv/model';
import { CsvOp } from '../../src/modules/csv/protocol';
import { CsvFormat, CsvTable } from '../../src/modules/csv/types';

// The optimistic view must land on EXACTLY the rows the host will send back,
// so it runs the host's own operations rather than a second implementation of
// them. Quoting and raw text do not exist in a view of the data, so a
// throwaway format stands in for them and is thrown away again.
const VIEW_FORMAT: CsvFormat = {
  delimiter: ',',
  eol: '\n',
  finalNewline: true,
  quoteAll: false,
};

export function rowsWidth(rows: string[][]): number {
  let width = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].length > width) {
      width = rows[i].length;
    }
  }
  return width;
}

export function applyOpToRows(rows: string[][], op: CsvOp): string[][] {
  const table: CsvTable = {
    rows: rows.map(cells => ({
      cells: cells.slice(),
      quoted: cells.map(() => false),
      raw: null,
    })),
    format: VIEW_FORMAT,
  };
  return applyOp(table, op).rows.map(row => row.cells.slice());
}
