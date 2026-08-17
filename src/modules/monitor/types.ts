// ---- raw parsed structures (straight off the wire, no arithmetic) ----

export interface RawCpuLine {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
  // Derived once at parse time so delta math never re-sums fields.
  totalJiffies: number;
  busyJiffies: number;
}

export interface RawCpu {
  total: RawCpuLine;
  cores: RawCpuLine[];
}

export interface RawMem {
  total: number;
  free: number;
  available: number;
  // Buffers + Cached + SReclaimable - Shmem, the bucket htop shows as cached.
  cached: number;
  swapTotal: number;
  swapFree: number;
}

export interface RawLoad {
  one: number;
  five: number;
  fifteen: number;
}

export interface RawNetIf {
  name: string;
  rxBytes: number;
  txBytes: number;
}

export interface RawDisk {
  name: string;
  reads: number;
  writes: number;
  readBytes: number;
  writeBytes: number;
  readMs: number;
  writeMs: number;
}

export interface RawProc {
  pid: number;
  comm: string;
  utime: number;
  stime: number;
  threads: number;
  // Field 22: jiffies after boot at which the process started. Together with
  // pid it forms a stable identity across ticks, which is what makes pid reuse
  // detectable.
  startTime: number;
  rssPages: number;
}
