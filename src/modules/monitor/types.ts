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

export interface RawMount {
  device: string;
  // Basename of `device`, which is how /proc/diskstats names it (vda1, nvme0n1p2).
  deviceName: string;
  fstype: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface RawPsRow {
  pid: number;
  user: string;
  threads: number;
  args: string;
}

export interface RawAddr {
  name: string;
  address: string;
}

export interface HostFacts {
  hostname: string;
  prettyName: string;
  distroId: string;
  cpuModel: string;
  arch: string;
  cores: number;
  pageSize: number;
  // The server's own clock at open, so nothing downstream depends on the
  // workstation's clock being correct.
  serverEpochMs: number;
  linux: boolean;
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
