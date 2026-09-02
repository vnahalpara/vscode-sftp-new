import { nextSortState } from '../sortState';

describe('nextSortState', () => {
  it('starts a fresh column ascending', () => {
    expect(nextSortState(null, 2)).toEqual({ col: 2, direction: 'asc' });
  });
  it('goes ascending then descending on the same column', () => {
    expect(nextSortState({ col: 2, direction: 'asc' }, 2)).toEqual({ col: 2, direction: 'desc' });
  });
  // The third click clears the INDICATOR only. The file is already sorted, and
  // un-sorting it would need an order nobody recorded.
  it('clears on the third click', () => {
    expect(nextSortState({ col: 2, direction: 'desc' }, 2)).toBeNull();
  });
  it('starts over when a different column is clicked', () => {
    expect(nextSortState({ col: 2, direction: 'desc' }, 5)).toEqual({ col: 5, direction: 'asc' });
  });
});
