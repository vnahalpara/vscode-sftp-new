import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import logger from '../logger';

/**
 * Per-connection VPN tunnel via a userspace WireGuard client (wireproxy) that
 * exposes a local SOCKS5 proxy. Only the SSH/SFTP socket is routed through it,
 * so the rest of the machine is untouched and no root/admin is required.
 *
 * One wireproxy process is shared (refcounted) per unique config file, so
 * multiple connections to the same VPN reuse a single tunnel.
 */
export interface VpnOption {
  type?: 'wireguard';
  configFile: string;
  wireproxyPath?: string;
  // 0 / undefined => pick a free localhost port at runtime
  socksPort?: number;
  healthCheckTimeout?: number;
}

interface Tunnel {
  key: string;
  port: number;
  pid: number;
  // Absent for an adopted tunnel: a previous extension run spawned it, so we
  // know its pid from the marker but hold no child handle on it.
  process?: ChildProcess;
  mergedConfPath: string;
  refCount: number;
}

/**
 * What a running tunnel leaves behind so the next extension run can recognise
 * it as ours. See canAdopt() for why recognising it matters.
 */
interface TunnelMarker {
  port: number;
  pid: number;
  startedAt: number;
}

const DEFAULT_HEALTHCHECK_MS = 15000;

/**
 * The writable directory init() gave us, for merged configs and markers.
 * Undefined until then, and deliberately *not* defaulted to os.tmpdir(): this
 * directory is the root of trust for adoption. The marker file inside it is
 * the only thing standing between "reuse the tunnel already on this port" and
 * "route the user's SSH credentials through a stranger's proxy", and a
 * world-writable shared path cannot carry that weight -- anyone with an
 * account on the machine could plant a marker there. Production always calls
 * init() (extension.ts, during activate, with the extension's own
 * globalStoragePath), so the guards keyed off this never fire in practice;
 * they exist so a future caller that forgets gets a hard failure instead of a
 * silently downgraded trust boundary.
 */
let storageDir: string | undefined;
// The user's port-range setting, as typed. Parsed (and defaulted) per use.
let portRangeSetting: string | undefined;
// Mirrors "sftp.vpn.keepAlive": leave the process running across a release()
// that drops the refcount to zero, so the next acquire() reuses it instead of
// paying the wireproxy startup cost (and health-check wait) again. Defaults
// to true, matching the setting's own default in package.json, so a caller
// that passes no opinion gets the documented behaviour rather than its
// opposite.
let keepAliveSetting = true;

// key (resolved config path) -> live tunnel or its pending start promise
const tunnels = new Map<string, Tunnel | Promise<Tunnel>>();

export function init(dir: string, options: { portRange?: string; keepAlive?: boolean } = {}) {
  storageDir = typeof dir === 'string' && dir.length > 0 ? dir : undefined;
  portRangeSetting = options.portRange;
  keepAliveSetting = options.keepAlive !== false;
}

function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function tunnelKey(vpn: VpnOption): string {
  return path.resolve(expandHome(vpn.configFile));
}

const DEFAULT_PORT_RANGE: [number, number] = [21000, 21999];
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * Parse the user-editable "vpn.socksPortRange" setting ("low-high") into a
 * bounded tuple. This runs on the connection path every time a tunnel is
 * acquired, so a typo (missing dash, swapped bounds, an out-of-range number)
 * must never throw -- that would break every SFTP connection on the machine,
 * not just the VPN ones. Any input that isn't a clean "low-high" pair inside
 * 1024-65535 with low <= high silently falls back to the default range.
 *
 * The declared type is `string | undefined`, but the value comes out of a
 * hand-editable JSON settings file, so `"portRange": 21000` -- quotes and
 * dash forgotten -- is an ordinary typo that arrives here as a number. Hence
 * the typeof check rather than trusting the signature.
 */
