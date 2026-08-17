import { Collector, MonitorTransport, SamplerChannel } from '../collector';
import { Snapshot, SlowData } from '../types';
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
  DF,
  PS,
  IP_ADDR,
} from '../__fixtures__/proc';

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
    '==END',
  ].join('\n');
}

class FakeChannel implements SamplerChannel {
  writes: string[] = [];
  closed = false;
  private _data: (chunk: string) => void = () => undefined;
  private _close: () => void = () => undefined;

  onData(cb: (chunk: string) => void) {
    this._data = cb;
  }
  onClose(cb: () => void) {
    this._close = cb;
  }
  write(s: string) {
    this.writes.push(s);
  }
  close() {
    this.closed = true;
    this._close();
  }

  // test helpers
  emit(chunk: string) {
    this._data(chunk);
  }
  serverClose() {
    this._close();
  }
}

class FakeTransport implements MonitorTransport {
  channel = new FakeChannel();
  execs: string[] = [];
  openError: Error | null = null;
  execError: Error | null = null;

  async openSampler(cmd: string): Promise<SamplerChannel> {
    this.execs.push(cmd);
    if (this.openError) {
      throw this.openError;
    }
    return this.channel;
  }

  async exec(cmd: string) {
    this.execs.push(cmd);
    if (this.execError) {
      throw this.execError;
    }
    return {
      stdout: ['--df', DF, '--ps', PS, '--addr', IP_ADDR].join('\n'),
      stderr: '',
      code: 0,
    };
  }
}

const OPTS = {
  pageSize: 4096,
  clockTicks: 100,
  interval: 2000,
  slowInterval: 10000,
  historyMinutes: 5,
};

const collector = (t: MonitorTransport) => new Collector(t, OPTS);

describe('Collector', () => {
  it('requests the first sample as soon as it starts', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    expect(t.channel.writes.length).toBe(1);
    c.stop();
  });

  it('emits a snapshot for each complete block', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    const seen: Snapshot[] = [];
    c.onSnapshot = s => seen.push(s);
    await c.start();
    t.channel.emit(block(1000, false));
    t.channel.emit(block(3000, true));
    expect(seen.length).toBe(2);
    expect(seen[1].cpu!.total).toBeCloseTo(10, 5);
    c.stop();
  });

  it('requests the next sample from the pacing timer, not from block arrival', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    expect(t.channel.writes.length).toBe(1);
    t.channel.emit(block(1000, false));
    expect(t.channel.writes.length).toBe(1);
    c.tickNow();
    expect(t.channel.writes.length).toBe(2);
    c.stop();
  });

  it('appends each load reading to history', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    t.channel.emit(block(1000, false));
    t.channel.emit(block(3000, true));
    expect(c.history().points().length).toBe(2);
    expect(c.history().points()[0].one).toBe(0.07);
    c.stop();
  });

  it('stops requesting samples while paused and resumes afterwards', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    c.pause();
    c.tickNow();
    expect(t.channel.writes.length).toBe(1);
    expect(c.isPaused()).toBe(true);
    c.resume();
    expect(t.channel.writes.length).toBe(2);
    expect(c.isPaused()).toBe(false);
    c.stop();
  });

  it('emits slow data parsed from the batch command', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let slow: SlowData | null = null;
    c.onSlow = s => {
      slow = s;
    };
    await c.start();
    await c.slowNow();
    const got = slow as SlowData | null;
    expect(got!.mounts.map(m => m.mount)).toEqual(['/', '/mnt/my data']);
    expect(got!.psRows.length).toBe(3);
    expect(got!.addrs.filter(a => a.name === 'eth0')[0].address).toBe('66.154.126.186/24');
    c.stop();
  });

  it('closes the channel and stops timers on stop', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    c.stop();
    expect(t.channel.closed).toBe(true);
    c.tickNow();
    expect(t.channel.writes.length).toBe(1);
  });

  it('reports a channel that closes from the server side', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let closed = false;
    c.onClosed = () => {
      closed = true;
    };
    await c.start();
    t.channel.serverClose();
    expect(closed).toBe(true);
  });

  it('does not report a close that it caused itself', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let closed = false;
    c.onClosed = () => {
      closed = true;
    };
    await c.start();
    c.stop();
    expect(closed).toBe(false);
  });

  it('surfaces a failure to open the sampler', async () => {
    const t = new FakeTransport();
    t.openError = new Error('channel refused');
    const c = collector(t);
    let msg = '';
    c.onError = e => {
      msg = e.message;
    };
    await c.start();
    expect(msg).toBe('channel refused');
  });

  it('reports a slow-lane failure without stopping the fast lane', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let msg = '';
    c.onError = e => {
      msg = e.message;
    };
    await c.start();
    t.execError = new Error('ps not found');
    await c.slowNow();
    expect(msg).toBe('ps not found');
    t.channel.emit(block(1000, false));
    expect(c.history().points().length).toBe(1);
    c.stop();
  });

  it('resizes history when the interval changes so the span stays 5 minutes', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    expect(c.historyCapacity()).toBe(150); // 5 min at 2s
    c.setInterval(5000);
    expect(c.historyCapacity()).toBe(60); // 5 min at 5s
    c.stop();
  });

  it('ignores a malformed block without breaking the stream', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    const seen: Snapshot[] = [];
    c.onSnapshot = s => seen.push(s);
    await c.start();
    t.channel.emit('==TICK 500\ngarbage\n==END\n');
    t.channel.emit(block(1000, false));
    expect(seen.length).toBe(1);
    c.stop();
  });
});
