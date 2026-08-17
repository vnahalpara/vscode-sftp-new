import { parseStat, parseMeminfo } from '../parse';
import { cpuMetrics, memMetrics } from '../metrics';
import {
  STAT_8CORE,
  STAT_8CORE_NEXT,
  STAT_1CORE,
  STAT_1CORE_REBOOTED,
  MEMINFO,
  MEMINFO_NO_SWAP,
} from '../__fixtures__/proc';

describe('cpuMetrics', () => {
  it('returns null on the first sample because there is no delta yet', () => {
    expect(cpuMetrics(null, parseStat(STAT_8CORE))).toBe(null);
  });

  it('computes aggregate busy percentage from the delta', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    // aggregate delta: user +100, idle +900 => 100 busy of 1000 total = 10%
    expect(m.total).toBeCloseTo(10, 5);
  });

  it('computes per-core percentages', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    expect(m.cores.length).toBe(8);
    expect(m.cores[0]).toBeCloseTo(10, 5);
    // Cores 1-7 did not move at all.
    expect(m.cores[1]).toBe(0);
  });

  it('breaks the delta down by state', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    expect(m.breakdown.user).toBeCloseTo(10, 5);
    expect(m.breakdown.system).toBe(0);
    expect(m.breakdown.iowait).toBe(0);
    expect(m.breakdown.steal).toBe(0);
  });

  it('returns zeroes rather than NaN when no jiffies elapsed', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE))!;
    expect(m.total).toBe(0);
    expect(m.cores[0]).toBe(0);
  });

  it('discards the delta when counters go backwards after a reboot', () => {
    // Same core count, so this exercises the regression check itself.
    expect(cpuMetrics(parseStat(STAT_1CORE), parseStat(STAT_1CORE_REBOOTED))).toBe(null);
  });

  it('discards the delta when the core count changes', () => {
    expect(cpuMetrics(parseStat(STAT_1CORE), parseStat(STAT_8CORE_NEXT))).toBe(null);
  });

  it('never reports more than 100 percent', () => {
    const prev = parseStat('cpu 0 0 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0\n');
    const cur = parseStat('cpu 100 0 0 0 0 0 0 0\ncpu0 100 0 0 0 0 0 0 0\n');
    const m = cpuMetrics(prev, cur)!;
    expect(m.total).toBe(100);
    expect(m.cores[0]).toBe(100);
  });
});

describe('memMetrics', () => {
  it('derives the used bucket as total minus free minus cached', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.total).toBe(8125000 * 1024);
    expect(m.free).toBe(1237000 * 1024);
    expect(m.cached).toBe(2540000 * 1024);
    expect(m.used).toBe((8125000 - 1237000 - 2540000) * 1024);
  });

  it('computes percentages that sum to exactly 100', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.usedPct + m.cachedPct + m.freePct).toBeCloseTo(100, 5);
    expect(Math.round(m.usedPct)).toBe(54);
    expect(Math.round(m.cachedPct)).toBe(31);
    expect(Math.round(m.freePct)).toBe(15);
  });

  it('computes swap used and percentage', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.swapUsed).toBe((1048576 - 668576) * 1024);
    expect(Math.round(m.swapPct)).toBe(36);
  });

  it('reports zero swap percentage when swap is disabled', () => {
    const m = memMetrics(parseMeminfo(MEMINFO_NO_SWAP));
    expect(m.swapTotal).toBe(0);
    expect(m.swapPct).toBe(0);
  });

  it('never returns a negative used bucket', () => {
    const m = memMetrics({
      total: 1000,
      free: 800,
      available: 900,
      cached: 500,
      swapTotal: 0,
      swapFree: 0,
    });
    expect(m.used).toBe(0);
  });
});
