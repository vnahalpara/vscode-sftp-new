import { SortDirection } from '../../src/modules/csv/protocol';

export interface SortState {
  col: number;
  direction: SortDirection;
}

// Click a header: ascending, descending, then clear. Clearing removes the
// indicator only -- the rows are already in that order in the file, and
// putting them back would need an original order nobody recorded.
export function nextSortState(current: SortState | null, col: number): SortState | null {
  if (current === null || current.col !== col) {
    return { col, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { col, direction: 'desc' };
  }
  return null;
}
