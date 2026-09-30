/**
 * Where a profile's SSH connection goes, decided from its `vpn` value alone.
 * Pure (no I/O, no vscode, no logger) so every caller -- sshClient, the SSH
 * terminal command, the server manager's profile view -- agrees on the answer
 * and it can be unit-tested directly.
 *
 * Since 1.34.0 the extension no longer starts a tunnel of its own. "The VPN"
 * is a SOCKS5 proxy the user keeps running themselves (see "sftp.vpn.proxy"),
 * so there are only two routes: straight to the host, or through that proxy.
 */

export interface ProxyAddress {
  host: string;
  port: number;
}

// Matches the "sftp.vpn.proxy" default in package.json.
export const DEFAULT_PROXY_ADDRESS: ProxyAddress = { host: '127.0.0.1', port: 1080 };

export type VpnRoute = { kind: 'direct' } | { kind: 'shared'; proxy: ProxyAddress };

/**
 * Parse "host:port". Returns undefined for anything else rather than throwing:
 * the value comes from a hand-edited settings file, and the caller falls back
 * to the default.
 *
 * The host is limited to the characters of a hostname or an IPv4 address, and
 * must not start with a dash. That is stricter than it needs to be for the
 * SOCKS client, on purpose: the same value is written into the "Open SSH in
 * Terminal" ProxyCommand, which is shell text, so anything that could break
 * out of it (a quote, a semicolon, a space, a leading "-" read as an option by
 * nc) is refused here rather than escaped there.
 */
export function parseProxyAddress(value: unknown): ProxyAddress | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const port = Number(match[2]);
  if (port < 1 || port > 65535) {
    return undefined;
  }
  return { host: match[1], port };
}

/**
 * The pre-1.34.0 spelling, `"vpn": { "configFile": ..., ... }`. Its fields
 * described a tunnel for the extension to start, which it no longer does, so
 * all that is left of it is "this profile uses the VPN". Any plain object
 * counts, with or without configFile: the user asked for the VPN either way.
 */
export function isLegacyVpnObject(vpn: unknown): boolean {
  return typeof vpn === 'object' && vpn !== null && !Array.isArray(vpn);
}

/** Whether this profile's connection goes through the VPN proxy. */
export function usesVpn(vpn: unknown): boolean {
  return vpn === true || isLegacyVpnObject(vpn);
}

/**
 * Every falsy value is direct, exactly as the old `if (vpn)` checks treated
 * it. A truthy value that is neither true nor an object (a string "true", a
 * number, an array) is refused rather than guessed at: connecting directly
 * would send the user out from the IP the VPN exists to avoid.
 */
export function decideVpnRoute(vpn: unknown, proxy: ProxyAddress): VpnRoute {
  if (!vpn) {
    return { kind: 'direct' };
  }
  if (usesVpn(vpn)) {
    return { kind: 'shared', proxy };
  }
  throw new Error('"vpn" in sftp.json must be true or false.');
}

/** The ProxyCommand that sends a terminal `ssh` through the SOCKS5 proxy. */
export function socksProxyCommand(proxy: ProxyAddress): string {
  return `nc -X 5 -x ${proxy.host}:${proxy.port} %h %p`;
}
