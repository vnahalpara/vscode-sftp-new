import {
  RawCpu,
  RawCpuLine,
  RawMem,
  RawNetIf,
  RawDisk,
  RawProc,
  CpuMetrics,
  MemMetrics,
  NetMetrics,
  DiskMetrics,
  ProcMetrics,
  LoadPoint,
  Snapshot,
  SampleState,
} from './types';
import { splitSections } from './frame';
import {
  parseStat,
  parseMeminfo,
  parseLoadavg,
  parseUptime,
  parseNetDev,
  parseDiskstats,
  parsePidStats,
} from './parse';

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

// A host with thousands of processes would bloat every postMessage, and the
// table only ever shows the busiest anyway.
export const MAX_PROCS = 200;

export interface ProcOpts {
  pageSize: number;
  // USER_HZ, effectively always 100 on Linux; injected so tests are explicit.
  clockTicks: number;
}

export function procMetrics(
  prev: RawProc[] | null,
  cur: RawProc[],
  elapsedMs: number,
  opts: ProcOpts
): ProcMetrics[] {
  // Identity is pid + startTime, so a recycled pid cannot inherit the previous
  // occupant's cpu time.
  const before: { [key: string]: RawProc } = {};
  (prev || []).forEach(p => {
    before[p.pid + ':' + p.startTime] = p;
  });

  const ticks = opts.clockTicks > 0 ? opts.clockTicks : 100;
  const elapsedTicks = (elapsedMs / 1000) * ticks;

  const rows = cur.map(p => {
    const p0 = before[p.pid + ':' + p.startTime];
    let cpuPct: number | null = null;
    if (p0 && elapsedTicks > 0) {
      const used = p.utime + p.stime - (p0.utime + p0.stime);
      // Deliberately not clamped at 100: this is percent of one core, and a
      // process spanning several cores should read above 100.
      cpuPct = used < 0 ? null : (used / elapsedTicks) * 100;
    }
    return {
      pid: p.pid,
      startTime: p.startTime,
      comm: p.comm,
      cpuPct,
      rssBytes: p.rssPages * opts.pageSize,
      threads: p.threads,
    };
  });

  rows.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.rssBytes - a.rssBytes);
  return rows.slice(0, MAX_PROCS);
}

// Fixed-capacity rolling window of load samples. Lives extension-side so chart
// history survives the webview being disposed while the tab is backgrounded.
export class History {
  private _points: LoadPoint[] = [];
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = Math.max(1, capacity);
  }

  push(point: LoadPoint): void {
    this._points.push(point);
    this._trim();
  }

  points(): LoadPoint[] {
    return this._points;
  }

  resize(capacity: number): void {
    this._capacity = Math.max(1, capacity);
    this._trim();
  }

  private _trim(): void {
    if (this._points.length > this._capacity) {
      this._points = this._points.slice(this._points.length - this._capacity);
    }
  }
}

export function emptyState(): SampleState {
  return { at: 0, cpu: null, net: null, disks: null, procs: null };
}

// Parse one framed block into a Snapshot, deriving every rate against `state`,
// then advance `state` to this sample. Returns null when the block carries
// nothing usable or arrives out of order.
export function buildSnapshot(
  state: SampleState,
  block: string,
  opts: ProcOpts
): Snapshot | null {
  const { at, sections } = splitSections(block);
  if (!sections.stat || !sections.mem) {
    return null;
  }
  // A non-monotonic timestamp means a duplicated or reordered block; deriving
  // rates from it would divide by zero or by a negative interval.
  if (state.at && at <= state.at) {
    return null;
  }

  const elapsedMs = state.at ? at - state.at : 0;
  const cpu = parseStat(sections.stat);
  const net = sections.net ? parseNetDev(sections.net) : [];
  const disks = sections.disk ? parseDiskstats(sections.disk) : [];
  const procs = sections.pids ? parsePidStats(sections.pids) : [];

  const snapshot: Snapshot = {
    at,
    cpu: cpuMetrics(state.cpu, cpu),
    mem: memMetrics(parseMeminfo(sections.mem)),
    load: sections.load ? parseLoadavg(sections.load) : { one: 0, five: 0, fifteen: 0 },
    uptimeSec: sections.up ? parseUptime(sections.up) : 0,
    net: netMetrics(state.net, net, elapsedMs),
    disks: diskMetrics(state.disks, disks, elapsedMs),
    procs: procMetrics(state.procs, procs, elapsedMs, opts),
  };

  state.at = at;
  state.cpu = cpu;
  state.net = net;
  state.disks = disks;
  state.procs = procs;

  return snapshot;
}
