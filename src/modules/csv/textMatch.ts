// Plain (non-regex) substring search shared by the host's replaceAll and the
// webview's search box, so the rows the grid FILTERS and the spans it
// HIGHLIGHTS can never disagree.
//
// The rule this file exists to enforce: never search a folded copy of the
// whole string. `'İ'.toLowerCase()` is two code units, so an offset
// found in `value.toLowerCase()` does not index `value`; slicing the original
// at it corrupted the text ('İstanbul' + replace 'stan' came out as
// 'İsSTANul'). Comparing one same-length window at a time keeps every
// offset an offset into `value` itself.
//
// The cost is that a case-insensitive match whose folded form CHANGES LENGTH
// is not found at all -- 'istanbul' does not match 'İstanbul'. Missing a
// match is a search that finds less; slicing at a wrong offset is data loss.

// Index of the first occurrence of `needle` in `value` at or after `from`, or
// -1. An empty needle never matches, because "replace nothing" is not an edit.
export function findPlain(
  value: string,
  needle: string,
  matchCase: boolean,
  from: number
): number {
  if (needle === '') {
    return -1;
  }
  if (matchCase) {
    return value.indexOf(needle, from);
  }
  const folded = needle.toLowerCase();
  const last = value.length - needle.length;
  for (let i = from < 0 ? 0 : from; i <= last; i += 1) {
    if (value.substr(i, needle.length).toLowerCase() === folded) {
      return i;
    }
  }
  return -1;
}
