// Resolve which tables are dumped structure-only by matching the live table list against
// glob patterns (`*` = any). Pure + testable; avoids SQL LIKE escaping over the exec transport.
export function globToRegExp(pattern: string): RegExp {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + re + '$');
}

export function resolveNoDataTables(allTables: string[], patterns: string[], extra: string[]): string[] {
  const matchers = patterns.map(globToRegExp);
  const set = new Set<string>();
  for (const t of allTables) {
    if (matchers.some(m => m.test(t))) {
      set.add(t);
    }
  }
  for (const e of extra) {
    set.add(e);
  }
  return Array.from(set).sort();
}

export function fmtBytes(n: number): string {
  if (!n) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}
