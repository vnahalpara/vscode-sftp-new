import { profileId, redactProfile } from '../registry';

// Every secret this repo is known to put in sftp.json, with distinctive values
// so a leak is unambiguous in an assertion failure.
const SECRETS = [
  'hunter2',
  'sshpass -p hunter2',
  'my-passphrase',
  'interactive-secret',
  'glpat-abcdef',
  'db-root-password',
  'root-hunter3',
];

const CONFIG = {
  name: 'prod',
  host: '10.0.0.5',
  port: 2222,
  username: 'deploy',
  password: 'hunter2',
  passphrase: 'my-passphrase',
  ssh_prefix: 'sshpass -p hunter2',
  interactiveAuth: ['interactive-secret'],
  protocol: 'sftp',
  remotePath: '/var/www',
  vpn: { configFile: '/etc/wireguard/wg0.conf' },
  git: { username: 'bot', password: 'glpat-abcdef' },
  database: [{ name: 'shop', user: 'root', password: 'db-root-password' }],
  // root_user is deliberately absent from this shared fixture: privilegedAs
  // requires BOTH root fields (see index.ts's hasRootCreds), so carrying
  // root_password alone here still exercises the general leak assertions
  // below without changing what every other test in this file expects
  // privilegedAs/username to be.
  root_password: 'root-hunter3',
};