export function parsePortRange(value: string | undefined): [number, number] {
  if (!value || typeof value !== 'string') {
    return DEFAULT_PORT_RANGE;
  }
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) {
    return DEFAULT_PORT_RANGE;
  }
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (
    !Number.isInteger(low) ||
    !Number.isInteger(high) ||
    low < MIN_PORT ||
    high > MAX_PORT ||
    low > high
  ) {
    return DEFAULT_PORT_RANGE;
  }
  return [low, high];
}

/**
 * Map a stable key (the resolved WireGuard config path) onto a port inside
 * the given range. Deterministic so the same config always lands on the same
 * SOCKS port across restarts -- anything that recorded the old random port
 * (a ProxyCommand, a note in sftp.json) keeps working instead of going stale.
 */
export function derivePort(key: string, range: [number, number]): number {
  const h = crypto.createHash('sha256').update(key).digest();
  return range[0] + (h.readUInt16BE(0) % (range[1] - range[0] + 1));
}

const SOCKS5_GREETING = Buffer.from([0x05, 0x01, 0x00]);
const DEFAULT_PROBE_TIMEOUT_MS = 300;

// Before concluding that a tunnel of ours is wedged -- the one conclusion in
// this file that ends in a SIGTERM -- the probe is repeated, with a timeout
// several times the 300ms the adopt path is happy with. Adopting wrongly
// costs one extra wireproxy; killing wrongly can take down another window's
// tunnel mid-transfer, so the two decisions do not deserve the same
// confidence. A healthy wireproxy that misses one 300ms loopback round trip
// -- a saturated CPU, a swapping machine, a laptop a second out of sleep --
// must not be mistaken for a dead one.
const REAP_PROBE_ATTEMPTS = 3;
const REAP_PROBE_TIMEOUT_MS = 2000;
const REAP_PROBE_DELAY_MS = 100;

// A port we could actually connect to or bind: whole, positive, in range.
// Deliberately wider than the MIN_PORT..MAX_PORT range setting, since an
// explicit vpn.socksPort or a marker may legitimately name a low port.
// Accepts `undefined` (and, via the typeof, anything else JSON can hold) so
// callers holding an optional or unvalidated port can funnel through it
// instead of hand-rolling the same check.
function isUsablePort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= MAX_PORT;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ask whether something on `port` actually speaks SOCKS5, by sending the
 * handshake greeting and checking that the reply is exactly "version 5,
 * no-auth selected". Used to decide whether an already-bound port is a live
 * tunnel worth adopting rather than some unrelated service that happens to
 * be sitting on the port we derived.
 *
 * Why 0x05 0x00 and not just "first byte is 5": a server that answers
 * 0x05 0xFF is a real SOCKS5 server refusing every auth method we offered,
 * and ours never does that -- wireproxy offers and accepts no-auth. So 0xFF
 * is positive evidence the listener is *not* our tunnel, and this probe
 * exists to help establish that it is. Do not loosen this back to a version
 * check.
 *
 * This runs on the connection path, so it must never reject and must never
 * leave a socket (or a pending timer) behind -- either would hang or break
 * every SFTP connection, VPN or not. Every exit -- good reply, wrong
 * version, error, close, or timeout -- funnels through `finish()`, which is
 * itself guarded to run at most once since more than one of those can fire
 * for the same socket (e.g. 'error' followed by 'close').
 */
export function probeSocks5(port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  // net.connect() validates the port synchronously and *throws* for a
  // negative, fractional, out-of-range or NaN one -- no 'error' event, so the
  // throw would escape this executor as a rejected promise. Ports get here
  // from a marker file, which is only JSON on disk: a truncated write or a
  // hand-edit can leave any of those behind, and -1 or 1.5 are perfectly
  // valid JSON numbers that no shape check would reject. Answer false.
  if (!isUsablePort(port)) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    let settled = false;
    let received = 0;
    const chunks: Buffer[] = [];

    const socket = net.connect(port, '127.0.0.1');

    const timer = setTimeout(() => finish(false), timeoutMs);

    function finish(result: boolean) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // 'error' must still be handled even after we're done with the
      // socket, or a late ECONNRESET while we're destroying it becomes an
      // uncaught exception.
      socket.on('error', () => {
        /* already resolved; nothing left to do */
      });
      socket.destroy();
      resolve(result);
    }

    socket.once('connect', () => {
      socket.write(SOCKS5_GREETING);
    });

    // A real SOCKS5 reply is 2 bytes (version, chosen method), and they can
    // arrive split across TCP segments -- a lone first byte (even 0x05)
    // proves nothing, so wait for both before deciding. A server that sends
    // one byte and stalls falls through to the timeout below, as it should.
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= 2) {
        const reply = Buffer.concat(chunks);
        finish(reply[0] === 0x05 && reply[1] === 0x00);
      }
    });

    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

