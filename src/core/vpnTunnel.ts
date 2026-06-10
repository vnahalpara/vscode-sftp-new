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
  port: number;
  process: ChildProcess;
  mergedConfPath: string;
  refCount: number;
}

const DEFAULT_HEALTHCHECK_MS = 15000;

// Resolved writable directory for merged configs; set from activate().
let storageDir = os.tmpdir();

// key (resolved config path) -> live tunnel or its pending start promise
const tunnels = new Map<string, Tunnel | Promise<Tunnel>>();

export function init(dir: string) {
  storageDir = dir;
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

/**
 * Append the `[Socks5]` section wireproxy needs onto a user's WireGuard conf,
 * binding the proxy to the given localhost port. Pure (no I/O) so it is unit-testable.
 */
export function mergeSocksConfig(userConf: string, port: number): string {
  return `${userConf.replace(/\s+$/, '')}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

function getFreePort(preferred?: number): Promise<number> {
  if (preferred && preferred > 0) {
    return Promise.resolve(preferred);
  }
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

async function startTunnel(vpn: VpnOption, key: string): Promise<Tunnel> {
  const confPath = expandHome(vpn.configFile);
  let userConf: string;
  try {
    userConf = fs.readFileSync(confPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read VPN config file "${vpn.configFile}": ${(error as Error).message}`);
  }

  const port = await getFreePort(vpn.socksPort);
  const mergedConf = mergeSocksConfig(userConf, port);

  const vpnDir = path.join(storageDir, 'vpn');
  fse.ensureDirSync(vpnDir);
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const mergedConfPath = path.join(vpnDir, `${hash}.conf`);
  // 0600: the file embeds the WireGuard private key.
  fs.writeFileSync(mergedConfPath, mergedConf, { mode: 0o600 });

  const bin = vpn.wireproxyPath || 'wireproxy';
  const child = spawn(bin, ['-c', mergedConfPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  let exited = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on('error', err => {
    spawnError = err as NodeJS.ErrnoException;
    exited = true;
  });
  child.on('exit', () => {
    exited = true;
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

  logger.info(`VPN tunnel up (SOCKS5 127.0.0.1:${port}) for ${vpn.configFile}`);
  return { port, process: child, mergedConfPath, refCount: 1 };
}

function killTunnel(tunnel: Tunnel) {
  try {
    tunnel.process.kill();
  } catch (_e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(tunnel.mergedConfPath);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * Ensure a tunnel is up for this VPN config and return the live SOCKS5 port.
 * Increments the refcount; pair every successful acquire() with one release().
 */
export async function acquire(vpn: VpnOption): Promise<number> {
  const key = tunnelKey(vpn);
  const existing = tunnels.get(key);
  if (existing) {
    const tunnel = await existing;
    tunnel.refCount += 1;
    return tunnel.port;
  }

  const startPromise = startTunnel(vpn, key);
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
 * Drop one reference to the VPN config's tunnel; kill wireproxy when the last
 * user disconnects.
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
      if (tunnel.refCount <= 0) {
        tunnels.delete(key);
        killTunnel(tunnel);
        logger.info(`VPN tunnel closed for ${vpn.configFile}`);
      }
    })
    .catch(() => {
      // start failed; acquire() already cleaned up the map entry.
    });
}

/** Kill every tracked tunnel (extension deactivation). */
export function disposeAll(): void {
  tunnels.forEach(entry => {
    Promise.resolve(entry)
      .then(killTunnel)
      .catch(() => {
        /* ignore */
      });
  });
  tunnels.clear();
}
