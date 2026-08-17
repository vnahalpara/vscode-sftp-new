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
