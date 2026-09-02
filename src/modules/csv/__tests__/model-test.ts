import { delimiterLabel, eolLabel } from '../protocol';
import {
  applyOp,
  compareValues,
  deleteColumn,
  deleteRows,
  duplicateRows,
  insertColumn,
  insertRows,
  replaceAll,
  setCell,
  sortRows,
  tableRows,
  tableWidth,
} from '../model';
import { serializeCsv } from '../serialize';
import { CsvFormat, CsvTable } from '../types';

const COMMA: CsvFormat = { delimiter: ',', eol: '\n', finalNewline: true, quoteAll: false };
const QUOTE_ALL: CsvFormat = { ...COMMA, quoteAll: true };

// Build a table whose rows all still carry their raw text, so every test can
// ask the sharpest question there is: which rows LOST it.
function tableOf(rows: string[][], format: CsvFormat = COMMA): CsvTable {
  return {
    rows: rows.map(cells => ({
      cells: cells.slice(),
      quoted: cells.map(() => false),
      raw: cells.join(format.delimiter),
    })),
    format,
  };
}

const raws = (table: CsvTable) => table.rows.map(row => row.raw);

describe('tableWidth', () => {
  it('is the widest row', () => {
    expect(tableWidth(tableOf([['a'], ['a', 'b', 'c'], ['a', 'b']]))).toBe(3);
  });
  it('is 0 for an empty table', () => {
    expect(tableWidth(tableOf([]))).toBe(0);
  });
});

describe('tableRows', () => {
  it('is the cells, ragged as they are', () => {
    expect(tableRows(tableOf([['a', 'b'], ['c']]))).toEqual([['a', 'b'], ['c']]);
  });
  it('copies, so the caller cannot reach back into the table', () => {
    const table = tableOf([['a']]);
    tableRows(table)[0][0] = 'mutated';
    expect(table.rows[0].cells[0]).toBe('a');
  });
});

describe('setCell', () => {
  it('sets the value', () => {
    const next = setCell(tableOf([['a', 'b']]), 0, 1, 'z');
    expect(next.rows[0].cells).toEqual(['a', 'z']);
  });

  it('rebuilds only that row', () => {
    const next = setCell(tableOf([['a'], ['b'], ['c']]), 1, 0, 'z');
    expect(raws(next)).toEqual(['a', null, 'c']);
  });

  it('pads the row with empty cells when the column is beyond its end', () => {
    const next = setCell(tableOf([['a']]), 0, 3, 'z');
    expect(next.rows[0].cells).toEqual(['a', '', '', 'z']);
  });

  it('quotes the new value when it needs it', () => {
    const next = setCell(tableOf([['a', 'b']]), 0, 1, 'x,y');
    expect(next.rows[0].quoted).toEqual([false, true]);
  });

  it('quotes the new value in a quote-all file even when it does not need it', () => {
    const next = setCell(tableOf([['a', 'b']], QUOTE_ALL), 0, 1, 'z');
    expect(next.rows[0].quoted).toEqual([false, true]);
  });

  it('leaves other cells quoting alone', () => {
    const table = tableOf([['a', 'b']]);
    table.rows[0].quoted = [true, false];
    expect(setCell(table, 0, 1, 'z').rows[0].quoted).toEqual([true, false]);
  });

  it('does not mutate the table it was given', () => {
    const table = tableOf([['a']]);
    setCell(table, 0, 0, 'z');
    expect(table.rows[0].cells).toEqual(['a']);
    expect(table.rows[0].raw).toBe('a');
  });

  it('ignores a row index the table does not have', () => {
    const table = tableOf([['a']]);
    expect(setCell(table, 5, 0, 'z')).toBe(table);
  });
});

