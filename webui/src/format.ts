// Pure presentation helpers. This file is compiled by tsc with lib es6 and NO
// DOM lib, so it must never touch a browser global — that is also why fmtAgo
// takes `now` rather than calling Date.now().

const DASH = '—';
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && isFinite(n);
}

export function fmtBytes(n: number | null | undefined, digits: number = 1): string {
  if (!isNum(n)) {
    return DASH;
  }
  let value = n;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

// A null rate means the delta was not computable, not that the device is idle.
// Rendering a zero here would be an outright lie to whoever is reading it.
export function fmtRate(n: number | null | undefined): string {
  return isNum(n) ? `${fmtBytes(n)}/s` : DASH;
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (!isNum(seconds)) {
    return DASH;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) {
    return `${d}d ${h}h`;
  }
  if (h) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function fmtAgo(ts: number | null | undefined, now: number): string {
  if (!isNum(ts)) {
    return 'never';
  }
  // Timestamps come from the SERVER clock. If the workstation clock lags, the
  // difference goes negative; clamp rather than render "-3s ago".
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtPct(n: number | null | undefined, digits: number = 1): string {
  return isNum(n) ? `${n.toFixed(digits)}%` : DASH;
}

export function pct(used: number, total: number): number | null {
  return total ? (used / total) * 100 : null;
}

export function toneForPct(v: number | null): 'ok' | 'warn' | 'bad' | '' {
  if (!isNum(v)) {
    return '';
  }
  if (v >= 90) {
    return 'bad';
  }
  if (v >= 70) {
    return 'warn';
  }
  return 'ok';
}
