import * as net from 'net';
import * as path from 'path';
import * as fse from 'fs-extra';
import logger from '../logger';
import {
  ProxyAddress,
  VpnRoute,
  DEFAULT_PROXY_ADDRESS,
  parseProxyAddress,
  decideVpnRoute,
  isLegacyVpnObject,
} from './vpnRoute';

/**
 * The always-on VPN proxy a profile with `"vpn": true` connects through.
 *
 * The user runs this SOCKS5 proxy themselves (typically wireproxy under
 * launchd). The extension never starts, stops or signals it: it only reads
 * where it is from "sftp.vpn.proxy", checks that it answers, and hands the
 * address to whoever is opening the SSH connection.
 */

// The parsed "sftp.vpn.proxy" setting. Defaulted, not undefined, so a caller
// that runs before init() still gets the documented address.
let proxyAddress: ProxyAddress = DEFAULT_PROXY_ADDRESS;

/**
 * Take the "sftp.vpn.proxy" setting, read once in extension.ts like the rest
 * of the "sftp.*" settings (change it, then reload the window). A malformed
 * value must never throw -- that would break every SFTP connection, VPN or
 * not -- so it falls back to the default and says so in the log.
 */
export function init(options: { proxy?: string } = {}): void {
  const parsed = parseProxyAddress(options.proxy);
  if (!parsed && options.proxy !== undefined) {
    logger.warn(
      `"sftp.vpn.proxy" must be host:port, got ${JSON.stringify(options.proxy)}; ` +
        `using ${DEFAULT_PROXY_ADDRESS.host}:${DEFAULT_PROXY_ADDRESS.port}.`
    );
  }
  proxyAddress = parsed || DEFAULT_PROXY_ADDRESS;
}

/**
 * The route for one connection attempt. Callers call this once per attempt,
 * which is what keeps the deprecation note below to one line per connection.
 */
export function routeFor(vpn: unknown): VpnRoute {
  const route = decideVpnRoute(vpn, proxyAddress);
  if (isLegacyVpnObject(vpn)) {
    logger.info(
      `"vpn": { ... } in sftp.json is deprecated and its fields are ignored; ` +
        `"vpn": true is the new spelling. Connecting through the VPN proxy at ` +
        `${proxyAddress.host}:${proxyAddress.port}.`
    );
  }
  return route;
}

// Long enough for a proxy on another machine on the LAN, and still quick to
// give up on. A proxy that is simply not running refuses the connection
// straight away and never waits this long.
const SHARED_PROXY_PROBE_TIMEOUT_MS = 2000;

/**
 * Fail fast, with a message that says what to do, when the proxy is not
 * there. Without this the user gets whatever the SOCKS client or `nc` makes
 * of a refused connection, which never mentions the VPN.
 */
export async function ensureSharedProxy(proxy: ProxyAddress): Promise<void> {
  if (!(await probeSocks5(proxy.port, SHARED_PROXY_PROBE_TIMEOUT_MS, proxy.host))) {
    throw new Error(
      `VPN proxy is not answering on ${proxy.host}:${proxy.port}. "vpn": true uses your ` +
        `always-on VPN tunnel — start it, or change "sftp.vpn.proxy" in settings.`
    );
  }
}

const SOCKS5_GREETING = Buffer.from([0x05, 0x01, 0x00]);
const DEFAULT_PROBE_TIMEOUT_MS = 300;
const MAX_PORT = 65535;

// A port we could actually connect to: whole, positive, in range.
function isUsablePort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= MAX_PORT;
}

/**
 * Ask whether something on `host:port` actually speaks SOCKS5, by sending the
 * handshake greeting and checking that the reply is exactly "version 5,
 * no-auth selected".
 *
 * Why 0x05 0x00 and not just "first byte is 5": a server that answers
 * 0x05 0xFF is a real SOCKS5 server refusing every auth method we offered.
 * Both of our SOCKS clients (the `socks` package in sshClient.ts and `nc -X 5`
 * in the SSH terminal) offer no-auth only, so such a proxy could not carry the
 * connection anyway, and saying so here is more useful than letting the
 * connection fail later. Do not loosen this back to a version check.
 *
 * This runs on the connection path, so it must never reject and must never
 * leave a socket (or a pending timer) behind -- either would hang or break
 * the connection. Every exit -- good reply, wrong version, error, close, or
 * timeout -- funnels through `finish()`, which is itself guarded to run at
 * most once since more than one of those can fire for the same socket (e.g.
 * 'error' followed by 'close').
 */
export function probeSocks5(
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  host = '127.0.0.1'
): Promise<boolean> {
  // net.connect() validates the port synchronously and *throws* for a
  // negative, fractional, out-of-range or NaN one -- no 'error' event, so the
  // throw would escape this executor as a rejected promise. Answer false.
  if (!isUsablePort(port)) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    let settled = false;
    let received = 0;
    const chunks: Buffer[] = [];

    const socket = net.connect(port, host);

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
 * Before 1.34.0 the extension started its own wireproxy and kept, per tunnel,
 * a merged WireGuard config (private key included) and an ownership marker in
 * a `vpn` directory under its global storage. Nothing reads them any more, and
 * the private keys should not outlive the feature, so activation deletes the
 * directory.
 *
 * Files only. Whatever wireproxy those markers named is deliberately left
 * running: its pid may since have been reused by an unrelated process, and
 * the user's own always-on proxy may well be a wireproxy too.
 *
 * Best effort: a failure is logged at debug and never reaches the caller.
 * The storage path must be absolute, so a missing or relative one can never
 * turn this into a recursive delete of "vpn" wherever the process happens to
 * be running.
 */
export function removeLegacyTunnelFiles(storageDir: string | undefined): Promise<void> {
  if (typeof storageDir !== 'string' || !path.isAbsolute(storageDir)) {
    return Promise.resolve();
  }
  return fse.remove(path.join(storageDir, 'vpn')).catch(error => {
    logger.debug(`VPN: could not remove old tunnel files: ${(error as Error).message}`);
  });
}
