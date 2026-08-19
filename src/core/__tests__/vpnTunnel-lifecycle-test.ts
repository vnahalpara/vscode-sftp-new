import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

type VpnTunnel = typeof import('../vpnTunnel');
type Deps = Parameters<VpnTunnel['__setDeps']>[0];

// The pid the fake wireproxy reports for whatever it spawns this run -- never
// signalled for real, only ever compared. Distinct from OLD_PID below so a
// reaped process and its replacement can never be mistaken for each other in
// an assertion.
const FAKE_PID = 424242;
// The pid recorded in a marker planted by the test itself, standing in for a
// previous run's wireproxy that this run did not spawn.
const OLD_PID = 555555;

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

// Something -- anything -- bound to the port, standing in for a wireproxy
// process (ours or a stranger's) that is already there when acquire() runs.
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

async function harness(
  overrides: Deps,
  initOptions: { keepAlive?: boolean } = {}
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-vpn-lifecycle-'));
  tmpDirs.push(dir);
  const configFile = path.join(dir, 'wg0.conf');
  fs.writeFileSync(configFile, '[Interface]\nPrivateKey = not-a-real-key\n');

  const derivedPort = await freePort();

  jest.resetModules();
  // tslint:disable-next-line:no-var-requires
  const mod: VpnTunnel = require('../vpnTunnel');
  loaded = mod;
  const state = { spawns: 0 };
  mod.init(dir, { portRange: `${derivedPort}-${derivedPort}`, keepAlive: initOptions.keepAlive });
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

// release() and disposeAll() both finish on a promise chain; let it drain
// before asserting.
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

describe('keepAlive', () => {
  test('release() with keepAlive true leaves the tunnel running for reuse', async () => {
    const h = await harness({}, { keepAlive: true });

    const port = await h.mod.acquire(h.vpn);
    h.mod.release(h.vpn);
    await settle();

    // Not killed: still tracked, marker still on disk, no second spawn needed.
    expect(h.mod.portFor(h.vpn)).toBe(port);
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(true);
    expect(h.state.spawns).toBe(1);

    // The next acquire() reuses it rather than starting another.
    await expect(h.mod.acquire(h.vpn)).resolves.toBe(port);
    expect(h.state.spawns).toBe(1);
  });

  test('release() with keepAlive false kills the tunnel once the last consumer releases', async () => {
    const h = await harness({}, { keepAlive: false });

    await h.mod.acquire(h.vpn);
    h.mod.release(h.vpn);
    await settle();

    expect(h.mod.portFor(h.vpn)).toBeUndefined();
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });

  test('disposeAll() kills the tunnel even when keepAlive is true', async () => {
    const h = await harness({}, { keepAlive: true });

    await h.mod.acquire(h.vpn);
    // No release() at all: disposeAll() must not depend on the refcount
    // having been drawn down first, keepAlive or not.
    h.mod.disposeAll();
    await settle();

    expect(h.mod.portFor(h.vpn)).toBeUndefined();
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });

  test('disposeAll() kills a tunnel kept alive past a release()', async () => {
    const h = await harness({}, { keepAlive: true });

    await h.mod.acquire(h.vpn);
    h.mod.release(h.vpn);
    await settle();
    expect(h.mod.portFor(h.vpn)).toBeDefined(); // still up, per keepAlive

    h.mod.disposeAll();
    await settle();

    expect(h.mod.portFor(h.vpn)).toBeUndefined();
    expect(fs.existsSync(h.mod.markerPathFor(h.vpn))).toBe(false);
  });
});

describe('reaping a hung tunnel', () => {
  test('kills our own hung tunnel and removes its marker before starting the replacement', async () => {
    const killed: number[] = [];
    // Assigned once occupy() resolves, below -- captured by reference so a
    // single harness() call (a second __setDeps() would silently drop the
    // isPidAlive/speaksSocks5 overrides set here, since it replaces the whole
    // deps object rather than merging into it) can still reach it from
    // killPid.
    let stale: net.Server | undefined;
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => false,
      killPid: pid => {
        killed.push(pid);
        // Simulate what actually killing the real process does: it stops
        // holding the port, which is why the replacement below can bind it.
        if (stale) {
          stale.close();
        }
      },
    });
    stale = await occupy(h.derivedPort);
    plantMarker(h, { port: h.derivedPort, pid: OLD_PID, startedAt: Date.now() });

    const port = await h.mod.acquire(h.vpn);

    expect(killed).toEqual([OLD_PID]);
    // Reused the same derived port -- the whole point of derivePort() -- not
    // some unrelated free port, and only one replacement was ever spawned.
    expect(port).toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
    const marker = JSON.parse(fs.readFileSync(h.mod.markerPathFor(h.vpn), 'utf8'));
    expect(marker.pid).toBe(FAKE_PID);
    expect(marker.pid).not.toBe(OLD_PID);
  });

  test('a tunnel that misses a single probe is adopted, not killed', async () => {
    // A healthy wireproxy that loses one 300ms loopback round trip to a busy
    // machine. Killing it would take down a tunnel another window may be
    // transferring over, so the reap path has to ask again before escalating.
    const killed: number[] = [];
    let probes = 0;
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => {
        probes += 1;
        return probes > 1;
      },
      killPid: pid => killed.push(pid),
    });
    await occupy(h.derivedPort);
    plantMarker(h, { port: h.derivedPort, pid: OLD_PID, startedAt: Date.now() });

    const port = await h.mod.acquire(h.vpn);

    expect(killed).toEqual([]);
    expect(port).toBe(h.derivedPort);
    expect(h.state.spawns).toBe(0); // adopted, not replaced
    expect(probes).toBeGreaterThan(1);
  });

  test('a marker written before this boot is never reaped', async () => {
    // Force-quit VS Code and the marker outlives the reboot. The pid it names
    // is definitionally recycled by now -- pids restart from scratch every
    // boot -- so whatever is alive under it is an unrelated program, and its
    // failure to answer SOCKS5 is exactly what we should expect, not evidence
    // that a tunnel of ours is wedged.
    const killed: number[] = [];
    const h = await harness({
      isPidAlive: () => true,
      speaksSocks5: async () => false,
      killPid: pid => killed.push(pid),
    });
    await occupy(h.derivedPort);
    // 1970: earlier than any machine's boot, however long its uptime.
    plantMarker(h, { port: h.derivedPort, pid: OLD_PID, startedAt: 1 });

    const port = await h.mod.acquire(h.vpn);

    expect(killed).toEqual([]);
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('a marker written before this boot is not adopted either', async () => {
    // Same reasoning in the other direction: the marker cannot prove the
    // listener is ours, and adopting a stranger's SOCKS5 proxy hands it the
    // user's SSH session.
    const h = await harness({ isPidAlive: () => true, speaksSocks5: async () => true });
    await occupy(h.derivedPort);
    plantMarker(h, { port: h.derivedPort, pid: OLD_PID, startedAt: 1 });

    const port = await h.mod.acquire(h.vpn);

    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });

  test('a marker naming a dead pid is left alone -- no kill attempted', async () => {
    const killed: number[] = [];
    const h = await harness({
      isPidAlive: () => false,
      speaksSocks5: async () => false,
      killPid: pid => killed.push(pid),
    });
    await occupy(h.derivedPort);
    plantMarker(h, { port: h.derivedPort, pid: OLD_PID, startedAt: Date.now() });

    const port = await h.mod.acquire(h.vpn);

    expect(killed).toEqual([]);
    // Not provably ours to reap, so it stepped aside to a free port instead.
    expect(port).not.toBe(h.derivedPort);
    expect(h.state.spawns).toBe(1);
  });
});