/**
 * Append the `[Socks5]` section wireproxy needs onto a user's WireGuard conf,
 * binding the proxy to the given localhost port. Pure (no I/O) so it is unit-testable.
 */
export function mergeSocksConfig(userConf: string, port: number): string {
  return `${userConf.replace(/\s+$/, '')}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

/**
 * The pieces of the outside world this module has to touch to decide whether a
 * port already in use is our own tunnel. They are injectable because every one
 * of them is otherwise untestable: a real pid check needs a real process, the
 * probe needs a real listener, and the spawn needs wireproxy installed. The
 * defaults below are what production always runs.
 */
export interface TunnelDeps {
  isPidAlive(pid: number): boolean;
  speaksSocks5(port: number, timeoutMs?: number): Promise<boolean>;
  killPid(pid: number): void;
  spawnProcess(bin: string, args: string[]): ChildProcess;
}

const defaultDeps: TunnelDeps = {
  isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      // Signal 0 delivers nothing; it only asks whether the pid exists.
      process.kill(pid, 0);
      return true;
    } catch (_e) {
      // Includes EPERM, which means the pid exists but belongs to another
      // user -- so it cannot be the wireproxy we spawned as ourselves.
      // Reporting "not alive" there is the safe answer: the marker's job is
      // to prove the listener is our process, and this one demonstrably isn't.
      return false;
    }
  },
  speaksSocks5: (port, timeoutMs) => probeSocks5(port, timeoutMs),
  killPid: pid => process.kill(pid),
  spawnProcess: (bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
};

let deps: TunnelDeps = defaultDeps;

/** Test seam. Production code never calls this. */
export function __setDeps(overrides: Partial<TunnelDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** Test seam. Production code never calls this. */
export function __resetDeps(): void {
  deps = defaultDeps;
}

function vpnDir(): string {
  // See storageDir's comment: without a directory of our own there is nowhere
  // to keep a merged config (it embeds the WireGuard private key) or a marker
  // anyone else could not forge, so refusing to run is the only honest answer.
  if (!storageDir) {
    throw new Error(
      'VPN tunnel storage directory is not configured; vpnTunnel.init() must run first.'
    );
  }
  return path.join(storageDir, 'vpn');
}

function keyHash(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function mergedConfPathFor(key: string): string {
  return path.join(vpnDir(), `${keyHash(key)}.conf`);
}

function markerPathForKey(key: string): string {
  return path.join(vpnDir(), `${keyHash(key)}.marker.json`);
}

/**
 * Where the ownership marker for a VPN config lives. Exported so tests can
 * plant and corrupt markers without reaching into module internals.
 */
export function markerPathFor(vpn: VpnOption): string {
  return markerPathForKey(tunnelKey(vpn));
}

/**
 * Read the marker for a key, or undefined when there isn't a usable one.
 * Anything unexpected -- no file, a write truncated by a crash, a hand-edit,
 * the right JSON with the wrong types -- is reported as "no marker" rather
 * than thrown. A marker can only ever *permit* adoption, so failing to read
 * one costs at worst a second wireproxy, while throwing here would fail the
 * user's connection over a bookkeeping file.
 */
function readMarker(key: string): TunnelMarker | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPathForKey(key), 'utf8'));
  } catch (_e) {
    return undefined;
  }
  if (!parsed || !isUsablePort(parsed.port) || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return undefined;
  }
  return {
    port: parsed.port,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
  };
}

/**
 * Record that this port and pid are ours. Best effort on purpose: if the write
 * fails we still have a working tunnel, and the only cost is that the next
 * extension run won't recognise it and will start its own. Failing the
 * connection over a marker we can live without would be the worse trade.
 */
function writeMarker(key: string, marker: TunnelMarker): void {
  try {
    fse.ensureDirSync(vpnDir());
    fs.writeFileSync(markerPathForKey(key), JSON.stringify(marker), { mode: 0o600 });
  } catch (error) {
    logger.debug(`VPN: could not record the tunnel marker: ${(error as Error).message}`);
  }
}

function removeMarker(key: string): void {
  try {
    fs.unlinkSync(markerPathForKey(key));
  } catch (_e) {
    /* never written, or already gone */
  }
}

// What a marker naming a live pid on `port` turns out to be once probed.
// 'none' also covers "not ours to judge" -- no marker, wrong port, dead pid --
// so callers never have to re-derive that from the marker's fields themselves.
type OwnedPortOutcome =
  | { kind: 'adopt'; marker: TunnelMarker }
  | { kind: 'hung'; marker: TunnelMarker }
  | { kind: 'none' };

/**
 * Is whatever is listening on `port` provably the tunnel a previous run of
 * this extension started -- and if it is, is it actually working?
 *
 * The SOCKS5 handshake alone would not decide ownership: it proves only that
 * *something* there speaks the protocol -- any local process can bind a port
 * in our range and answer correctly. Trusting that would route the user's SSH
 * session, credentials included, through a proxy chosen by whoever won the
 * race to the port; on a shared or compromised machine that is a plain MITM.
 * So the marker (a file only we write, in our own storage directory) is what
 * establishes ownership, and 'none' covers every way it can fail to: absent,
 * naming a different port, naming a pid that is no longer alive.
 *
 * The marker alone would not decide it either: it is a file that outlives the
 * process it describes, so a stale one whose pid has been recycled onto an
 * unrelated program would vouch for a listener that is not a tunnel at all.
 * Given a marker that clears the ownership bar, the probe is what tells adopt
 * ('yes, and it works') apart from hung ('yes, but it has stopped answering')
 * -- the latter is ours to clean up rather than route around.
 */
async function classifyOwnedPort(key: string, port: number): Promise<OwnedPortOutcome> {
  // No storage directory of our own means no marker we can trust, and a
  // marker is the only thing that makes either answer below defensible.
  if (!storageDir) {
    return { kind: 'none' };
  }
  const marker = readMarker(key);
  if (!marker || marker.port !== port || !deps.isPidAlive(marker.pid)) {
    return { kind: 'none' };
  }
  // The pid check above asks "is *a* process alive under this number", which
  // is a different question from "is it still the process the marker meant".
  // Across a reboot the answer is definitively no, so a marker predating the
  // current boot is disqualified outright, however alive its pid looks now.
  if (!markerIsFromThisBoot(marker)) {
    return { kind: 'none' };
  }
  if (await deps.speaksSocks5(port)) {
    return { kind: 'adopt', marker };
  }
  // One missed probe is not grounds for a SIGTERM. Re-ask, patiently, and let
  // a slow-but-healthy tunnel talk its way back into 'adopt'; only a listener
  // that stays silent across every attempt is called hung.
  for (let attempt = 0; attempt < REAP_PROBE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(REAP_PROBE_DELAY_MS);
    }
    if (await deps.speaksSocks5(port, REAP_PROBE_TIMEOUT_MS)) {
      return { kind: 'adopt', marker };
    }
  }
  return { kind: 'hung', marker };
}

/**
 * Was this marker written during the current boot?
 *
 * os.uptime() is seconds since boot, so boot happened at roughly
 * `Date.now() - uptime * 1000`. A marker older than that describes a process
 * from a previous boot -- and pids are handed out afresh every boot, so
 * whatever is alive under that pid now is, with certainty rather than
 * probability, some unrelated program. Force-quitting VS Code leaves exactly
 * such a marker behind; without this check the next run after a reboot would
 * find it, find *a* live pid, find a listener that does not answer SOCKS5,
 * and SIGTERM a stranger.
 *
 * The comparison is deliberately not padded with slack in the permissive
 * direction. Slack there buys nothing except a wider window in which a
 * pre-boot marker passes for a current one, and the cost of the two mistakes
 * is not symmetric: judging a real marker stale leaks one wireproxy, while
 * judging a stale marker real signals a process we know nothing about.
 */
function markerIsFromThisBoot(marker: TunnelMarker): boolean {
  return marker.startedAt >= Date.now() - os.uptime() * 1000;
}

/**
 * Can we have this exact port? Answered by binding rather than connecting: a
 * refused connection could just be a server that dislikes us, while a
 * successful bind is proof nothing else holds the port. It is a check with an
 * inherent race -- something can take the port in the gap before wireproxy
 * binds it -- but losing that race surfaces as wireproxy failing its health
 * check, never as traffic silently going somewhere else.
 */
function isPortFree(port: number): Promise<boolean> {
  if (!isUsablePort(port)) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// Short poll for the OS to actually release a port after we've signalled the
// process holding it. A killed process closes its listening socket as part of
// normal teardown, which is near-instant -- but "near" is not "synchronous
// with process.kill() returning", so a single isPortFree() check right after
// killPid() would be racy. Five tries at 20ms is generous for that teardown
// and still short enough that a lagging or ignored signal fails fast into the
// caller's own fallback rather than stalling the connection.
async function waitForPortFree(port: number, attempts = 5, delayMs = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isPortFree(port)) {
      return true;
    }
    if (i < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Resolve once the SOCKS port accepts a TCP connection, or reject on timeout /
// early process exit.
function waitForPort(
  port: number,
  timeoutMs: number,
  isDead: () => boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (isDead()) {
        return reject(new Error('wireproxy exited before the SOCKS port was ready'));
      }
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          return reject(new Error(`timed out after ${timeoutMs}ms`));
        }
        setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

async function startTunnel(vpn: VpnOption, key: string, port: number): Promise<Tunnel> {
  const confPath = expandHome(vpn.configFile);
  let userConf: string;
  try {
    userConf = fs.readFileSync(confPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read VPN config file "${vpn.configFile}": ${(error as Error).message}`);
  }

  const mergedConf = mergeSocksConfig(userConf, port);

  fse.ensureDirSync(vpnDir());
  const mergedConfPath = mergedConfPathFor(key);
  // 0600: the file embeds the WireGuard private key.
  fs.writeFileSync(mergedConfPath, mergedConf, { mode: 0o600 });

  const bin = vpn.wireproxyPath || 'wireproxy';
  const child = deps.spawnProcess(bin, ['-c', mergedConfPath]);

  let exited = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  // Filled in once this tunnel is built, below; the exit handler needs it to
  // tell "the entry in the map is mine" from "someone has since started a
  // replacement for the same key".
  let started: Tunnel | undefined;
  const forgetIfCurrent = () => {
    if (started && tunnels.get(key) === started) {
      // Without this the map keeps a tunnel whose process is gone, and with
      // keepAlive on it keeps it for the life of the window: acquire() then
      // hands out its port on the `existing` branch with no spawn and no
      // check, pointing the SSH session at a closed port -- or at whatever
      // bound it in the meantime.
      tunnels.delete(key);
    }
  };
  child.on('error', err => {
    spawnError = err as NodeJS.ErrnoException;
    exited = true;
    forgetIfCurrent();
  });
  child.on('exit', () => {
    exited = true;
    forgetIfCurrent();
  });
  // wireproxy's own logs never include the private key; surface them for debugging.
  if (child.stdout) {
    child.stdout.on('data', d => logger.debug(`[wireproxy] ${String(d).trim()}`));
  }
  if (child.stderr) {
    child.stderr.on('data', d => logger.warn(`[wireproxy] ${String(d).trim()}`));
  }

  const timeout = vpn.healthCheckTimeout || DEFAULT_HEALTHCHECK_MS;
  try {
    await waitForPort(port, timeout, () => exited);
    // waitForPort's only evidence is that *something* accepted a TCP
    // connection on the port: it makes no ownership or protocol check, and its
    // first attempt runs synchronously after spawn, before any 'error' or
    // 'exit' has had a chance to fire. So a process that was already squatting
    // the port answers it instantly, and without the check below we would go
    // on to log "VPN tunnel up" and -- far worse -- write an ownership marker
    // for a port we never bound, forging the very proof adoption depends on.
    // Yielding first lets an already-queued exit land before we ask.
    await new Promise(resolve => setImmediate(resolve));
    if (exited) {
      throw new Error('wireproxy exited before the SOCKS port was ready');
    }
  } catch (error) {
    try {
      child.kill();
    } catch (_e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(mergedConfPath);
    } catch (_e) {
      /* ignore */
    }
    if (spawnError && spawnError.code === 'ENOENT') {
      throw new Error(
        `wireproxy not found (tried "${bin}"). Install it (e.g. "brew install wireproxy") ` +
          `or set "vpn.wireproxyPath" in your sftp.json.`
      );
    }
    throw new Error(
      `VPN tunnel failed to start: ${(error as Error).message}. ` +
        `See the SFTP output channel for wireproxy logs.`
    );
  }

  // Stake our claim on the port before anyone waits on it, so a reload that
  // happens seconds from now can tell this listener apart from a stranger's.
  writeMarker(key, { port, pid: child.pid, startedAt: Date.now() });

  logger.info(`VPN tunnel up (SOCKS5 127.0.0.1:${port}) for ${vpn.configFile}`);
  started = { key, port, pid: child.pid, process: child, mergedConfPath, refCount: 1 };
  return started;
}

