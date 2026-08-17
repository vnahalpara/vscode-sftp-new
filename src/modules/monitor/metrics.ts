import { RawCpu, RawCpuLine, RawMem, CpuMetrics, MemMetrics } from './types';

function pct(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  const p = (part / whole) * 100;
  // Jiffy counters are sampled non-atomically across cores, so a delta can land
  // a hair over 100%. Clamp rather than render an impossible number.
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

function busyPct(prev: RawCpuLine, cur: RawCpuLine): number {
  return pct(cur.busyJiffies - prev.busyJiffies, cur.totalJiffies - prev.totalJiffies);
}

// Returns null when the two samples are not comparable: no previous sample,
// counters that moved backwards (reboot or wrap), or a changed core count.
// Emitting a delta in any of those cases produces a visible fake spike.
export function cpuMetrics(prev: RawCpu | null, cur: RawCpu): CpuMetrics | null {
  if (!prev) {
    return null;
  }
  if (prev.cores.length !== cur.cores.length) {
    return null;
  }
  if (
    cur.total.totalJiffies < prev.total.totalJiffies ||
    cur.total.busyJiffies < prev.total.busyJiffies
  ) {
    return null;
  }

  const span = cur.total.totalJiffies - prev.total.totalJiffies;
  const delta = (key: 'user' | 'system' | 'nice' | 'iowait' | 'steal') =>
    pct(cur.total[key] - prev.total[key], span);

  return {
    total: busyPct(prev.total, cur.total),
    cores: cur.cores.map((core, i) => busyPct(prev.cores[i], core)),
    breakdown: {
      user: delta('user'),
      system: delta('system'),
      nice: delta('nice'),
      iowait: delta('iowait'),
      steal: delta('steal'),
    },
  };
}

// Memory is absolute rather than a rate, so it needs no previous sample.
export function memMetrics(raw: RawMem): MemMetrics {
  const cached = raw.cached > 0 ? raw.cached : 0;
  const used = Math.max(0, raw.total - raw.free - cached);
  const swapUsed = Math.max(0, raw.swapTotal - raw.swapFree);
  return {
    total: raw.total,
    used,
    cached,
    free: raw.free,
    usedPct: pct(used, raw.total),
    cachedPct: pct(cached, raw.total),
    freePct: pct(raw.free, raw.total),
    swapTotal: raw.swapTotal,
    swapUsed,
    swapPct: pct(swapUsed, raw.swapTotal),
  };
}
