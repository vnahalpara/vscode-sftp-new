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
    const halfRoot = { ...CONFIG, root_user: 'root' };
    expect(redactProfile('/ws', halfRoot).privilegedAs).toBe('deploy');
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
  });
});