/**
 * Decide which port this tunnel gets, and whether one is already running on
 * it that we may take over. Order matters: an explicit vpn.socksPort is the
 * user's decision and is never silently moved, the derived port keeps the
 * SOCKS address stable across restarts, and a free port is the last resort so
 * that a port someone else took can never fail the connection outright.
 */
async function openTunnel(vpn: VpnOption, key: string): Promise<Tunnel> {
  // vpn.socksPort comes straight out of a hand-edited sftp.json, so run it
  // through the same validity check as every other port here rather than
  // handing 70000 (or 1.5, or -1) to net.connect and surfacing its raw throw.
  const explicit = isUsablePort(vpn.socksPort) ? vpn.socksPort : undefined;
  const port =
    explicit !== undefined ? explicit : derivePort(key, parsePortRange(portRangeSetting));

  if (!(await isPortFree(port))) {
    const outcome = await classifyOwnedPort(key, port);
    if (outcome.kind === 'adopt') {
      logger.info(
        `VPN tunnel adopted (SOCKS5 127.0.0.1:${port}, pid ${outcome.marker.pid}) for ${vpn.configFile}`
      );
      return {
        key,
        port,
        pid: outcome.marker.pid,
        mergedConfPath: mergedConfPathFor(key),
        refCount: 1,
      };
    }
    if (outcome.kind === 'hung') {
      // Ours, but wedged: it holds the port yet answers nothing, so it can
      // never again be adopted (a live marker pointed at a pid that fails the
      // probe never yields 'adopt') and, once we step aside to a free port,
      // nothing will ever re-read this marker to kill it either. Left alone
      // it would sit on the port for the rest of the machine's uptime, and
      // every reload after this one would leak one more. Killing it here --
      // before starting its replacement -- is what stops that.
      logger.warn(
        `VPN tunnel on 127.0.0.1:${port} (pid ${outcome.marker.pid}) stopped answering ` +
          `SOCKS5 for ${vpn.configFile}; replacing it`
      );
      try {
        deps.killPid(outcome.marker.pid);
      } catch (_e) {
        /* already gone */
      }
      // Unconditionally, explicit port or not: process.kill() returning says
      // only that the signal was delivered, not that the socket is closed, so
      // without this wait the replacement races the corpse for the port and
      // loses. (Skipping the wait for an explicit port used to be justified
      // as avoiding a "relocation" -- waiting relocates nothing.)
      if (!(await waitForPortFree(port))) {
        // The signal did not free the port: ignored, still shutting down, or
        // never deliverable at all (EPERM -- not our process after all). The
        // marker deliberately stays. It is the only handle any future run has
        // on this process, and dropping it while the process still holds the
        // port would strand that port anonymously for the rest of the
        // machine's uptime -- precisely the leak this branch exists to stop.
        if (explicit !== undefined) {
          throw new Error(
            `VPN SOCKS port ${port} is still held after signalling pid ` +
              `${outcome.marker.pid}, and "vpn.socksPort" pins the tunnel to it. ` +
              `Free the port, or change "vpn.socksPort" in your sftp.json.`
          );
        }
        // A derived port is a convenience, not a requirement, so step aside.
        return startTunnel(vpn, key, await getFreePort());
      }
      // The port is free again, so the process the marker described is gone
      // and its claim goes with it.
      removeMarker(key);
    } else if (explicit === undefined) {
      // Someone else's port. Step aside rather than fight for it -- the
      // deterministic port is a convenience, not a requirement.
      return startTunnel(vpn, key, await getFreePort());
    } else {
      // An explicit port, held by something we cannot prove is ours and
      // cannot claim as a hung tunnel to reap. Both alternatives are wrong:
      // moving off the port would silently break whatever the user pinned it
      // for, and going ahead would be worse still. wireproxy does not, as an
      // earlier comment here claimed, reliably fail loudly -- the health
      // check is a bare TCP connect, so the squatter answers it, and we would
      // report a tunnel that is up, write an ownership marker for a port we
      // never bound, and hand the SSH session to a stranger. Fail instead.
      throw new Error(
        `VPN SOCKS port ${port} is already in use by something this extension did not ` +
          `start, and "vpn.socksPort" pins the tunnel to it. Stop whatever is holding ` +
          `127.0.0.1:${port}, or change "vpn.socksPort" in your sftp.json.`
      );
    }
  }
  return startTunnel(vpn, key, port);
}

