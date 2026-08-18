import {
  RANGES,
  pushPoint,
  trimToWindow,
  cpuPoint,
  memPoint,
  netPoint,
  loadSeries,
} from '../series';
import {
  SNAP_FULL,
  SNAP_FIRST_TICK,
  SNAP_MIXED_NET,
  SNAP_ZERO_NET,
  HISTORY,
} from '../__fixtures__/snapshot';

describe('RANGES', () => {
  it('offers 5, 15 and 60 minute windows', () => {
    // Not 1h/6h/24h/7d: history is in memory only, so anything beyond
    // historyMinutes (default 60) could never be filled.
    expect(RANGES.map(r => r.minutes)).toEqual([5, 15, 60]);
  });
});

describe('pushPoint', () => {
  it('appends a point', () => {
    const out = pushPoint([], { at: 1 }, 10);
    expect(out).toEqual([{ at: 1 }]);
  });
  it('drops the oldest point once capacity is exceeded', () => {
    const buf = [{ at: 1 }, { at: 2 }];
    expect(pushPoint(buf, { at: 3 }, 2)).toEqual([{ at: 2 }, { at: 3 }]);
  });
  it('does not mutate the input buffer', () => {
    const buf = [{ at: 1 }];
    pushPoint(buf, { at: 2 }, 10);
    expect(buf).toEqual([{ at: 1 }]);
  });
  it('ignores an out-of-order point rather than corrupting the axis', () => {
    // The server clock can step backwards across a reconnect.
    const buf = [{ at: 5 }];
    expect(pushPoint(buf, { at: 3 }, 10)).toEqual([{ at: 5 }]);
  });
  it('rejects a point with a timestamp equal to the last one', () => {
    const buf = [{ at: 5 }];
    expect(pushPoint(buf, { at: 5 }, 10)).toEqual([{ at: 5 }]);
  });
});

describe('trimToWindow', () => {
  const NOW = 1_000_000;
  it('keeps points inside the window', () => {
    const points = [{ at: NOW - 60_000 }, { at: NOW }];
    expect(trimToWindow(points, 5, NOW).length).toBe(2);
  });
  it('drops points older than the window', () => {
    const points = [{ at: NOW - 600_000 }, { at: NOW }];
    expect(trimToWindow(points, 5, NOW)).toEqual([{ at: NOW }]);
  });
  it('returns an empty array when everything is stale', () => {
    expect(trimToWindow([{ at: 0 }], 5, NOW)).toEqual([]);
  });
});

describe('cpuPoint', () => {
  it('carries total and every core as its own series', () => {
    const p = cpuPoint(SNAP_FULL);
    expect(p).not.toBeNull();
    expect(p!.at).toBe(SNAP_FULL.at);
    expect(p!.total).toBe(20.4);
    expect(p!.core0).toBe(10);
    expect(p!.core3).toBe(26);
  });
  it('returns null when cpu is null on the first tick', () => {
    expect(cpuPoint(SNAP_FIRST_TICK)).toBeNull();
  });
});

describe('memPoint', () => {
  it('carries used and cached percentages', () => {
    const p = memPoint(SNAP_FULL);
    expect(p!.usedPct).toBe(31.25);
    expect(p!.cachedPct).toBe(50);
  });
  it('survives the first tick, since mem is always present', () => {
    expect(memPoint(SNAP_FIRST_TICK)).not.toBeNull();
  });
});

describe('netPoint', () => {
  it('sums rates across physical interfaces and excludes loopback', () => {
    const p = netPoint(SNAP_FULL);
    expect(p!.rx).toBe(3000);
    expect(p!.tx).toBe(190_000);
  });
  it('yields nulls, not zeros, when every rate is null', () => {
    const p = netPoint(SNAP_FIRST_TICK);
    expect(p!.rx).toBeNull();
    expect(p!.tx).toBeNull();
  });
  it('sums the interfaces that have a rate and ignores the ones that do not', () => {
    const p = netPoint(SNAP_MIXED_NET);
    expect(p!.rx).toBe(5000);
    expect(p!.tx).toBe(7000);
  });
  it('reports a genuine zero as zero, not as unknown', () => {
    // A real 0 B/s is information. Collapsing it to null would throw it away.
    const p = netPoint(SNAP_ZERO_NET);
    expect(p!.rx).toBe(0);
    expect(p!.tx).toBe(0);
  });
  it('reports unknown as null even when another interface reports zero', () => {
    // The inverse of the above: `0 || fallback` is the classic bug here, so pin
    // that a zero accumulator is never mistaken for "no data yet".
    const onlyNull: any = { ...SNAP_ZERO_NET, net: [{ name: 'eth1', rxBps: null, txBps: null, rxTotal: 0, txTotal: 0 }] };
    const p = netPoint(onlyNull);
    expect(p!.rx).toBeNull();
    expect(p!.tx).toBeNull();
  });
});

describe('loadSeries', () => {
  it('maps history straight through', () => {
    const s = loadSeries(HISTORY);
    expect(s.length).toBe(3);
    expect(s[2].one).toBe(0.83);
    expect(s[2].five).toBe(0.5);
    expect(s[2].fifteen).toBe(0.3);
  });
  it('returns an empty array for missing history', () => {
    expect(loadSeries(undefined as any)).toEqual([]);
  });
});
