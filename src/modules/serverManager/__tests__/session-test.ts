import { ManagedSession, CollectorLike, SessionDeps } from '../session';
import { RedactedProfile } from '../registry';
import { SseSink } from '../sse';
import { HostFacts, Snapshot, SlowData } from '../../monitor/types';

const PROFILE: RedactedProfile = {
  id: 'abc123',
  name: 'prod',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  privilegedAs: 'deploy',
  protocol: 'sftp',
  remotePath: '/var/www',
  workspace: '/ws',
  hasVpn: false,
  hasDatabase: false,
  hasCloudflare: false,
};

const FACTS: HostFacts = {
  hostname: 'web1',
  prettyName: 'Ubuntu 24.04.4 LTS',
  distroId: 'ubuntu',
  cpuModel: 'Test CPU',
  arch: 'x86_64',
  cores: 2,
  pageSize: 4096,
  serverEpochMs: 1000,
  linux: true,
};

class FakeCollector implements CollectorLike {
  onSnapshot: (s: Snapshot) => void = () => undefined;
  onSlow: (s: SlowData) => void = () => undefined;
  onError: (e: Error) => void = () => undefined;
  onClosed: () => void = () => undefined;

  started = 0;
  stopped = 0;
  slowCalls = 0;

  async start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  async slowNow() {
    this.slowCalls++;
  }
  history() {
    return { points: () => [{ at: 1, one: 0.5, five: 0.4, fifteen: 0.3 }] };
  }
}

class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
  events(): string[] {
    return this.chunks
      .filter(c => c.indexOf('event: ') === 0)
      .map(c => c.slice('event: '.length, c.indexOf('\n')));
  }
  // Scans from the most recent frame backwards: `_setStatus` emits a `state`
  // frame on every transition and `subscribe()` sends one immediately, so the
  // first matching frame is always the initial `idle` one, not the current one.
  payload(event: string): any {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (c.indexOf(`event: ${event}\n`) === 0) {
        return JSON.parse(c.slice(c.indexOf('data: ') + 'data: '.length));
      }
    }
    throw new Error(`no ${event} frame in ${JSON.stringify(this.chunks)}`);
  }
}

interface Harness {
  session: ManagedSession;
  collector: FakeCollector;
  // Every collector the session was handed, in order. With the default shared
  // collector these are all the same object; `distinctCollectors` makes each
  // one a fresh instance so a superseded collector can still be poked.
  collectors: FakeCollector[];
  runTimers(): void;
  factsCalls(): number;
  collectorCalls(): number;
}