describe('insertRows', () => {
  it('inserts blank rows of the table width at the index', () => {
    const next = insertRows(tableOf([['a', 'b'], ['c', 'd']]), 1, 2);
    expect(tableRows(next)).toEqual([['a', 'b'], ['', ''], ['', ''], ['c', 'd']]);
  });

  it('rebuilds only the new rows', () => {
    expect(raws(insertRows(tableOf([['a'], ['b']]), 1, 1))).toEqual(['a', null, 'b']);
  });

  it('quotes the new blanks in a quote-all file', () => {
    const next = insertRows(tableOf([['a', 'b']], QUOTE_ALL), 1, 1);
    expect(next.rows[1].quoted).toEqual([true, true]);
  });

  it('gives an empty table one cell to start from', () => {
    expect(tableRows(insertRows(tableOf([]), 0, 1))).toEqual([['']]);
  });

  it('clamps an index past the end to the end', () => {
    expect(tableRows(insertRows(tableOf([['a']]), 99, 1))).toEqual([['a'], ['']]);
  });
});

describe('duplicateRows', () => {
  it('puts each copy directly after its original', () => {
    expect(tableRows(duplicateRows(tableOf([['a'], ['b'], ['c']]), [0, 2]))).toEqual([
      ['a'], ['a'], ['b'], ['c'], ['c'],
    ]);
  });

  // The copy is byte-identical to the original when written, which is why it
  // keeps the original's raw rather than being rebuilt.
  it('keeps raw on the copies so nothing is rebuilt', () => {
    const next = duplicateRows(tableOf([['a'], ['b']]), [0]);
    expect(raws(next)).toEqual(['a', 'a', 'b']);
  });

  it('copies the cells rather than sharing them', () => {
    const next = duplicateRows(tableOf([['a']]), [0]);
    expect(next.rows[0].cells).not.toBe(next.rows[1].cells);
  });

  it('ignores duplicates and out-of-range indices', () => {
    expect(tableRows(duplicateRows(tableOf([['a']]), [0, 0, 7]))).toEqual([['a'], ['a']]);
  });
});

describe('deleteRows', () => {
  it('removes the rows', () => {
    expect(tableRows(deleteRows(tableOf([['a'], ['b'], ['c']]), [0, 2]))).toEqual([['b']]);
  });
  it('rebuilds nothing', () => {
    expect(raws(deleteRows(tableOf([['a'], ['b']]), [0]))).toEqual(['b']);
  });
  it('does nothing for an empty selection', () => {
    const table = tableOf([['a']]);
    expect(deleteRows(table, [])).toBe(table);
  });
});

describe('insertColumn', () => {
  it('inserts an empty cell at the index in every row', () => {
    expect(tableRows(insertColumn(tableOf([['a', 'b'], ['c', 'd']]), 1))).toEqual([
      ['a', '', 'b'],
      ['c', '', 'd'],
    ]);
  });

  it('pads a short row out to the index first', () => {
    expect(tableRows(insertColumn(tableOf([['a', 'b', 'c'], ['x']]), 2))).toEqual([
      ['a', 'b', '', 'c'],
      ['x', '', ''],
    ]);
  });

  it('rebuilds every row', () => {
    expect(raws(insertColumn(tableOf([['a'], ['b']]), 0))).toEqual([null, null]);
  });

  it('quotes the new cell in a quote-all file', () => {
    expect(insertColumn(tableOf([['a']], QUOTE_ALL), 0).rows[0].quoted).toEqual([true, false]);
  });
});

describe('deleteColumn', () => {
  it('removes the column from every row that has it', () => {
    expect(tableRows(deleteColumn(tableOf([['a', 'b', 'c'], ['x', 'y', 'z']]), 1))).toEqual([
      ['a', 'c'],
      ['x', 'z'],
    ]);
  });

  it('leaves a row that never had the column alone, raw and all', () => {
    const next = deleteColumn(tableOf([['a', 'b', 'c'], ['x']]), 2);
    expect(tableRows(next)).toEqual([['a', 'b'], ['x']]);
    expect(raws(next)).toEqual([null, 'x']);
  });
});

