import { validateConfig } from '../config';

/**
 * A profile with everything validateConfig() insists on, so a test below can
 * vary the one field it is about and know that any error it sees came from
 * that field.
 */
function profile(vpn?: any): any {
  const config: any = {
    host: '1.2.3.4',
    username: 'someone',
    remotePath: '/var/www',
  };
  if (vpn !== undefined) {
    config.vpn = vpn;
  }
  return config;
}

describe('validateConfig: vpn.socksPort', () => {
  // 0 is the documented default in both README.md and schema/definitions.json,
  // and vpnTunnel treats it as "no explicit port, derive one" rather than as a
  // port at all. It reached the schema through VS Code's own completion inside
  // sftp.json, so rejecting it would be rejecting what the editor offers.
  //
  // The blast radius is what makes this worth its own test: validateConfig()
  // runs for the whole profile on the way to getConfig(), so a schema that
  // refuses 0 fails plain SFTP upload, download, sync and the database
  // features for a user who never enabled the VPN feature at all.
  test('accepts 0, the documented default', () => {
    expect(validateConfig(profile({ configFile: '~/wg0.conf', socksPort: 0 }))).toBeNull();
  });

  test('accepts a real port', () => {
    expect(validateConfig(profile({ configFile: '~/wg0.conf', socksPort: 21080 }))).toBeNull();
  });

  test('rejects a negative port', () => {
    expect(validateConfig(profile({ configFile: '~/wg0.conf', socksPort: -1 }))).not.toBeNull();
  });

  test('rejects a port above 65535', () => {
    expect(validateConfig(profile({ configFile: '~/wg0.conf', socksPort: 70000 }))).not.toBeNull();
  });

  test('a profile with no vpn block at all still validates', () => {
    expect(validateConfig(profile())).toBeNull();
  });
});

// The same class of defect the socksPort tests above pin, found by sweeping the
// rest of the schema for values we document and then reject. Both of these
// predate the VPN work; a rejection fails the WHOLE profile, so plain SFTP and
// the database features die for a user who did nothing wrong.
describe('validateConfig: documented empty passwords', () => {
  test('accepts an empty connection password, which the schema gives as its default', () => {
    expect(
      validateConfig({ host: 'h', username: 'u', password: '', protocol: 'sftp', remotePath: '/srv' } as any)
    ).toBeNull();
  });

  test('still accepts an absent connection password', () => {
    expect(validateConfig({ host: 'h', username: 'u', protocol: 'sftp', remotePath: '/srv' } as any)).toBeNull();
  });

  test('accepts an empty database password, for a local database with none set', () => {
    expect(
      validateConfig({
        host: 'h',
        username: 'u',
        protocol: 'sftp',
        remotePath: '/srv',
        database: [{ host: 'db', username: 'root', password: '', name: 'app' }],
      } as any)
    ).toBeNull();
  });
});
