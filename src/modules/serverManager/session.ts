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
  privilegedTransport: MonitorTransport;
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
  // Paths this session's own GET /api/logs discovery has surfaced, and which
  // /ws/logs (logFollow.ts) may therefore follow. Session-scoped by
  // construction -- it lives on this instance, not a token-keyed map another
  // session could be confused with -- which is what makes it safe for
  // logFollow.ts's isPathAllowed to be built directly from one session's own
  // copy. NOTE: as of this writing routes.ts's `/api/logs` handler still
  // seeds its own private `allowedFiles` map (see routes.ts) rather than
  // calling allowLogPaths() below; wiring that one-line call is a follow-up
  // outside this change (routes.ts was off-limits while this was written --
  // see the Task 5 report). Until that call is added, isLogPathAllowed()
  // below correctly, safely refuses every file path (fails closed, not
  // open) rather than silently trusting an unpopulated set.
  private _allowedLogPaths = new Set<string>();

  constructor(profile: RedactedProfile, token: string, deps: SessionDeps, opts: SessionOpts) {
    this.id = profile.id;
    this.token = token;
    this.profile = profile;
    this._deps = deps;
    this._opts = opts;
  }

  // Public on purpose: the ops layer (routes.ts, readOpsFor) runs this
  // session's UNPRIVILEGED reads over this lane -- listing services,
  // `systemctl status`, detecting nginx/apache. None of those commands
  // carries sudo, so none of them should be what opens the root connection;
  // this is the same channel the Overview tab already holds open. Routing it
  // through the session -- rather than a second token-keyed map living
  // alongside byToken in index.ts -- keeps a single owner of the SSH
  // connection instead of two maps that could drift out of sync.
  get transport(): MonitorTransport {
    return this._deps.transport;
  }

  // Privileged ops (systemctl, nginx -t, openssl) run over this lane, which is
  // authenticated as root_user when the profile supplies those credentials and
  // as the ordinary session user otherwise. Metrics keep using `transport` --
  // reading /proc needs no privilege, and holding a root channel open for the
  // whole session just to sample CPU would be gratuitous.
  get privilegedTransport(): MonitorTransport {
    return this._deps.privilegedTransport;
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

  // Called by GET /api/logs (routes.ts) once discovery has run, with the
  // paths it already re-checked against isLogFilePath -- same discipline as
  // routes.ts's own allowedFiles map, just keyed by session instance instead
  // of by token in a second data structure.
  allowLogPaths(paths: string[]): void {
    paths.forEach(p => this._allowedLogPaths.add(p));
  }

  // Whether `path` is in THIS session's own log allowlist -- never a global
  // one. See logFollow.ts's module comment for why that distinction is the
  // entire point of this method existing on ManagedSession rather than as a
  // free function over some shared map.
  isLogPathAllowed(path: string): boolean {
    return this._allowedLogPaths.has(path);
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
    // A start already in flight has no collector yet — it is between the top of
    // _start() and the _collector assignment, a window as wide as one readFacts
    // round trip. Starting a rival here would build a second collector and
    // start() it; only one can win the _collector field, and the loser is never
    // stopped, leaking a sampler channel and a remote read loop forever. Wait
    // for the one already running instead.
    if (this._status === 'connecting') {
      await this._pending;
      return;
    }
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
    // Every callback below is gated on this collector still being the session's
    // current one. A collector that has been superseded, or already reaped by
    // _collectorDied()/_stopCollector(), must not mutate session state or emit
    // frames: its ticks would race the live collector's and its `closed` would
    // knock a healthy session offline. The check is safe against suppressing
    // legitimate early events because no callback can fire before start(), and
    // `this._collector = collector` happens before `await collector.start()`.
    const isCurrent = () => this._collector === collector;
    collector.onSnapshot = snapshot => {
      if (!isCurrent()) {
        return;
      }
      this._lastSnapshot = snapshot;
      this._lastSeen = this._deps.now();
      // A snapshot means the channel is alive. Only transition (and emit a
      // `state` frame) when we were not already online — an error can be
      // transient, and a fresh `state` frame on every tick would be noise.
      if (this._status !== 'online') {
        this._setStatus('online', null);
      }
      this.sse.send('tick', { snapshot, history: collector.history().points() });
    };
    collector.onSlow = slow => {
      if (!isCurrent()) {
        return;
      }
      this._lastSlow = slow;
      this.sse.send('slow', slow);
    };
    // A transient error (one bad sample) does not mean the channel is gone;
    // only `onClosed` does. Leaving the collector running lets onSnapshot
    // recover status to `online` the moment samples resume.
    collector.onError = error => {
      if (!isCurrent()) {
        return;
      }
      this._setStatus('offline', error.message);
    };
    collector.onClosed = () => {
      if (!isCurrent()) {
        return;
      }
      this._collectorDied(this._error || 'The connection closed.');
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
    // Only claim 'online' if nothing moved us off 'connecting' while start()
    // was running. This matters because Collector.start() RESOLVES when the
    // sampler channel fails to open — it reports the failure through onError
    // and onClosed rather than throwing — so an unconditional 'online' here
    // would paint a green badge over a connection that is already dead.
    if (this._status === 'connecting') {
      this._setStatus('online', null);
    }
    // A subscriber may have unsubscribed while readFacts()/start() were still
    // in flight. _scheduleStop() no-ops while _collector is null, so that
    // unsubscribe would otherwise be lost and the collector would run forever
    // with nobody listening. Check again now that _collector is set.
    if (this.sse.count() === 0) {
      this._scheduleStop();
    }
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

  // A dead collector must not be left in _collector: isRunning() would lie,
  // subscribe() would refuse to reconnect, and refresh() would call slowNow()
  // on a corpse. Null the field first so a re-entrant callback finds nothing
  // left to do.
  private _collectorDied(message: string): void {
    const collector = this._collector;
    this._collector = null;
    if (collector) {
      try {
        collector.stop();
      } catch (error) {
        // Already gone is exactly what we wanted.
      }
    }
    this._setStatus('offline', message);
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
