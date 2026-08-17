import { RawCpu, RawCpuLine, RawMem, RawLoad, RawNetIf, RawDisk, RawProc } from './types';

function num(s: string | undefined): number {
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

function cpuLine(fields: string[]): RawCpuLine {
  // /proc/stat cpu fields, in order: user nice system idle iowait irq softirq
  // steal guest guest_nice. guest and guest_nice are already counted inside
  // user and nice, so they are deliberately left out of the totals.
  const line: RawCpuLine = {
    user: num(fields[0]),
    nice: num(fields[1]),
    system: num(fields[2]),
    idle: num(fields[3]),
    iowait: num(fields[4]),
    irq: num(fields[5]),
    softirq: num(fields[6]),
    steal: num(fields[7]),
    totalJiffies: 0,
    busyJiffies: 0,
  };
  line.totalJiffies =
    line.user +
    line.nice +
    line.system +
    line.idle +
    line.iowait +
    line.irq +
    line.softirq +
    line.steal;
  line.busyJiffies = line.totalJiffies - line.idle - line.iowait;
  return line;
}

export function parseStat(text: string): RawCpu {
  const result: RawCpu = { total: cpuLine([]), cores: [] };
  text.split('\n').forEach(raw => {
    if (raw.substr(0, 3) !== 'cpu') {
      return;
    }
    const parts = raw.trim().split(/\s+/);
    const label = parts[0];
    const fields = parts.slice(1);
    if (label === 'cpu') {
      result.total = cpuLine(fields);
    } else {
      // Index by the label's own number so an offlined core leaves a hole
      // rather than shifting later cores into the wrong slot.
      result.cores[num(label.substr(3))] = cpuLine(fields);
    }
  });
  // Drop holes left by offlined cores so consumers get a dense array.
  result.cores = result.cores.filter(Boolean);
  return result;
}

export function parseMeminfo(text: string): RawMem {
  const kb: { [key: string]: number } = {};
  text.split('\n').forEach(line => {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) {
      kb[m[1]] = num(m[2]);
    }
  });
  const k = (key: string) => (kb[key] || 0) * 1024;
  return {
    total: k('MemTotal'),
    free: k('MemFree'),
    available: k('MemAvailable'),
    cached: k('Buffers') + k('Cached') + k('SReclaimable') - k('Shmem'),
    swapTotal: k('SwapTotal'),
    swapFree: k('SwapFree'),
  };
}

export function parseLoadavg(text: string): RawLoad {
  const parts = text.trim().split(/\s+/);
  return { one: num(parts[0]), five: num(parts[1]), fifteen: num(parts[2]) };
}

export function parseUptime(text: string): number {
  return num(text.trim().split(/\s+/)[0]);
}

export function parseNetDev(text: string): RawNetIf[] {
  const out: RawNetIf[] = [];
  text.split('\n').forEach(line => {
    const colon = line.indexOf(':');
    if (colon === -1) {
      return;
    }
    const name = line.slice(0, colon).trim();
    // A real interface name contains no whitespace or pipe, which is what
    // separates it from a header row that happens to hold a colon.
    if (!name || /[\s|]/.test(name)) {
      return;
    }
    const f = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    if (f.length < 9) {
      return;
    }
    out.push({ name, rxBytes: num(f[0]), txBytes: num(f[8]) });
  });
  return out;
}

export function parseDiskstats(text: string): RawDisk[] {
  const out: RawDisk[] = [];
  text.split('\n').forEach(line => {
    const f = line.trim().split(/\s+/);
    // major, minor, name, plus at least the 11 legacy stat fields.
    if (f.length < 14) {
      return;
    }
    out.push({
      name: f[2],
      reads: num(f[3]),
      readBytes: num(f[5]) * 512,
      readMs: num(f[6]),
      writes: num(f[7]),
      writeBytes: num(f[9]) * 512,
      writeMs: num(f[10]),
    });
  });
  return out;
}

export function parsePidStats(text: string): RawProc[] {
  const out: RawProc[] = [];
  text.split('\n').forEach(line => {
    const open = line.indexOf('(');
    // comm may itself contain '(' and ')', so the closing paren is the LAST one.
    const close = line.lastIndexOf(')');
    if (open === -1 || close === -1 || close < open) {
      return;
    }
    const pid = num(line.slice(0, open).trim());
    if (!pid) {
      return;
    }
    // Fields after comm are 3..52, so index 0 here is field 3 (state).
    const rest = line
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    if (rest.length < 22) {
      return;
    }
    out.push({
      pid,
      comm: line.slice(open + 1, close),
      utime: num(rest[11]),
      stime: num(rest[12]),
      threads: num(rest[17]),
      startTime: num(rest[19]),
      rssPages: num(rest[21]),
    });
  });
  return out;
}
