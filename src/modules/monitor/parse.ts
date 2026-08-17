import {
  RawCpu,
  RawCpuLine,
  RawMem,
  RawLoad,
  RawNetIf,
  RawDisk,
  RawProc,
  RawMount,
  RawPsRow,
  RawAddr,
} from './types';

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

// Filesystems that are memory, an image, or a container overlay rather than
// storage an operator can run out of.
const PSEUDO_FS = [
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'overlay',
  'proc',
  'sysfs',
  'ramfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'autofs',
  'efivarfs',
];

export function parseDf(text: string): RawMount[] {
  const out: RawMount[] = [];
  text.split('\n').forEach((line, i) => {
    if (i === 0 || !line.trim()) {
      return;
    }
    // Six fixed columns, then the mount point — which may contain spaces, so it
    // is everything remaining rather than a seventh whitespace-delimited field.
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) {
      return;
    }
    const fstype = m[2];
    if (PSEUDO_FS.indexOf(fstype) !== -1) {
      return;
    }
    const device = m[1];
    out.push({
      device,
      deviceName: device.slice(device.lastIndexOf('/') + 1),
      fstype,
      totalBytes: num(m[3]),
      usedBytes: num(m[4]),
      mount: m[7].trim(),
    });
  });
  return out;
}

export function parsePs(text: string): RawPsRow[] {
  const out: RawPsRow[] = [];
  text.split('\n').forEach(line => {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      return;
    }
    out.push({ pid: num(m[1]), user: m[2], threads: num(m[3]), args: m[4] });
  });
  return out;
}

export function parseAddr(text: string): RawAddr[] {
  const out: RawAddr[] = [];
  text.split('\n').forEach(line => {
    const m = /^\d+:\s+(\S+)\s+inet\s+(\S+)/.exec(line);
    if (m) {
      out.push({ name: m[1], address: m[2] });
    }
  });
  return out;
}

export function parseOsRelease(text: string): { prettyName: string; id: string } {
  const get = (key: string) => {
    const m = new RegExp('^' + key + '=(.*)$', 'm').exec(text);
    return m ? m[1].replace(/^"|"$/g, '') : '';
  };
  return { prettyName: get('PRETTY_NAME'), id: get('ID') };
}

export function parseCpuModel(text: string): string {
  const m = /^model name\s*:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
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
