import {
  RawCpu,
  RawCpuLine,
  RawMem,
  RawNetIf,
  RawDisk,
  CpuMetrics,
  MemMetrics,
  NetMetrics,
  DiskMetrics,
} from './types';

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

// Per-second rate from two counter samples. Returns null when the pair cannot
// produce a meaningful rate, so callers never show a fabricated zero.
function rate(prevVal: number | undefined, curVal: number, elapsedMs: number): number | null {
  if (prevVal === undefined || elapsedMs <= 0) {
    return null;
  }
  const delta = curVal - prevVal;
  if (delta < 0) {
    return null;
  }
  return delta / (elapsedMs / 1000);
}

function byName<T extends { name: string }>(rows: T[] | null): { [name: string]: T } {
  const map: { [name: string]: T } = {};
  (rows || []).forEach(r => {
    map[r.name] = r;
  });
  return map;
}

export function netMetrics(
  prev: RawNetIf[] | null,
  cur: RawNetIf[],
  elapsedMs: number
): NetMetrics[] {
  const before = byName(prev);
  return (
    cur
      // Loopback traffic says nothing about the server's network.
      .filter(i => i.name !== 'lo')
      .map(i => {
        const p = before[i.name];
        return {
          name: i.name,
          rxBps: rate(p && p.rxBytes, i.rxBytes, elapsedMs),
          txBps: rate(p && p.txBytes, i.txBytes, elapsedMs),
          rxTotal: i.rxBytes,
          txTotal: i.txBytes,
        };
      })
  );
}

export function diskMetrics(
  prev: RawDisk[] | null,
  cur: RawDisk[],
  elapsedMs: number
): DiskMetrics[] {
  const before = byName(prev);
  return cur.map(d => {
    const p = before[d.name];
    const readIops = rate(p && p.reads, d.reads, elapsedMs);
    const writeIops = rate(p && p.writes, d.writes, elapsedMs);
    // Latency is service time per completed io over the interval, not a
    // per-second rate, so it comes from the raw deltas.
    const readOps = p ? d.reads - p.reads : 0;
    const writeOps = p ? d.writes - p.writes : 0;
    const readMs = p ? d.readMs - p.readMs : 0;
    const writeMs = p ? d.writeMs - p.writeMs : 0;
    return {
      name: d.name,
      readBps: rate(p && p.readBytes, d.readBytes, elapsedMs),
      writeBps: rate(p && p.writeBytes, d.writeBytes, elapsedMs),
      readIops,
      writeIops,
      readLatencyMs: readIops === null ? null : readOps > 0 ? readMs / readOps : 0,
      writeLatencyMs: writeIops === null ? null : writeOps > 0 ? writeMs / writeOps : 0,
      readTotal: d.readBytes,
      writeTotal: d.writeBytes,
    };
  });
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