function killTunnel(tunnel: Tunnel) {
  if (tunnel.process) {
    try {
      tunnel.process.kill();
    } catch (_e) {
      /* ignore */
    }
  } else {
    // An adopted tunnel: no child handle, only a recorded pid. Re-read the
    // marker and require it to still name this exact pid and port before
    // signalling, so a pid recycled since we adopted is not our problem to
    // kill. That is pidfile-grade certainty -- the recycle could in principle
    // happen inside this window too -- but it is the strongest check
    // available without a handle, and the alternative (never killing) leaks
    // the process for the rest of the machine's uptime.
    const marker = readMarker(tunnel.key);
    const stillOurs =
      marker !== undefined && marker.pid === tunnel.pid && marker.port === tunnel.port;
    if (stillOurs && deps.isPidAlive(tunnel.pid)) {
      try {
        deps.killPid(tunnel.pid);
      } catch (_e) {
        /* already gone */
      }
    }
  }
  try {
    fs.unlinkSync(tunnel.mergedConfPath);
  } catch (_e) {
    /* ignore */
  }
  // The claim dies with the process it described; leaving it would invite the
  // next run to adopt whatever lands on the port next.
  removeMarker(tunnel.key);
}

/**
 * Ensure a tunnel is up for this VPN config and return the live SOCKS5 port.
 * Increments the refcount; pair every successful acquire() with one release().
 */
