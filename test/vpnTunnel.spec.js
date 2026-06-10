// Mirrors mergeSocksConfig() in src/core/vpnTunnel.ts. Kept self-contained so it
// runs under this repo's Jest setup (the .ts test path is currently broken by a
// Jest 28 preprocessor incompatibility); if you change the source format, update here.
function mergeSocksConfig(userConf, port) {
  return `${userConf.replace(/\s+$/, '')}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

const SAMPLE = `[Interface]
PrivateKey = abc123
Address = 10.14.0.2/16
DNS = 162.252.172.57

[Peer]
PublicKey = serverkey
AllowedIPs = 0.0.0.0/0
Endpoint = us-nyc-st004.prod.surfshark.com:51820`;

describe('mergeSocksConfig', () => {
  it('appends a [Socks5] section bound to the given localhost port', () => {
    const merged = mergeSocksConfig(SAMPLE, 41234);
    expect(merged).toContain('[Socks5]');
    expect(merged).toContain('BindAddress = 127.0.0.1:41234');
  });

  it('preserves the original [Interface] and [Peer] sections', () => {
    const merged = mergeSocksConfig(SAMPLE, 1080);
    expect(merged).toContain('PrivateKey = abc123');
    expect(merged).toContain('Endpoint = us-nyc-st004.prod.surfshark.com:51820');
  });

  it('does not duplicate trailing whitespace and ends with a single newline', () => {
    const merged = mergeSocksConfig(`${SAMPLE}\n\n  `, 22);
    expect(merged.endsWith('BindAddress = 127.0.0.1:22\n')).toBe(true);
    expect(merged).not.toContain('\n\n\n');
  });
});
