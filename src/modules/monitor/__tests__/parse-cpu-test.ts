import { parseStat, parseMeminfo, parseLoadavg, parseUptime } from '../parse';
import {
  STAT_8CORE,
  STAT_1CORE,
  MEMINFO,
  MEMINFO_NO_SWAP,
  LOADAVG,
  UPTIME,
} from '../__fixtures__/proc';

describe('parseStat', () => {
  it('reads the aggregate line', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.total.user).toBe(461534);
    expect(cpu.total.nice).toBe(1834);
    expect(cpu.total.system).toBe(122900);
    expect(cpu.total.idle).toBe(226255632);
    expect(cpu.total.iowait).toBe(62901);
    expect(cpu.total.steal).toBe(0);
  });

  it('reads every per-core line in order', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.cores.length).toBe(8);
    expect(cpu.cores[0].user).toBe(57692);
    expect(cpu.cores[7].user).toBe(57693);
  });

  it('ignores non-cpu lines', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.cores.every(c => typeof c.idle === 'number')).toBe(true);
  });

  it('handles a single-core host', () => {
    const cpu = parseStat(STAT_1CORE);
    expect(cpu.cores.length).toBe(1);
    expect(cpu.total.user).toBe(100);
  });

  it('sums busy and total jiffies per line', () => {
    const cpu = parseStat(STAT_1CORE);
    // user+nice+system+idle+iowait+irq+softirq+steal = 100+0+50+900+10 = 1060
    expect(cpu.total.totalJiffies).toBe(1060);
    // busy excludes idle and iowait => 150
    expect(cpu.total.busyJiffies).toBe(150);
  });
});

describe('parseMeminfo', () => {
  it('converts kB fields to bytes', () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.total).toBe(8125000 * 1024);
    expect(m.free).toBe(1237000 * 1024);
    expect(m.available).toBe(3600000 * 1024);
  });

  it('folds buffers and reclaimable slab into the cached bucket, minus shmem', () => {
    const m = parseMeminfo(MEMINFO);
    // 120000 + 2400000 + 100000 - 80000 = 2540000 kB
    expect(m.cached).toBe(2540000 * 1024);
  });

  it('reads swap', () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.swapTotal).toBe(1048576 * 1024);
    expect(m.swapFree).toBe(668576 * 1024);
  });

  it('handles a host with no swap', () => {
    const m = parseMeminfo(MEMINFO_NO_SWAP);
    expect(m.swapTotal).toBe(0);
    expect(m.swapFree).toBe(0);
  });

  it('treats missing optional fields as zero', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n');
    expect(m.total).toBe(1000 * 1024);
    expect(m.cached).toBe(0);
    expect(m.swapTotal).toBe(0);
  });
});

describe('parseLoadavg', () => {
  it('reads the three averages', () => {
    expect(parseLoadavg(LOADAVG)).toEqual({ one: 0.07, five: 0.06, fifteen: 0.01 });
  });
});

describe('parseUptime', () => {
  it('reads seconds since boot', () => {
    expect(parseUptime(UPTIME)).toBe(1234567.89);
  });
});