export async function acquire(vpn: VpnOption): Promise<number> {
  const key = tunnelKey(vpn);
  // A loop, not a single `if`, because awaiting the tracked entry suspends us:
  // a second acquire() for the same key can run to completion in that gap and
  // leave a replacement behind. Falling straight through would then have both
  // callers start a wireproxy, the later tunnels.set() overwriting the earlier
  // -- orphaning a process no map entry names, no exit handler can reach and
  // whose marker its twin has already overwritten. Re-reading the map after
  // every await is what makes the loser take the winner's tunnel instead.
  for (;;) {
    const existing = tunnels.get(key);
    if (!existing) {
      break;
    }
    const tunnel = await existing;
    // A tracked entry is not proof of a running tunnel. With keepAlive on it
    // survives every release() for the life of the window, and an adopted one
    // has no child handle whose 'exit' could clear it. Returning its port
    // unchecked would point the SSH session at a closed port, or at whatever
    // has bound it since -- so ask before reusing, and fall through to a
    // fresh start when the answer is no.
    if (deps.isPidAlive(tunnel.pid)) {
      tunnel.refCount += 1;
      return tunnel.port;
    }
    if (tunnels.get(key) !== tunnel) {
      // Someone replaced this dead entry while we were suspended. Go round
      // again and take theirs rather than starting a second one. Terminates:
      // an entry is only ever replaced by another acquire() call, of which
      // there are finitely many, and each pass reads a strictly newer one.
      continue;
    }
    tunnels.delete(key);
    break;
  }

  // Nothing may await between the delete above and the set below, or the gap
  // reopens the race this loop exists to close.
  const startPromise = openTunnel(vpn, key);
  tunnels.set(key, startPromise);
  try {
    const tunnel = await startPromise;
    tunnels.set(key, tunnel);
    return tunnel.port;
  } catch (error) {
    tunnels.delete(key);
    throw error;
  }
}

