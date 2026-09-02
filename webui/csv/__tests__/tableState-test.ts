import { applyOpToRows, rowsWidth } from '../tableState';

describe('rowsWidth', () => {
  it('is the widest row', () => {
    expect(rowsWidth([['a'], ['a', 'b', 'c'], ['a', 'b']])).toBe(3);
  });
  it('is 0 with no rows', () => {
    expect(rowsWidth([])).toBe(0);
  });
});

// These mirror model-test one for one. The optimistic view has to land on
// exactly what the host will send back, or the grid flickers on every ack.
describe('applyOpToRows', () => {
  it('sets a cell', () => {
    expect(applyOpToRows([['a', 'b']], { type: 'setCell', row: 0, col: 1, value: 'z' })).toEqual([
      ['a', 'z'],
    ]);
  });

  it('pads a row when the column is beyond its end', () => {
    expect(applyOpToRows([['a']], { type: 'setCell', row: 0, col: 3, value: 'z' })).toEqual([
      ['a', '', '', 'z'],
    ]);
  });

  it('inserts blank rows of the table width', () => {
    expect(applyOpToRows([['a', 'b'], ['c', 'd']], { type: 'insertRows', at: 1, count: 2 })).toEqual([
      ['a', 'b'], ['', ''], ['', ''], ['c', 'd'],
    ]);
  });

  it('gives an empty table one cell to start from', () => {
    expect(applyOpToRows([], { type: 'insertRows', at: 0, count: 1 })).toEqual([['']]);
  });

  it('puts each duplicate directly after its original', () => {
    expect(applyOpToRows([['a'], ['b'], ['c']], { type: 'duplicateRows', rows: [0, 2] })).toEqual([
      ['a'], ['a'], ['b'], ['c'], ['c'],
    ]);
  });

  it('deletes rows', () => {
    expect(applyOpToRows([['a'], ['b'], ['c']], { type: 'deleteRows', rows: [0, 2] })).toEqual([['b']]);
  });

  it('inserts a column, padding short rows to the index first', () => {
    expect(applyOpToRows([['a', 'b', 'c'], ['x']], { type: 'insertColumn', at: 2 })).toEqual([
      ['a', 'b', '', 'c'],
      ['x', '', ''],
    ]);
  });

  it('deletes a column only from the rows that have it', () => {
    expect(applyOpToRows([['a', 'b', 'c'], ['x']], { type: 'deleteColumn', col: 2 })).toEqual([
      ['a', 'b'],
      ['x'],
    ]);
  });

  it('sorts, leaving the header where it is', () => {
    const rows = [['n'], ['10'], ['9'], ['100']];
    expect(applyOpToRows(rows, { type: 'sort', col: 0, direction: 'asc', hasHeader: true })).toEqual([
      ['n'], ['9'], ['10'], ['100'],
    ]);
  });

  it('sorts descending with empties still at the bottom', () => {
    const rows = [['k'], ['b'], [''], ['a']];
    expect(applyOpToRows(rows, { type: 'sort', col: 0, direction: 'desc', hasHeader: true })).toEqual([
      ['k'], ['b'], ['a'], [''],
    ]);
  });

  it('replaces in every data cell, leaving the header alone', () => {
    const rows = [['cat'], ['a cat'], ['no']];
    expect(
      applyOpToRows(rows, {
        type: 'replaceAll',
        find: 'cat',
        replace: 'fox',
        matchCase: true,
        hasHeader: true,
      })
    ).toEqual([['cat'], ['a fox'], ['no']]);
  });

  it('replaces within one column scope', () => {
    const rows = [['h1', 'h2'], ['cat', 'cat']];
    expect(
      applyOpToRows(rows, {
        type: 'replaceAll',
        find: 'cat',
        replace: 'fox',
        col: 1,
        matchCase: true,
        hasHeader: true,
      })
    ).toEqual([['h1', 'h2'], ['cat', 'fox']]);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [['a']];
    applyOpToRows(rows, { type: 'setCell', row: 0, col: 0, value: 'z' });
    expect(rows).toEqual([['a']]);
  });
});
