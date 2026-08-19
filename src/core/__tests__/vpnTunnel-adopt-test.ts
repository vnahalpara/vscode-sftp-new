import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

type VpnTunnel = typeof import('../vpnTunnel');
type Deps = Parameters<VpnTunnel['__setDeps']>[0];

// Nothing in this file signals a real process: every test injects isPidAlive
// and killPid, so this number is only ever compared, never sent a signal.
const FAKE_PID = 987654;

// Every listening socket and temp dir a test creates, torn down in afterEach.
let servers: net.Server[] = [];
let tmpDirs: string[] = [];
let loaded: VpnTunnel | undefined;

function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected an AddressInfo, got a pipe/unset address');
  }
  return address.port;
}

// Port 0 asks the OS for a port it knows is free, then hands it back. No test
// in this file ever names a port literally, so none of them can collide with a
// real service on the machine running them.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = portOf(server);
      server.close(() => resolve(port));
    });
  });
}

async function anotherFreePort(taken: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await freePort();
    if (port !== taken) {
      return port;
    }
  }
  throw new Error('could not find a second free port');
}

// Something -- anything -- holding the port, standing in for a process that
// got there first. Whether it speaks SOCKS5 is decided by the injected probe,
// not by this server, so it never has to implement the protocol.
function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.resume());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * A stand-in for wireproxy: it reads the port out of the merged config the way
 * the real binary would and listens on it, so waitForPort() sees a live socket
 * without this suite ever spawning a process.
 */
function fakeWireproxy(state: { spawns: number }) {
  return (_bin: string, args: string[]) => {
    state.spawns += 1;
    const conf = fs.readFileSync(args[args.length - 1], 'utf8');
    const match = /BindAddress = 127\.0\.0\.1:(\d+)/.exec(conf);
    if (!match) {
      throw new Error(`merged config has no BindAddress:\n${conf}`);
    }
    const server = net.createServer(socket => socket.resume());
    servers.push(server);
    server.listen(Number(match[1]), '127.0.0.1');

    const child: any = new EventEmitter();
    child.pid = FAKE_PID;
    child.stdout = null;
    child.stderr = null;
    child.kill = () => {
      server.close();
      child.emit('exit', 0);
    };
    return child;
  };
}

interface Harness {
  mod: VpnTunnel;
  vpn: any;
  derivedPort: number;
  state: { spawns: number };
}

/**
 * A fresh copy of the module per test. resetModules() is how a reload is
 * simulated: the in-memory tunnel map starts empty while the marker file and
 * any listening socket survive, which is exactly the situation adoption exists
 * for.
 */
async function harness(overrides: Deps): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-vpn-'));
  tmpDirs.push(dir);
  const configFile = path.join(dir, 'wg0.conf');
  fs.writeFileSync(configFile, '[Interface]\nPrivateKey = not-a-real-key\n');

  // Pin the range to a single free port so derivePort lands somewhere the OS
  // has just told us is available.
  const derivedPort = await freePort();

  jest.resetModules();
  // tslint:disable-next-line:no-var-requires
  const mod: VpnTunnel = require('../vpnTunnel');
  loaded = mod;
  const state = { spawns: 0 };
  // keepAlive false so release() actually tears the tunnel down: this file is
  // about what acquire() does with what a *previous* run left behind, and the
  // release-time assertions below need the teardown to happen. The keepAlive
  // default itself is covered in vpnTunnel-lifecycle-test.ts.
  mod.init(dir, { portRange: `${derivedPort}-${derivedPort}`, keepAlive: false });
  mod.__setDeps({
    isPidAlive: () => true,
    speaksSocks5: async () => false,
    killPid: () => undefined,
    spawnProcess: fakeWireproxy(state) as any,
    ...overrides,
  });

  return { mod, vpn: { configFile }, derivedPort, state };
}