describe('profileId', () => {
  it('is stable for the same workspace and connection', () => {
    expect(profileId('/ws', CONFIG)).toBe(profileId('/ws', CONFIG));
  });

  it('is 16 lowercase hex characters', () => {
    expect(profileId('/ws', CONFIG)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates same-named profiles in different workspace folders', () => {
    expect(profileId('/ws-a', CONFIG)).not.toBe(profileId('/ws-b', CONFIG));
  });

  it('separates profiles that differ only by host or port', () => {
    const other = { ...CONFIG, host: '10.0.0.6' };
    const otherPort = { ...CONFIG, port: 22 };
    expect(profileId('/ws', other)).not.toBe(profileId('/ws', CONFIG));
    expect(profileId('/ws', otherPort)).not.toBe(profileId('/ws', CONFIG));
  });

  it('does not collide when name and host are swapped around the separator', () => {
    // Naive concatenation would make {name:'a', host:'b'} and {name:'ab', host:''}
    // hash identically. The NUL separator is what prevents that.
    const a = profileId('/ws', { name: 'a', host: 'b', port: 22 });
    const b = profileId('/ws', { name: 'ab', host: '', port: 22 });
    expect(a).not.toBe(b);
  });

  it('does not collide when a name contains the separator character', () => {
    const a = profileId('/ws', { name: 'a b', host: '', port: 22 });
    const b = profileId('/ws', { name: 'a', host: 'b', port: 22 });
    expect(a).not.toBe(b);
  });
});

describe('redactProfile', () => {
  it('exposes exactly the fields the UI needs', () => {
    expect(redactProfile('/ws', CONFIG)).toEqual({
      id: profileId('/ws', CONFIG),
      name: 'prod',
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      privilegedAs: 'deploy',
      protocol: 'sftp',
      remotePath: '/var/www',
      workspace: '/ws',
      hasVpn: true,
      hasDatabase: true,
      hasCloudflare: false,
      cloudflareZoneId: '',
    });
  });

  it('leaks no secret when serialised', () => {
    const json = JSON.stringify(redactProfile('/ws', CONFIG));
    SECRETS.forEach(secret => expect(json).not.toContain(secret));
  });

  it('reports privilegedAs as root_user when both root credentials are present, and never leaks root_password', () => {
    const withRoot = { ...CONFIG, root_user: 'root', root_password: 'root-hunter3' };
    const redacted = redactProfile('/ws', withRoot);

    expect(redacted.privilegedAs).toBe('root');

    const json = JSON.stringify(redacted);
    expect(json).not.toContain('root-hunter3');
    expect(json).not.toContain('root_password');
  });

  it('falls back to username for privilegedAs when only one root field is present', () => {
    // CONFIG already carries root_password (for the leak assertions above);
    // clearing it here is what keeps this "only root_user" case honest.
    const halfRoot = { ...CONFIG, root_user: 'root', root_password: undefined };
    expect(redactProfile('/ws', halfRoot).privilegedAs).toBe('deploy');
  });

  it('reads privilegedAs off the hop, not the top level, on a hop/bastion profile', () => {
    // Top level = bastion; hop = the actual managed target. This must match
    // exactly what index.ts's privilegedConfig resolves to, or
    // the UI (and the sudo hint) would name the bastion's user while the
    // privileged lane is really authenticated as root on the target.
    const hopConfig = {
      ...CONFIG,
      username: 'bastionUser',
      root_password: undefined,
      hop: { host: 'target', username: 'targetUser', password: 'p', root_user: 'root', root_password: 'target-root-secret' },
    };
    const redacted = redactProfile('/ws', hopConfig);

    expect(redacted.privilegedAs).toBe('root');
    expect(redacted.username).toBe('bastionUser');

    const json = JSON.stringify(redacted);
    expect(json).not.toContain('target-root-secret');
  });

  it('ignores top-level root credentials on a hop profile, and falls back to the HOP\'s own username, not the bastion\'s', () => {
    // Without root credentials the privileged lane authenticates as
    // whatever privilegedConfig leaves target() as -- the hop's own
    // username, since privilegedConfig returns the hop unchanged in this
    // case. It never falls back to the bastion's (top-level) username: that
    // account exists on a different machine and never runs the command.
    const hopConfig = {
      ...CONFIG,
      username: 'bastionUser',
      root_user: 'root',
      hop: { host: 'target', username: 'targetUser', password: 'p' },
    };
    expect(redactProfile('/ws', hopConfig).privilegedAs).toBe('targetUser');
  });

  it('falls back to config.username only when the hop itself has no username (degenerate profile)', () => {
    const hopConfig = {
      ...CONFIG,
      username: 'bastionUser',
      hop: { host: 'target', password: 'p' },
    };
    expect(redactProfile('/ws', hopConfig).privilegedAs).toBe('bastionUser');
  });

  it('survives a config that grows a new secret field', () => {
    // The allowlist, not a denylist, is what makes this pass.
    const grown = { ...CONFIG, futureToken: 'a-brand-new-secret' };
    const json = JSON.stringify(redactProfile('/ws', grown));
    expect(json).not.toContain('a-brand-new-secret');
  });

  it('falls back to the host when the profile has no name', () => {
    const nameless = { ...CONFIG, name: undefined };
    expect(redactProfile('/ws', nameless).name).toBe('10.0.0.5');
  });

  it('defaults port to 22 and reports no vpn or database when absent', () => {
    const bare = { host: 'example.com', username: 'root', protocol: 'sftp' };
    const out = redactProfile('/ws', bare);
    expect(out.port).toBe(22);
    expect(out.hasVpn).toBe(false);
    expect(out.hasDatabase).toBe(false);
    expect(out.hasCloudflare).toBe(false);
  });

  it('exposes hasCloudflare but never the token', () => {
    const TOKEN = 'cf-secret-token-value';
    const redacted = redactProfile('/ws', {
      ...CONFIG,
      CLOUDFLARE_ZONE_ID: 'zone123',
      CLOUDFLARE_API_TOKEN: TOKEN,
    } as any);

    expect(redacted.hasCloudflare).toBe(true);
    // The zone id IS exposed -- it is an identifier, not a credential, and the
    // purge confirmation needs it to name the zone when the zone-name lookup
    // failed. The token is not.
    expect(redacted.cloudflareZoneId).toBe('zone123');

    const json = JSON.stringify(redacted);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('CLOUDFLARE_API_TOKEN');
  });

  it('hasCloudflare is false when only one field is set', () => {
    expect(redactProfile('/ws', { ...CONFIG, CLOUDFLARE_ZONE_ID: 'z' } as any).hasCloudflare).toBe(false);
    expect(redactProfile('/ws', { ...CONFIG, CLOUDFLARE_API_TOKEN: 't' } as any).hasCloudflare).toBe(false);
  });

  it('reports no zone id when Cloudflare is not fully configured', () => {
    expect(redactProfile('/ws', CONFIG).cloudflareZoneId).toBe('');
    // A zone id with no token is a half-finished edit, and every other
    // Cloudflare gate treats it as not configured -- so does this one.
    expect(redactProfile('/ws', { ...CONFIG, CLOUDFLARE_ZONE_ID: 'z' } as any).cloudflareZoneId).toBe('');
  });
});
