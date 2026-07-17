import TransferAggregator from '../transferAggregator';

function makeBar() {
  const calls: Array<{ text: string; tooltip?: any; timeout?: number }> = [];
  return {
    calls,
    showMsg(text: string, tooltip?: any, timeout?: number) {
      calls.push({ text, tooltip, timeout });
    },
    last() {
      return calls[calls.length - 1];
    },
  };
}

// controllable clock
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const DL = 'remote ➞ local';

describe('TransferAggregator single file', () => {
  it('renders transferred / total, speed and ETA', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const task = {};

    agg.beginOperation();
    agg.registerTask({ size: 20 * 1024 * 1024 }); // 20 MB total
    agg.onTaskStart(task, { direction: DL, filename: 'exception.log', filepath: '/x' });

    clock.advance(1000);
    agg.onTaskProgress(task, 450 * 1024); // 450 KB after 1s at t=0 baseline
    // add a second sample so speed can be computed
    clock.advance(1000);
    agg.onTaskProgress(task, 900 * 1024);

    const text = bar.last().text;
    expect(text).toContain(`${DL} exception.log`);
    expect(text).toContain('900 KB / 20 MB');
    expect(text).toContain('· 450 KB/s');
    expect(text).toContain('left');
  });

  it('drops total and ETA when size is unknown', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const task = {};
    agg.beginOperation();
    agg.registerTask({ size: 0 });
    agg.onTaskStart(task, { direction: DL, filename: 'x.log', filepath: '/x' });
    clock.advance(1000);
    agg.onTaskProgress(task, 1258);
    const text = bar.last().text;
    expect(text).toContain('1.23 KB');
    expect(text).not.toContain('/');
    expect(text).not.toContain('left');
  });

  it('shows a done summary and auto-reset on completion', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const task = {};
    agg.beginOperation();
    agg.registerTask({ size: 10 });
    agg.onTaskStart(task, { direction: DL, filename: 'x.log', filepath: '/x' });
    agg.onTaskProgress(task, 10);
    agg.onTaskDone(task, {});
    agg.endOperation();
    expect(bar.last().text).toBe('done x.log');
    expect(bar.last().timeout).toBe(4000);
  });
});

describe('TransferAggregator multi file', () => {
  it('renders aggregate file counts and combined bytes', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const t1 = {}, t2 = {}, t3 = {};

    agg.beginOperation();
    agg.registerTask({ size: 100 * 1024 * 1024 });
    agg.registerTask({ size: 100 * 1024 * 1024 });
    agg.registerTask({ size: 10 * 1024 * 1024 }); // total 210 MB, 3 files

    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskProgress(t1, 100 * 1024 * 1024);
    agg.onTaskDone(t1, {}); // 1 done, 100 MB base

    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    clock.advance(1000);
    agg.onTaskProgress(t2, 45 * 1024 * 1024); // base 100 + 45 = 145 MB
    clock.advance(1000);
    agg.onTaskProgress(t2, 45 * 1024 * 1024);

    const text = bar.last().text;
    expect(text).toContain(`${DL}  (1/3 files)`);
    expect(text).toContain('145 MB / 210 MB');
    expect(t3).toBeDefined();
  });

  it('summarizes failures', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const t1 = {}, t2 = {};
    agg.beginOperation();
    agg.registerTask({ size: 10 });
    agg.registerTask({ size: 10 });
    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskDone(t1, {});
    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    agg.onTaskDone(t2, { error: true });
    agg.endOperation();
    expect(bar.last().text).toBe('done 1 files, 1 failed');
  });

  it('spans multiple operations via refcount (no early reset)', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const t1 = {}, t2 = {};
    agg.beginOperation(); // op A
    agg.beginOperation(); // op B
    agg.registerTask({ size: 10 });
    agg.registerTask({ size: 10 });
    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskDone(t1, {});
    agg.endOperation(); // op A done, but B still active -> no terminal message yet
    const beforeCount = bar.calls.length;
    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    agg.onTaskDone(t2, {});
    agg.endOperation(); // now refcount 0
    expect(bar.last().text).toBe('done 2 files');
    expect(bar.calls.length).toBeGreaterThan(beforeCount);
  });
});
