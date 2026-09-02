// Pure search logic, kept out of the components so jest can reach it. The
// grid's search FILTERS rows rather than scrolling between hits, which is why
// this file returns row indices rather than a cursor.

export interface MatchRange {
  start: number;
  end: number;
}

function fold(value: string, matchCase: boolean): string {
  return matchCase ? value : value.toLowerCase();
}

export function matchCell(value: string, query: string, matchCase: boolean): boolean {
  if (query === '') {
    return false;
  }
  return fold(value, matchCase).indexOf(fold(query, matchCase)) !== -1;
}

export function highlightRanges(value: string, query: string, matchCase: boolean): MatchRange[] {
  const out: MatchRange[] = [];
  if (query === '') {
    return out;
  }
  const haystack = fold(value, matchCase);
  const needle = fold(query, matchCase);
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) {
      return out;
    }
    out.push({ start: at, end: at + needle.length });
    i = at + needle.length;
  }
}

// Document row indices of the rows to show. An empty query shows everything,
// so the caller can use one code path whether or not a search is running.
// `skipFirstRow` is the header toggle: with it on, row 0 is drawn as the
// header and is never a result.
export function filterRows(
  rows: string[][],
  query: string,
  matchCase: boolean,
  col: number | null,
  skipFirstRow: boolean
): number[] {
  const out: number[] = [];
  for (let r = skipFirstRow ? 1 : 0; r < rows.length; r += 1) {
    if (query === '') {
      out.push(r);
      continue;
    }
    const row = rows[r];
    if (col !== null) {
      if (col < row.length && matchCell(row[col], query, matchCase)) {
        out.push(r);
      }
      continue;
    }
    for (let c = 0; c < row.length; c += 1) {
      if (matchCell(row[c], query, matchCase)) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}
