import {
  parseProxyAddress,
  decideVpnRoute,
  isLegacyVpnObject,
  usesVpn,
  socksProxyCommand,
  DEFAULT_PROXY_ADDRESS,
} from '../vpnRoute';

const PROXY = { host: '127.0.0.1', port: 1080 };

describe('parseProxyAddress', () => {
  test('reads an IPv4 host and port', () => {
    expect(parseProxyAddress('127.0.0.1:1080')).toEqual({ host: '127.0.0.1', port: 1080 });
  });

  test('reads a hostname and port', () => {
    expect(parseProxyAddress('vpn-box.local:9050')).toEqual({ host: 'vpn-box.local', port: 9050 });
  });

  test('ignores surrounding whitespace, which a hand-edited setting picks up', () => {
    expect(parseProxyAddress('  localhost:1080 ')).toEqual({ host: 'localhost', port: 1080 });
  });

  test('accepts both ends of the port range', () => {
    expect(parseProxyAddress('h:1')).toEqual({ host: 'h', port: 1 });
    expect(parseProxyAddress('h:65535')).toEqual({ host: 'h', port: 65535 });
  });

  test.each([
    ['a missing port', '127.0.0.1'],
    ['an empty port', '127.0.0.1:'],
    ['port 0', '127.0.0.1:0'],
    ['a port above 65535', '127.0.0.1:65536'],
    ['a non-numeric port', '127.0.0.1:socks'],
    ['a fractional port', '127.0.0.1:10.5'],
    ['a negative port', '127.0.0.1:-1'],
    ['an empty host', ':1080'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a scheme prefix', 'socks5://127.0.0.1:1080'],
    ['a bare IPv6 address', '::1:1080'],
    // The host lands inside the SSH terminal's ProxyCommand, so anything that
    // could break out of that string is refused rather than quoted.
    ['shell metacharacters', '127.0.0.1;rm -rf ~:1080'],
    ['a quote', '127.0.0.1":1080'],
    ['a host that reads as an option', '-oProxyCommand=x:1080'],
  ])('rejects %s', (_label, value) => {
    expect(parseProxyAddress(value)).toBeUndefined();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 1080],
    ['an object', { host: '127.0.0.1', port: 1080 }],
  ])('rejects %s rather than throwing', (_label, value) => {
    expect(parseProxyAddress(value)).toBeUndefined();
  });

  test('the default proxy address is what the default setting parses to', () => {
    expect(parseProxyAddress('127.0.0.1:1080')).toEqual(DEFAULT_PROXY_ADDRESS);
  });
});

describe('decideVpnRoute', () => {
  test('true routes through the shared proxy', () => {
    expect(decideVpnRoute(true, PROXY)).toEqual({ kind: 'shared', proxy: PROXY });
  });

  test('false connects directly', () => {
    expect(decideVpnRoute(false, PROXY)).toEqual({ kind: 'direct' });
  });

  test('an absent vpn connects directly', () => {
    expect(decideVpnRoute(undefined, PROXY)).toEqual({ kind: 'direct' });
  });

  test('null connects directly', () => {
    expect(decideVpnRoute(null, PROXY)).toEqual({ kind: 'direct' });
  });

  // Every falsy value connected directly before "vpn": true existed (the
  // callers tested `if (vpn)`), so none of them may start failing now.
  test.each([[0], ['']])('the falsy value %p still connects directly', value => {
    expect(decideVpnRoute(value, PROXY)).toEqual({ kind: 'direct' });
  });

  // The object form is how every profile was written before 1.34.0. Its
  // fields no longer mean anything, but the user asked for the VPN, so it
  // takes the same route as true.
  test('the legacy object form routes through the shared proxy', () => {
    const vpn = { type: 'wireguard', configFile: '~/wg0.conf', socksPort: 21080 };
    expect(decideVpnRoute(vpn, PROXY)).toEqual({ kind: 'shared', proxy: PROXY });
  });

  test('a legacy object with none of its old fields still routes through the proxy', () => {
    expect(decideVpnRoute({}, PROXY)).toEqual({ kind: 'shared', proxy: PROXY });
  });

  // A misconfigured vpn must never quietly connect directly: the user asked
  // for the tunnel, and a direct connection would leave from the wrong IP.
  test.each([
    ['a string', 'true'],
    ['a number', 1],
    ['an array', [{ configFile: '~/wg0.conf' }]],
  ])('refuses %s with a plain message', (_label, value) => {
    expect(() => decideVpnRoute(value, PROXY)).toThrow(/"vpn" in sftp\.json must be true or false/);
  });
});

describe('isLegacyVpnObject', () => {
  test('is true for the old object form', () => {
    expect(isLegacyVpnObject({ configFile: '/etc/wireguard/wg0.conf' })).toBe(true);
  });

  test.each([[true], [false], [undefined], [null], ['{}'], [[]]])('is false for %p', value => {
    expect(isLegacyVpnObject(value)).toBe(false);
  });
});

describe('usesVpn', () => {
  test('is true for true', () => {
    expect(usesVpn(true)).toBe(true);
  });

  test('is true for the legacy object form', () => {
    expect(usesVpn({ configFile: '/etc/wireguard/wg0.conf' })).toBe(true);
  });

  test.each([[false], [undefined], [null], ['true'], [1], [[]]])('is false for %p', value => {
    expect(usesVpn(value)).toBe(false);
  });
});

describe('socksProxyCommand', () => {
  test('points nc at the proxy and leaves the destination to ssh', () => {
    expect(socksProxyCommand({ host: '10.0.0.2', port: 1080 })).toBe('nc -X 5 -x 10.0.0.2:1080 %h %p');
  });
});