function plantMarker(h: Harness, marker: any): void {
  const markerPath = h.mod.markerPathFor(h.vpn);
  fse.ensureDirSync(path.dirname(markerPath));
  fs.writeFileSync(markerPath, typeof marker === 'string' ? marker : JSON.stringify(marker));
}

/**
 * A marker exactly as a running tunnel of ours would have left it: every field
 * present and current-boot. Tests about one particular gate override just the
 * field that gate reads, so the marker fails for the reason under test rather
 * than incidentally for some other one.
 */
function ourMarker(port: number, pid: number, overrides: any = {}): any {
  return { port, pid, startedAt: Date.now(), uptimeAtWrite: os.uptime(), ...overrides };
}

// release() finishes on a promise chain; let it drain before asserting.
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

afterEach(async () => {
  if (loaded) {
    loaded.__resetDeps();
    loaded = undefined;
  }
  await Promise.all(
    servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  servers = [];
  tmpDirs.forEach(dir => fse.removeSync(dir));
  tmpDirs = [];
});

describe('tunnel adoption', () => {
  test('adopts when marker matches, pid is alive and the port speaks SOCKS5', async () => {
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    await expect(h.mod.acquire(h.vpn)).resolves.toBe(h.derivedPort);
    // The whole point: no second wireproxy.
    expect(h.state.spawns).toBe(0);
  });

  test('does NOT adopt when there is no marker', async () => {
    // A stranger's SOCKS5 proxy on our port. It answers the handshake
    // perfectly, and that is precisely why the handshake alone cannot decide.
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('does NOT adopt when the marker names a different port', async () => {
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort + 1, FAKE_PID));

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('does NOT adopt when the marker pid is dead', async () => {
    const h = await harness({ isPidAlive: () => false, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('does NOT adopt when the port does not answer SOCKS5', async () => {
    // A stale marker whose pid got recycled onto something unrelated: the
    // marker checks all pass, the protocol check is what catches it.
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => false });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('does NOT adopt when the marker file is corrupt JSON', async () => {
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    plantMarker(h, '{ half a marker, interrupted by a crash');

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('an explicit vpn.socksPort wins over the derived port', async () => {
    const h = await harness({});
    h.vpn.socksPort = await anotherFreePort(h.derivedPort);

    const port = await h.mod.acquire(h.vpn);
    expect(port).toBe(h.vpn.socksPort);
    expect(port).not.toBe(h.derivedPort);
  });

  test('falls back to a free port when the derived port is occupied by a non-SOCKS service', async () => {
    const h = await harness({ speaksSocks5: async () => false });
    await occupy(h.derivedPort);

    const port = await h.mod.acquire(h.vpn);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('fails loudly when an explicit vpn.socksPort is held by something not ours', async () => {
    // The dangerous case. There is no marker, so the listener is a stranger's,
    // and the port is pinned so we cannot step aside. Spawning wireproxy
    // anyway is what the old code did, on the belief that it would fail to
    // bind and say so -- it does not say so anywhere we look. The health check
    // is a bare TCP connect, which the stranger answers, so we would report
    // "VPN tunnel up", write an ownership marker for a port we never bound,
    // and hand the SSH handshake to whoever is on the other end.
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    const pinned = await anotherFreePort(h.derivedPort);
    h.vpn.socksPort = pinned;
    await occupy(pinned);

    await expect(h.mod.acquire(h.vpn)).rejects.toThrow(/already in use/);
    expect(h.state.spawns).toBe(0);
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });

  test('an out-of-range vpn.socksPort falls back to the derived port', async () => {
    // 70000 is not a port. It used to reach net.connect() and surface as a raw
    // Node throw on the connection path.
    const h = await harness({});
    h.vpn.socksPort = 70000;

    await expect(h.mod.acquire(h.vpn)).resolves.toBe(h.derivedPort);
  });
});

describe('marker shape validation', () => {
  // Every row is a marker that parses as JSON but is not a marker. Adoption
  // requires the marker's port to match and its pid to be a real pid; a shape
  // check that let any of these through would hand a hand-edited or truncated
  // file the authority to say "that listener is ours".
  //
  // The pid-shaped rows are the ones with teeth: their port *does* match, so
  // with the shape check gone they reach isPidAlive() and the probe -- both
  // of which say yes here -- and the tunnel gets adopted.
  const cases: Array<[string, any]> = [
    ['a port that is not a number', { port: 'abc', pid: 4242, startedAt: 0 }],
    ['a negative port', { port: -1, pid: 4242, startedAt: 0 }],
    ['a fractional port', { port: 1.5, pid: 4242, startedAt: 0 }],
    ['a port above 65535', { port: 70000, pid: 4242, startedAt: 0 }],
    ['a pid that is not a number', { pid: 'x' }],
    ['a negative pid', { pid: -1 }],
    ['a fractional pid', { pid: 1.5 }],
    ['a zero pid', { pid: 0 }],
    ['no fields at all', {}],
    ['a JSON null', null],
    ['a JSON array', []],
  ];

  test.each(cases)('does NOT adopt on %s', async (_name, shape) => {
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    // The pid-shaped rows carry no port of their own, so give them the one
    // that matches: without it they would be rejected for the wrong reason.
    const marker =
      shape && !Array.isArray(shape) && shape.pid !== undefined && shape.port === undefined
        ? { ...ourMarker(h.derivedPort, shape.pid), ...shape, port: h.derivedPort }
        : shape;
    plantMarker(h, marker);

    const port = await h.mod.acquire(h.vpn);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });
});

describe('ownership marker', () => {
  test('writes a marker when it starts a tunnel, and removes it on release', async () => {
    const h = await harness({});

    const port = await h.mod.acquire(h.vpn);
    expect(port).toBe(h.derivedPort);
    const marker = JSON.parse(fs.readFileSync(h.mod.markerPathFor(h.vpn), 'utf8'));
    expect(marker.port).toBe(port);
    expect(marker.pid).toBe(FAKE_PID);

    h.mod.release(h.vpn);
    await settle();
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });

  test('releasing an adopted tunnel kills the recorded pid and drops the marker', async () => {
    const killed: number[] = [];
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => true,
      killPid: pid => {
        killed.push(pid);
      },
    });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    await h.mod.acquire(h.vpn);
    h.mod.release(h.vpn);
    await settle();

    expect(killed).toEqual([FAKE_PID]);
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });

  test('releasing an adopted tunnel does not signal a pid the marker no longer names', async () => {
    // We hold no child handle on an adopted tunnel, only a number someone
    // wrote down. Re-reading the marker at release time is the last check
    // before a SIGTERM: if it has changed, the pid we remember may since have
    // been recycled onto a program that has nothing to do with us.
    const killed: number[] = [];
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => true,
      killPid: pid => killed.push(pid),
    });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    await h.mod.acquire(h.vpn);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID + 1));

    h.mod.release(h.vpn);
    await settle();

    expect(killed).toEqual([]);
  });

  test('releasing an adopted tunnel does not signal once the marker is gone', async () => {
    const killed: number[] = [];
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => true,
      killPid: pid => killed.push(pid),
    });
    await occupy(h.derivedPort);
    plantMarker(h, ourMarker(h.derivedPort, FAKE_PID));

    await h.mod.acquire(h.vpn);
    fs.unlinkSync(h.mod.markerPathFor(h.vpn));

    h.mod.release(h.vpn);
    await settle();

    expect(killed).toEqual([]);
  });
});

describe('portFor', () => {
  test('portFor returns undefined when no tunnel is running', async () => {
    const h = await harness({});
    expect(h.mod.portFor(h.vpn)).toBeUndefined();

    const port = await h.mod.acquire(h.vpn);
    expect(h.mod.portFor(h.vpn)).toBe(port);

    h.mod.release(h.vpn);
    await settle();
    expect(h.mod.portFor(h.vpn)).toBeUndefined();
  });
});