/**
 * The SOCKS port of this VPN's running tunnel, or undefined when none is up.
 * A tunnel still starting counts as not running: it has no port to report yet.
 */
export function portFor(vpn: VpnOption): number | undefined {
  const entry = tunnels.get(tunnelKey(vpn));
  if (!entry || typeof (entry as Tunnel).port !== 'number') {
    return undefined;
  }
  return (entry as Tunnel).port;
}

/**
 * Drop one reference to the VPN config's tunnel; kill wireproxy when the last
 * user disconnects -- unless "sftp.vpn.keepAlive" says to leave it running.
 * In that case the tunnel entry (and its process) stay exactly as they are,
 * refCount included, so the next acquire() finds it via the `existing` branch
 * and bumps it straight back up rather than starting or adopting anything.
 */
export function release(vpn: VpnOption): void {
  const key = tunnelKey(vpn);
  const entry = tunnels.get(key);
  if (!entry) {
    return;
  }
  Promise.resolve(entry)
    .then(tunnel => {
      tunnel.refCount -= 1;
      if (tunnel.refCount <= 0 && !keepAliveSetting) {
        tunnels.delete(key);
        killTunnel(tunnel);
        logger.info(`VPN tunnel closed for ${vpn.configFile}`);
      }
    })
    .catch(() => {
      // start failed; acquire() already cleaned up the map entry.
    });
}

/**
 * Kill every tracked tunnel (extension deactivation).
 *
 * With "sftp.vpn.keepAlive" on -- the default -- this is the only teardown in
 * the normal path, so it kills synchronously. deactivate() returns to a host
 * that may exit immediately afterwards, and work deferred to a microtask
 * after that return can simply never run. Only a tunnel still mid-start has
 * to be waited on, and that one has no pid to signal yet anyway.
 */
export function disposeAll(): void {
  tunnels.forEach(entry => {
    const pending = entry as Promise<Tunnel>;
    if (typeof pending.then === 'function') {
      pending.then(killTunnel).catch(() => {
        /* ignore */
      });
      return;
    }
    try {
      killTunnel(entry as Tunnel);
    } catch (_e) {
      /* best effort: one tunnel failing must not skip the rest */
    }
  });
  tunnels.clear();
}