function harness(
  overrides: { facts?: HostFacts; factsError?: Error; distinctCollectors?: boolean } = {}
): Harness {
  const collector = new FakeCollector();
  const collectors: FakeCollector[] = [];
  let timers: (() => void)[] = [];
  let factsCalls = 0;

  const deps: SessionDeps = {
    transport: { openSampler: async () => ({} as any), exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
    privilegedTransport: {
      openSampler: async () => ({} as any),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    },
    async readFacts() {
      factsCalls++;
      if (overrides.factsError) {
        throw overrides.factsError;
      }
      return overrides.facts || FACTS;
    },
    makeCollector: () => {
      const made = overrides.distinctCollectors ? new FakeCollector() : collector;
      collectors.push(made);
      return made;
    },
    schedule(fn: () => void) {
      timers.push(fn);
      return timers.length - 1;
    },
    cancel(handle: any) {
      timers[handle as number] = () => undefined;
    },
    now: () => 1234,
  };

  const session = new ManagedSession(PROFILE, 'tok', deps, { graceMs: 30000, interval: 2000 });
  return {
    session,
    collector,
    collectors,
    runTimers() {
      const due = timers;
      timers = [];
      due.forEach(fn => fn());
    },
    factsCalls: () => factsCalls,
    collectorCalls: () => collectors.length,
  };
}

describe('ManagedSession', () => {
  it('exposes privilegedTransport as its own lane, distinct from transport', () => {
    const transport = { openSampler: async () => ({} as any), exec: async () => ({ stdout: 'session', stderr: '', code: 0 }) };
    const privilegedTransport = { openSampler: async () => ({} as any), exec: async () => ({ stdout: 'root', stderr: '', code: 0 }) };
    const session = new ManagedSession(
      PROFILE,
      'tok',
      {
        transport,
        privilegedTransport,
        readFacts: async () => FACTS,
        makeCollector: () => new FakeCollector(),
        schedule: () => 0,
        cancel: () => undefined,
        now: () => 1234,
      },
      { graceMs: 30000, interval: 2000 }
    );

    expect(session.transport).toBe(transport);
    expect(session.privilegedTransport).toBe(privilegedTransport);
    expect(session.privilegedTransport).not.toBe(session.transport);
  });

  it('starts idle with no collector running', () => {
    const h = harness();
    expect(h.session.state().status).toBe('idle');
    expect(h.session.isRunning()).toBe(false);
    expect(h.collector.started).toBe(0);
  });

  it('starts the collector when the first subscriber arrives', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    expect(h.collector.started).toBe(1);
    expect(h.session.state().status).toBe('online');
  });

  it('sends the current state to a subscriber immediately', () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);

    expect(sink.events()[0]).toBe('state');
    expect(sink.payload('state').profile.host).toBe('10.0.0.5');
  });

  it('does not start a second collector for a second subscriber', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    expect(h.collector.started).toBe(1);
    expect(h.session.subscriberCount()).toBe(2);
  });

  it('forwards a snapshot to every subscriber with the history attached', async () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    h.collector.onSnapshot({ at: 5 } as any);

    const tick = sink.payload('tick');
    expect(tick.snapshot.at).toBe(5);
    expect(tick.history.length).toBe(1);
  });

  it('replays the last snapshot to a subscriber that joins later', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.collector.onSnapshot({ at: 5 } as any);

    const late = new FakeSink();
    h.session.subscribe(late);

    expect(late.payload('tick').snapshot.at).toBe(5);
  });

  it('does not stop the collector until the grace period elapses', async () => {
    const h = harness();
    const off = h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    off();
    expect(h.collector.stopped).toBe(0);

    h.runTimers();
    expect(h.collector.stopped).toBe(1);
    expect(h.session.isRunning()).toBe(false);
  });

  it('survives a reload inside the grace period without restarting SSH', async () => {
    const h = harness();
    const off = h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    off();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.runTimers();

    expect(h.collector.stopped).toBe(0);
    expect(h.collector.started).toBe(1);
    expect(h.factsCalls()).toBe(1);
  });

  it('reports a non-Linux host as unsupported and never starts the collector', async () => {
    const h = harness({ facts: { ...FACTS, linux: false } });
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('unsupported');
    expect(h.collector.started).toBe(0);
    expect(sink.payload('state').error).toContain('Linux');
  });

  it('reports a failed connection as offline with the error text', async () => {
    const h = harness({ factsError: new Error('connect ETIMEDOUT') });
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('offline');
    expect(h.session.state().error).toContain('ETIMEDOUT');
    expect(sink.payload('state').status).toBe('offline');
  });

  it('goes offline when the collector reports the channel closed', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    h.collector.onClosed();

    expect(h.session.state().status).toBe('offline');
  });

  it('runs the slow lane on refresh', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    await h.session.refresh();

    expect(h.collector.slowCalls).toBe(1);
  });

  it('retries the connection on refresh when it is offline', async () => {
    const h = harness({ factsError: new Error('connect ETIMEDOUT') });
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    await h.session.refresh();

    expect(h.factsCalls()).toBe(2);
  });

  it('stays offline when the sampler fails during start without throwing', async () => {
    const h = harness();
    // The real Collector does NOT throw when the sampler channel fails to open:
    // it reports the failure through onError and start() resolves normally. The
    // session must not then claim 'online' over the top of that.
    h.collector.start = async function() {
      this.started++;
      this.onError(new Error('openSampler failed: channel refused'));
    };
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('offline');
    expect(h.session.state().error).toContain('channel refused');
    expect(sink.payload('state').status).toBe('offline');
  });

  it('still reaches online when start succeeds', async () => {
    // The guard above must not stop a healthy connection from going online.
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('online');
  });

  it('stops the collector and ends every stream on dispose', async () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    h.session.dispose();

    expect(h.collector.stopped).toBe(1);
    expect(sink.ended).toBe(true);
    expect(h.session.subscriberCount()).toBe(0);
  });

  it('arms the grace timer when the last subscriber leaves while still connecting', async () => {
    const h = harness();
    const off = h.session.subscribe(new FakeSink());
    off();                        // before readFacts has resolved
    await h.session.whenSettled();

    h.runTimers();

    expect(h.collector.stopped).toBe(1);
    expect(h.session.isRunning()).toBe(false);
  });

  it('clears the collector when the channel closes, so a later subscriber reconnects', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    h.collector.onClosed();
    expect(h.session.isRunning()).toBe(false);

    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    expect(h.collector.started).toBe(2);
  });

  it('reconnects rather than sampling a dead collector on refresh', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.collector.onClosed();

    await h.session.refresh();

    expect(h.factsCalls()).toBe(2);
    expect(h.collector.slowCalls).toBe(0);
  });

  it('does not start a rival collector when refresh lands mid-connect', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    // subscribe() ran _start() synchronously up to `await readFacts`, so the
    // session is connecting with a null collector: exactly the window in which
    // an unguarded refresh() would build and start() a second collector that
    // nothing would ever stop.
    expect(h.session.state().status).toBe('connecting');

    await h.session.refresh();
    await h.session.whenSettled();

    expect(h.factsCalls()).toBe(1);
    expect(h.collectorCalls()).toBe(1);
    expect(h.collector.started).toBe(1);
    expect(h.session.state().status).toBe('online');
  });

  it('ignores callbacks arriving from a superseded collector', async () => {
    const h = harness({ distinctCollectors: true });
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    const dead = h.collectors[0];
    dead.onClosed();
    expect(h.session.isRunning()).toBe(false);

    // A refresh brings a fresh collector up; the dead one is now a ghost that
    // may still have samples or a close event in flight.
    await h.session.refresh();
    expect(h.collectorCalls()).toBe(2);
    expect(h.session.state().status).toBe('online');

    const sink = new FakeSink();
    h.session.subscribe(sink);
    h.collectors[1].onSnapshot({ at: 7 } as any);

    dead.onSnapshot({ at: 99 } as any);
    dead.onSlow({ ghost: true } as any);
    dead.onError(new Error('ghost error'));
    dead.onClosed();

    expect(sink.payload('tick').snapshot.at).toBe(7);
    expect(sink.events()).not.toContain('slow');
    expect(h.session.state().status).toBe('online');
    expect(h.session.state().error).toBeNull();
    expect(h.session.isRunning()).toBe(true);
  });

  it('returns to online once samples resume after a transient error', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    h.collector.onError(new Error('one bad sample'));
    expect(h.session.state().status).toBe('offline');

    h.collector.onSnapshot({ at: 7 } as any);

    expect(h.session.state().status).toBe('online');
    expect(h.session.isRunning()).toBe(true);
  });
});
