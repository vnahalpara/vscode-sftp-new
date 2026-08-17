import { MonitorTransport } from '../monitor/collector';
import { HostFacts, Snapshot, SlowData, LoadPoint } from '../monitor/types';
import { RedactedProfile } from './registry';
import { SseChannel, SseSink } from './sse';
import { ActivityLog } from './activity';

export type SessionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unsupported';

// The structural subset of Collector the session drives. Declaring it as an
// interface rather than importing the class is what lets the tests run without
// a transport, a socket, or a timer.
export interface CollectorLike {
  onSnapshot: (snapshot: Snapshot) => void;
  onSlow: (slow: SlowData) => void;
  onError: (error: Error) => void;
  onClosed: () => void;
  start(): Promise<void>;
  stop(): void;
  slowNow(): Promise<void>;
  history(): { points(): LoadPoint[] };
}

export interface SessionDeps {
  transport: MonitorTransport;
  readFacts(transport: MonitorTransport): Promise<HostFacts>;
  makeCollector(transport: MonitorTransport, facts: HostFacts): CollectorLike;
  schedule(fn: () => void, ms: number): any;
  cancel(handle: any): void;
  now(): number;
}

export interface SessionOpts {
  graceMs: number;
  interval: number;
}

export interface SessionState {
  id: string;
  profile: RedactedProfile;
  status: SessionStatus;
  error: string | null;
  facts: HostFacts | null;
  interval: number;
  lastSeen: number | null;
}

export class ManagedSession {
  readonly id: string;
  readonly token: string;
  readonly profile: RedactedProfile;
  readonly sse = new SseChannel();
  readonly activity = new ActivityLog();

  private _deps: SessionDeps;
  private _opts: SessionOpts;
  private _collector: CollectorLike | null = null;
  private _facts: HostFacts | null = null;
  private _status: SessionStatus = 'idle';
  private _error: string | null = null;
  private _lastSeen: number | null = null;
  private _lastSnapshot: Snapshot | null = null;
  private _lastSlow: SlowData | null = null;
  private _stopHandle: any = null;
  private _pending: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(profile: RedactedProfile, token: string, deps: SessionDeps, opts: SessionOpts) {
    this.id = profile.id;
    this.token = token;
    this.profile = profile;
    this._deps = deps;
    this._opts = opts;
  }

  state(): SessionState {
    return {
      id: this.id,
      profile: this.profile,
      status: this._status,
      error: this._error,
      facts: this._facts,
      interval: this._opts.interval,
      lastSeen: this._lastSeen,
    };
  }

  subscriberCount(): number {
    return this.sse.count();
  }

  isRunning(): boolean {
    return this._collector !== null;
  }

  // Tests await this to let the start() chain settle. Production code never
  // needs it: everything it produces arrives as an SSE event.
  whenSettled(): Promise<void> {
    return this._pending;
  }

  subscribe(sink: SseSink): () => void {
    const off = this.sse.add(sink);

    // A reload lands here inside the grace period; cancelling the pending stop
    // is what keeps the SSH channel alive across it.
    if (this._stopHandle !== null) {
      this._deps.cancel(this._stopHandle);
      this._stopHandle = null;
    }

    this._sendStateTo(sink);
    if (this._lastSnapshot) {
      this._sendTickTo(sink, this._lastSnapshot);
    }
    if (this._lastSlow) {
      sink.write(`event: slow\ndata: ${JSON.stringify(this._lastSlow)}\n\n`);
    }

    if (!this._collector && this._status !== 'connecting') {
      this._pending = this._start();
    }

    return () => {
      off();
      if (this.sse.count() === 0) {
        this._scheduleStop();
      }
    };
  }

  async refresh(): Promise<void> {
    if (this._collector) {
      await this._collector.slowNow();
      return;
    }
    // Offline or unsupported: a refresh is the user asking us to try again.
    this._pending = this._start();
    await this._pending;
  }

  dispose(): void {
    this._disposed = true;
    if (this._stopHandle !== null) {
      this._deps.cancel(this._stopHandle);
      this._stopHandle = null;
    }
    this._stopCollector();
    this.sse.closeAll();
  }

  private async _start(): Promise<void> {
    this._setStatus('connecting', null);

    let facts: HostFacts;
    try {
      facts = await this._deps.readFacts(this._deps.transport);
    } catch (error) {
      this._setStatus('offline', (error as Error).message);
      return;
    }
    if (this._disposed) {
      return;
    }

    this._facts = facts;
    if (!facts.linux) {
      this._setStatus(
        'unsupported',
        'Manage Server requires a Linux host (it reads /proc on the server).'
      );
      return;
    }

    const collector = this._deps.makeCollector(this._deps.transport, facts);
    collector.onSnapshot = snapshot => {
      this._lastSnapshot = snapshot;
      this._lastSeen = this._deps.now();
      this.sse.send('tick', { snapshot, history: collector.history().points() });
    };
    collector.onSlow = slow => {
      this._lastSlow = slow;
      this.sse.send('slow', slow);
    };
    collector.onError = error => {
      this._setStatus('offline', error.message);
    };
    collector.onClosed = () => {
      this._setStatus('offline', this._error || 'The connection closed.');
    };

    this._collector = collector;
    try {
      await collector.start();
    } catch (error) {
      this._collector = null;
      this._setStatus('offline', (error as Error).message);
      return;
    }
    if (this._disposed) {
      collector.stop();
      this._collector = null;
      return;
    }
    this._setStatus('online', null);
  }

  private _scheduleStop(): void {
    if (this._stopHandle !== null || !this._collector) {
      return;
    }
    this._stopHandle = this._deps.schedule(() => {
      this._stopHandle = null;
      // A subscriber may have arrived between the timer firing and now.
      if (this.sse.count() === 0) {
        this._stopCollector();
      }
    }, this._opts.graceMs);
  }

  private _stopCollector(): void {
    if (!this._collector) {
      return;
    }
    this._collector.stop();
    this._collector = null;
    if (this._status === 'online') {
      this._status = 'idle';
    }
  }

  private _setStatus(status: SessionStatus, error: string | null): void {
    this._status = status;
    this._error = error;
    this.sse.send('state', this.state());
  }

  private _sendStateTo(sink: SseSink): void {
    sink.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
  }

  private _sendTickTo(sink: SseSink, snapshot: Snapshot): void {
    const history = this._collector ? this._collector.history().points() : [];
    sink.write(`event: tick\ndata: ${JSON.stringify({ snapshot, history })}\n\n`);
  }
}
