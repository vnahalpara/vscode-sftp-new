import { filterRows, highlightRanges, matchCell } from '../search';

describe('matchCell', () => {
  it('matches a substring case-insensitively by default', () => {
    expect(matchCell('Banana', 'nan', false)).toBe(true);
    expect(matchCell('BANANA', 'nan', false)).toBe(true);
  });
  it('respects case when asked', () => {
    expect(matchCell('BANANA', 'nan', true)).toBe(false);
    expect(matchCell('banana', 'nan', true)).toBe(true);
  });
  it('never matches an empty query', () => {
    expect(matchCell('anything', '', false)).toBe(false);
  });
  it('does not match an empty cell', () => {
    expect(matchCell('', 'a', false)).toBe(false);
  });
});

describe('highlightRanges', () => {
  it('finds one match', () => {
    expect(highlightRanges('banana', 'nan', false)).toEqual([{ start: 2, end: 5 }]);
  });
  it('finds every non-overlapping match', () => {
    expect(highlightRanges('aXaXa', 'a', false)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });
  it('finds matches in the other case when matchCase is off', () => {
    expect(highlightRanges('Cat cat', 'cat', false)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });
  it('finds nothing for an empty query', () => {
    expect(highlightRanges('banana', '', false)).toEqual([]);
  });
  it('finds nothing when there is no match', () => {
    expect(highlightRanges('banana', 'zz', false)).toEqual([]);
  });
});

describe('filterRows', () => {
  const ROWS = [
    ['name', 'city'],
    ['Ada', 'London'],
    ['Bob', 'Lyon'],
    ['Cy', 'Berlin'],
  ];

  it('returns every data row for an empty query', () => {
    expect(filterRows(ROWS, '', false, null, true)).toEqual([1, 2, 3]);
  });

  // With the header toggle on, row 0 is drawn as the header and is never a
  // search result.
  it('never returns row 0 when the first row is a header', () => {
    expect(filterRows(ROWS, 'name', false, null, true)).toEqual([]);
  });

  it('returns row 0 like any other row when the header toggle is off', () => {
    expect(filterRows(ROWS, 'name', false, null, false)).toEqual([0]);
  });

  // No row has an 'l' in column 0, so every hit here comes from column 1 --
  // including Berlin's, which matches case-insensitively.
  it('returns rows with a match in any column', () => {
    expect(filterRows(ROWS, 'L', false, null, true)).toEqual([1, 2, 3]);
  });

  it('scopes to one column when asked', () => {
    expect(filterRows(ROWS, 'Ly', false, 1, true)).toEqual([2]);
  });

  it('finds nothing in a column no row is that wide for', () => {
    expect(filterRows(ROWS, 'a', false, 9, true)).toEqual([]);
  });

  it('respects case', () => {
    expect(filterRows(ROWS, 'ADA', true, null, true)).toEqual([]);
    expect(filterRows(ROWS, 'Ada', true, null, true)).toEqual([1]);
  });

  it('returns document indices, not display positions', () => {
    expect(filterRows(ROWS, 'Berlin', false, null, true)).toEqual([3]);
  });
});
