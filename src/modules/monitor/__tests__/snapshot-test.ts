import { emptyState, buildSnapshot } from '../metrics';
import {
  STAT_8CORE,
  STAT_8CORE_NEXT,
  MEMINFO,
  LOADAVG,
  UPTIME,
  NET_DEV,
  NET_DEV_NEXT,
  DISKSTATS,
  DISKSTATS_NEXT,
  PID_STATS,
  PID_STATS_NEXT,
} from '../__fixtures__/proc';

const OPTS = { pageSize: 4096, clockTicks: 100 };

function block(at: number, next: boolean): string {
  return [
    `==TICK ${at}`,
    '--stat',
    next ? STAT_8CORE_NEXT : STAT_8CORE,
    '--mem',
    MEMINFO,
    '--load',
    LOADAVG,
    '--up',
    UPTIME,
    '--net',
    next ? NET_DEV_NEXT : NET_DEV,
    '--disk',
    next ? DISKSTATS_NEXT : DISKSTATS,
    '--pids',
    next ? PID_STATS_NEXT : PID_STATS,
  ].join('\n');
}

describe('buildSnapshot', () => {
  it('produces absolute values but no rates from the first block', () => {
    const snap = buildSnapshot(emptyState(), block(1000, false), OPTS)!;
    expect(snap.cpu).toBe(null);
    expect(snap.mem.total).toBe(8125000 * 1024);
    expect(snap.load).toEqual({ one: 0.07, five: 0.06, fifteen: 0.01 });
    expect(snap.uptimeSec).toBe(1234567.89);
    expect(snap.net[0].rxBps).toBe(null);
    expect(snap.procs.length).toBe(3);
  });

  it('produces rates from the second block', () => {
    const state = emptyState();
    buildSnapshot(state, block(1000, false), OPTS);
    const snap = buildSnapshot(state, block(3000, true), OPTS)!;
    expect(snap.cpu!.total).toBeCloseTo(10, 5);
    expect(snap.net.filter(n => n.name === 'eth0')[0].rxBps).toBe(1000);
    expect(snap.disks.filter(d => d.name === 'vda1')[0].readIops).toBe(50);
    expect(snap.procs.filter(p => p.pid === 831)[0].cpuPct).toBeCloseTo(60, 5);
  });

  it('uses the server timestamps to compute elapsed time, not local time', () => {
    const state = emptyState();
    buildSnapshot(state, block(1000, false), OPTS);
    // 1000 -> 5000 is 4s, so the same byte delta halves the rate.
    const snap = buildSnapshot(state, block(5000, true), OPTS)!;
    expect(snap.net.filter(n => n.name === 'eth0')[0].rxBps).toBe(500);
    expect(snap.at).toBe(5000);
  });

  it('returns null for a block with no usable sections', () => {
    expect(buildSnapshot(emptyState(), '==TICK 1000\n', OPTS)).toBe(null);
  });

  it('survives a block missing optional sections', () => {
    const partial = ['==TICK 1000', '--stat', STAT_8CORE, '--mem', MEMINFO].join('\n');
    const snap = buildSnapshot(emptyState(), partial, OPTS)!;
    expect(snap.mem.total).toBeGreaterThan(0);
    expect(snap.disks).toEqual([]);
    expect(snap.procs).toEqual([]);
    expect(snap.load).toEqual({ one: 0, five: 0, fifteen: 0 });
    expect(snap.uptimeSec).toBe(0);
  });

  it('ignores a block whose timestamp is not newer than the previous one', () => {
    const state = emptyState();
    buildSnapshot(state, block(3000, false), OPTS);
    expect(buildSnapshot(state, block(3000, true), OPTS)).toBe(null);
  });

  it('advances state so the next block derives against the latest sample', () => {
    const state = emptyState();
    buildSnapshot(state, block(1000, false), OPTS);
    expect(state.at).toBe(1000);
    buildSnapshot(state, block(3000, true), OPTS);
    expect(state.at).toBe(3000);
    expect(state.cpu!.cores[0].user).toBe(57792);
  });
});