describe('compareValues', () => {
  it('compares two numbers numerically, not as text', () => {
    expect(compareValues('9', '10')).toBeLessThan(0);
  });
  it('compares decimals and negatives', () => {
    expect(compareValues('-2.5', '1')).toBeLessThan(0);
    expect(compareValues('1.5', '1.25')).toBeGreaterThan(0);
  });
  it('tolerates surrounding whitespace on a number', () => {
    expect(compareValues(' 2 ', '10')).toBeLessThan(0);
  });
  it('falls back to a case-insensitive text compare', () => {
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
    expect(compareValues('Apple', 'apple')).toBe(0);
  });
  it('compares mixed text and numbers as text', () => {
    expect(compareValues('10', 'a')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  const NUMBERS = () => tableOf([['n'], ['10'], ['9'], ['100']]);

  it('sorts data rows ascending and leaves the header where it is', () => {
    expect(tableRows(sortRows(NUMBERS(), 0, 'asc', true))).toEqual([['n'], ['9'], ['10'], ['100']]);
  });

  it('sorts descending', () => {
    expect(tableRows(sortRows(NUMBERS(), 0, 'desc', true))).toEqual([['n'], ['100'], ['10'], ['9']]);
  });

  it('sorts row 0 too when the header toggle is off', () => {
    // All-numeric on purpose: the comparator is numeric for two numbers and
    // locale for anything else, so a table mixing the two has no order this
    // test could assert without depending on comparison order.
    const table = tableOf([['3'], ['1'], ['2']]);
    expect(tableRows(sortRows(table, 0, 'asc', false))).toEqual([['1'], ['2'], ['3']]);
  });

  it('keeps every row raw, because sorting only moves rows', () => {
    expect(raws(sortRows(NUMBERS(), 0, 'asc', true))).toEqual(['n', '9', '10', '100']);
  });

  it('is stable: equal keys keep their original order', () => {
    const table = tableOf([['k', 'v'], ['a', '1'], ['a', '2'], ['a', '3']]);
    expect(tableRows(sortRows(table, 0, 'asc', true)).slice(1).map(row => row[1])).toEqual(
      ['1', '2', '3']
    );
  });

  it('is stable in the descending direction too', () => {
    const table = tableOf([['k', 'v'], ['a', '1'], ['a', '2'], ['a', '3']]);
    expect(tableRows(sortRows(table, 0, 'desc', true)).slice(1).map(row => row[1])).toEqual(
      ['1', '2', '3']
    );
  });

  it('sends empty cells to the bottom ascending', () => {
    const table = tableOf([['k'], ['b'], [''], ['a']]);
    expect(tableRows(sortRows(table, 0, 'asc', true))).toEqual([['k'], ['a'], ['b'], ['']]);
  });

  // Not negated with the rest of the comparator: a blank is missing data and
  // belongs out of the way whichever way the column is sorted.
  it('sends empty cells to the bottom descending as well', () => {
    const table = tableOf([['k'], ['b'], [''], ['a']]);
    expect(tableRows(sortRows(table, 0, 'desc', true))).toEqual([['k'], ['b'], ['a'], ['']]);
  });

  it('treats a missing cell on a ragged row as empty', () => {
    const table = tableOf([['k', 'v'], ['x'], ['a', 'b']]);
    expect(tableRows(sortRows(table, 1, 'asc', true))).toEqual([['k', 'v'], ['a', 'b'], ['x']]);
  });

  it('does nothing dangerous to an empty table', () => {
    expect(tableRows(sortRows(tableOf([]), 0, 'asc', true))).toEqual([]);
  });
});

describe('replaceAll', () => {
  const T = () => tableOf([['name', 'note'], ['cat', 'a cat here'], ['dog', 'no match']]);

  it('replaces every occurrence in every data cell', () => {
    const next = replaceAll(T(), 'cat', 'fox', undefined, true, true);
    expect(tableRows(next)).toEqual([['name', 'note'], ['fox', 'a fox here'], ['dog', 'no match']]);
  });

  it('replaces repeated occurrences within one cell', () => {
    const table = tableOf([['h'], ['a a a']]);
    expect(tableRows(replaceAll(table, 'a', 'b', undefined, true, true))).toEqual([['h'], ['b b b']]);
  });

  it('rebuilds only the rows that matched', () => {
    expect(raws(replaceAll(T(), 'cat', 'fox', undefined, true, true))).toEqual([
      'name,note',
      null,
      'dog,no match',
    ]);
  });

  it('never touches row 0 when the header toggle is on', () => {
    const table = tableOf([['cat'], ['cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, true, true))).toEqual([['cat'], ['fox']]);
  });

  it('treats row 0 as data when the header toggle is off', () => {
    const table = tableOf([['cat'], ['cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, true, false))).toEqual([['fox'], ['fox']]);
  });

  it('honours a column scope', () => {
    const next = replaceAll(T(), 'cat', 'fox', 1, true, true);
    expect(tableRows(next)).toEqual([['name', 'note'], ['cat', 'a fox here'], ['dog', 'no match']]);
  });

  it('matches case-insensitively when asked, and keeps the replacement verbatim', () => {
    const table = tableOf([['h'], ['CAT and cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, false, true))).toEqual([
      ['h'],
      ['fox and fox'],
    ]);
  });

  it('does not match a different case when matchCase is on', () => {
    const table = tableOf([['h'], ['CAT']]);
    expect(replaceAll(table, 'cat', 'fox', undefined, true, true)).toEqual(table);
  });

  it('re-quotes a replaced cell that now needs quoting', () => {
    const table = tableOf([['h'], ['ab']]);
    expect(replaceAll(table, 'b', ',b', undefined, true, true).rows[1].quoted).toEqual([true]);
  });

  it('does nothing at all for an empty search', () => {
    const table = T();
    expect(replaceAll(table, '', 'x', undefined, true, true)).toBe(table);
  });

  it('returns the same table when nothing matched', () => {
    const table = T();
    expect(replaceAll(table, 'zebra', 'x', undefined, true, true)).toBe(table);
  });
});

describe('applyOp', () => {
  it('dispatches setCell', () => {
    const next = applyOp(tableOf([['a']]), { type: 'setCell', row: 0, col: 0, value: 'z' });
    expect(tableRows(next)).toEqual([['z']]);
  });
  it('dispatches insertRows', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'insertRows', at: 0, count: 1 }))).toEqual([
      [''], ['a'],
    ]);
  });
  it('dispatches duplicateRows', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'duplicateRows', rows: [0] }))).toEqual([
      ['a'], ['a'],
    ]);
  });
  it('dispatches deleteRows', () => {
    expect(tableRows(applyOp(tableOf([['a'], ['b']]), { type: 'deleteRows', rows: [0] }))).toEqual([['b']]);
  });
  it('dispatches insertColumn', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'insertColumn', at: 0 }))).toEqual([['', 'a']]);
  });
  it('dispatches deleteColumn', () => {
    expect(tableRows(applyOp(tableOf([['a', 'b']]), { type: 'deleteColumn', col: 0 }))).toEqual([['b']]);
  });
  it('dispatches sort', () => {
    const table = tableOf([['h'], ['b'], ['a']]);
    expect(
      tableRows(applyOp(table, { type: 'sort', col: 0, direction: 'asc', hasHeader: true }))
    ).toEqual([['h'], ['a'], ['b']]);
  });
  it('dispatches replaceAll', () => {
    const table = tableOf([['h'], ['cat']]);
    const op = { type: 'replaceAll' as 'replaceAll', find: 'cat', replace: 'fox', matchCase: true, hasHeader: true };
    expect(tableRows(applyOp(table, op))).toEqual([['h'], ['fox']]);
  });
});

describe('an operation serialized back to text', () => {
  // The end-to-end shape of what the provider does: apply one op, write the
  // file, and change nothing else.
  it('changes only the edited row', () => {
    const table = tableOf([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    const next = applyOp(table, { type: 'setCell', row: 1, col: 1, value: 'Z,Z' });
    expect(serializeCsv(next)).toBe('a,b\nc,"Z,Z"\ne,f\n');
  });
});

describe('the protocol labels', () => {
  it('names every delimiter', () => {
    expect(delimiterLabel(',')).toBe('Comma');
    expect(delimiterLabel(';')).toBe('Semicolon');
    expect(delimiterLabel('\t')).toBe('Tab');
    expect(delimiterLabel('|')).toBe('Pipe');
  });
  it('names both line endings', () => {
    expect(eolLabel('\n')).toBe('LF');
    expect(eolLabel('\r\n')).toBe('CRLF');
  });
});
