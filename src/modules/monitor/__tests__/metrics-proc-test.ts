import { parsePidStats } from '../parse';
import { procMetrics, History, MAX_PROCS } from '../metrics';
import { PID_STATS, PID_STATS_NEXT } from '../__fixtures__/proc';

const OPTS = { pageSize: 4096, clockTicks: 100 };

// Minimal /proc/pid/stat line with utime/stime and threads controllable.
function statLine(pid: number, utime: number, stime: number, startTime: number): string {
  return (
    `${pid} (p${pid}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ` +
    `${startTime} 100000 512 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0`
  );
}

describe('procMetrics', () => {
  it('returns null cpu on the first sample but still lists processes', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    expect(rows.length).toBe(3);
    expect(rows[0].cpuPct).toBe(null);
  });

  it('converts rss pages to bytes', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    expect(rows.filter(p => p.pid === 831)[0].rssBytes).toBe(25100 * 4096);
  });

  it('computes cpu percent from utime+stime deltas', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    // 120 jiffies over 2s at 100 ticks/sec = 120/200 = 60% of one core.
    expect(rows.filter(p => p.pid === 831)[0].cpuPct).toBeCloseTo(60, 5);
  });

  it('reports zero for a process that used no cpu', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    expect(rows.filter(p => p.pid === 1)[0].cpuPct).toBe(0);
  });

  it('does not clamp a multi-threaded process at one core', () => {
    // 400 jiffies over 200 elapsed ticks: two cores fully busy.
    const prev = parsePidStats(statLine(50, 0, 0, 7));
    const cur = parsePidStats(statLine(50, 300, 100, 7));
    expect(procMetrics(prev, cur, 2000, OPTS)[0].cpuPct).toBeCloseTo(200, 5);
  });

  it('does not attribute cpu to a reused pid', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    const impostor = rows.filter(p => p.pid === 209906)[0];
    // Same pid, different starttime: a different process, so no delta exists.
    expect(impostor.comm).toBe('impostor');
    expect(impostor.cpuPct).toBe(null);
  });

  it('carries the identity pair needed to verify a process later', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    expect(rows.filter(p => p.pid === 831)[0].startTime).toBe(900);
  });

  it('sorts by cpu descending', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    expect(rows[0].pid).toBe(831);
  });

  it('falls back to rss ordering when no cpu delta exists', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    expect(rows[0].pid).toBe(831); // 25100 pages, the largest
  });

  it('caps the list at MAX_PROCS', () => {
    const many: string[] = [];
    for (let pid = 1; pid <= MAX_PROCS + 50; pid++) {
      many.push(`==> /proc/${pid}/stat <==`);
      many.push(statLine(pid, pid, 0, 5));
    }
    expect(procMetrics(null, parsePidStats(many.join('\n')), 2000, OPTS).length).toBe(MAX_PROCS);
  });

  it('reports null rather than a negative percent if cpu time regresses', () => {
    const prev = parsePidStats(statLine(50, 500, 0, 7));
    const cur = parsePidStats(statLine(50, 100, 0, 7));
    expect(procMetrics(prev, cur, 2000, OPTS)[0].cpuPct).toBe(null);
  });
});

describe('History', () => {
  it('returns points in insertion order', () => {
    const h = new History(3);
    h.push({ at: 1, one: 0.1, five: 0.2, fifteen: 0.3 });
    h.push({ at: 2, one: 0.4, five: 0.5, fifteen: 0.6 });
    expect(h.points().map(p => p.at)).toEqual([1, 2]);
  });

  it('evicts the oldest point at capacity', () => {
    const h = new History(2);
    [1, 2, 3].forEach(at => h.push({ at, one: 0, five: 0, fifteen: 0 }));
    expect(h.points().map(p => p.at)).toEqual([2, 3]);
  });

  it('keeps the newest points when shrinking capacity', () => {
    const h = new History(4);
    [1, 2, 3, 4].forEach(at => h.push({ at, one: 0, five: 0, fifteen: 0 }));
    h.resize(2);
    expect(h.points().map(p => p.at)).toEqual([3, 4]);
  });

  it('never drops below a capacity of one', () => {
    const h = new History(0);
    h.push({ at: 1, one: 0, five: 0, fifteen: 0 });
    expect(h.points().length).toBe(1);
  });
});
