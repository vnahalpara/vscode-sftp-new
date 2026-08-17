import { Framer, splitSections } from './frame';
import { samplerScript, slowBatchCommand } from './probe';
import { buildSnapshot, emptyState, History, ProcOpts } from './metrics';
import { parseDf, parsePs, parseAddr } from './parse';
import { SampleState, Snapshot, SlowData } from './types';

// Seconds of silence after which the remote loop exits on its own. Covers an
// unclean disconnect where our channel close never reaches the server.
const IDLE_TIMEOUT_SEC = 300;

export interface SamplerChannel {
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
  write(s: string): void;
  close(): void;
}

export interface MonitorTransport {
  openSampler(cmd: string): Promise<SamplerChannel>;
  exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface CollectorOpts extends ProcOpts {
  interval: number;
  slowInterval: number;
  historyMinutes: number;
}

export class Collector {
  onSnapshot: (s: Snapshot) => void = () => undefined;
  onSlow: (s: SlowData) => void = () => undefined;
  onClosed: () => void = () => undefined;
  onError: (e: Error) => void = () => undefined;

  private _transport: MonitorTransport;
  private _opts: CollectorOpts;
  private _framer = new Framer();
  private _state: SampleState = emptyState();
  private _history: History;
  private _channel: SamplerChannel | null = null;
  private _fastTimer: any = null;
  private _slowTimer: any = null;
  private _paused = false;
  private _stopped = false;

  constructor(transport: MonitorTransport, opts: CollectorOpts) {
    this._transport = transport;
    this._opts = opts;
    this._history = new History(this._capacityFor(opts.interval));
  }

  async start(): Promise<void> {
    // A restart after a dropped connection reuses this instance, so clear the
    // stopped flag, the half-read buffer, and the previous sample. Resetting
    // the sample matters: if the server rebooted, its clock and counters went
    // backwards, and a stale state.at would make every new block look
    // out-of-order and be dropped forever. One tick of null rates is the cost.
    // Clearing timers first makes start() safe to call twice: without it a
    // reconnect leaks the previous pair of intervals, which keep ticking (and
    // keep the process alive) with no channel to write to.
    this._clearTimers();
    this._stopped = false;
    this._framer = new Framer();
    this._state = emptyState();
    let channel: SamplerChannel;
    try {
      channel = await this._transport.openSampler(samplerScript(IDLE_TIMEOUT_SEC));
    } catch (error) {
      this.onError(error as Error);
      return;
    }
    if (this._stopped) {
      // stop() landed while the channel was still opening.
      channel.close();
      return;
    }
    this._channel = channel;

    channel.onData(chunk => {
      this._framer.push(chunk).forEach(block => this._handleBlock(block));
    });
    channel.onClose(() => {
      this._channel = null;
      this._clearTimers();
      if (!this._stopped) {
        this.onClosed();
      }
    });

    this.tickNow();
    this._fastTimer = setInterval(() => this.tickNow(), this._opts.interval);
    this._slowTimer = setInterval(() => this.slowNow(), this._opts.slowInterval);
    await this.slowNow();
  }

  // Ask the remote loop for one snapshot. Public so the panel can force a
  // refresh and so tests can advance without waiting on real timers.
  tickNow(): void {
    if (this._stopped || this._paused || !this._channel) {
      return;
    }
    this._channel.write('\n');
  }

  async slowNow(): Promise<void> {
    if (this._stopped) {
      return;
    }
    try {
      const res = await this._transport.exec(slowBatchCommand());
      const { sections } = splitSections(res.stdout);
      this.onSlow({
        mounts: sections.df ? parseDf(sections.df) : [],
        psRows: sections.ps ? parsePs(sections.ps) : [],
        addrs: sections.addr ? parseAddr(sections.addr) : [],
      });
    } catch (error) {
      // A failing slow lane greys out a card; it must not kill the fast lane.
      this.onError(error as Error);
    }
  }

  setInterval(ms: number): void {
    this._opts.interval = ms;
    this._history.resize(this._capacityFor(ms));
    if (this._fastTimer) {
      clearInterval(this._fastTimer);
      this._fastTimer = setInterval(() => this.tickNow(), ms);
    }
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    this.tickNow();
  }

  isPaused(): boolean {
    return this._paused;
  }

  history(): History {
    return this._history;
  }

  historyCapacity(): number {
    return this._capacityFor(this._opts.interval);
  }

  stop(): void {
    this._stopped = true;
    this._clearTimers();
    if (this._channel) {
      // Closing stdin ends the remote `read` loop, so no shell is left behind.
      const channel = this._channel;
      this._channel = null;
      channel.close();
    }
  }

  private _capacityFor(intervalMs: number): number {
    const span = this._opts.historyMinutes * 60 * 1000;
    return Math.max(1, Math.floor(span / Math.max(1, intervalMs)));
  }

  private _clearTimers(): void {
    if (this._fastTimer) {
      clearInterval(this._fastTimer);
      this._fastTimer = null;
    }
    if (this._slowTimer) {
      clearInterval(this._slowTimer);
      this._slowTimer = null;
    }
  }

  private _handleBlock(block: string): void {
    const snapshot = buildSnapshot(this._state, block, this._opts);
    if (!snapshot) {
      return;
    }
    this._history.push({
      at: snapshot.at,
      one: snapshot.load.one,
      five: snapshot.load.five,
      fifteen: snapshot.load.fifteen,
    });
    this.onSnapshot(snapshot);
  }
}
