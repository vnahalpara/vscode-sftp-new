// Shapes captured from src/modules/monitor/types.ts. Kept deliberately minimal:
// each fixture carries only the fields the series derivation reads.
export const SNAP_FULL: any = {
  at: 1_700_000_000_000,
  cpu: {
    total: 20.4,
    cores: [10, 30, 15, 26],
    breakdown: { user: 12, system: 6, nice: 0, iowait: 2, steal: 0.4 },
  },
  mem: {
    total: 16_000_000_000,
    used: 5_000_000_000,
    cached: 8_000_000_000,
    free: 3_000_000_000,
    usedPct: 31.25,
    cachedPct: 50,
    freePct: 18.75,
    swapTotal: 0,
    swapUsed: 0,
    swapPct: 0,
  },
  load: { one: 0.83, five: 0.5, fifteen: 0.3 },
  uptimeSec: 2040,
  net: [
    { name: 'eth0', rxBps: 3000, txBps: 190_000, rxTotal: 1, txTotal: 2 },
    { name: 'lo', rxBps: 10, txBps: 10, rxTotal: 1, txTotal: 1 },
  ],
  disks: [],
  procs: [],
};

// The first tick after a connect or a counter reset: cpu is null and every
// rate is null. Every renderer must survive this.
export const SNAP_FIRST_TICK: any = {
  at: 1_700_000_000_000,
  cpu: null,
  mem: SNAP_FULL.mem,
  load: { one: 0, five: 0, fifteen: 0 },
  uptimeSec: 10,
  net: [{ name: 'eth0', rxBps: null, txBps: null, rxTotal: 0, txTotal: 0 }],
  disks: [],
  procs: [],
};

export const HISTORY: any[] = [
  { at: 1_700_000_000_000, one: 0.1, five: 0.2, fifteen: 0.3 },
  { at: 1_700_000_002_000, one: 0.4, five: 0.3, fifteen: 0.3 },
  { at: 1_700_000_004_000, one: 0.83, five: 0.5, fifteen: 0.3 },
];
