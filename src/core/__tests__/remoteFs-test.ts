import { hashOption } from '../remoteFs';

// hashOption is the pool key for the SFTP/FTP connection cache (fsTable in
// remoteFs.ts): createRemoteIfNoneExist, removeRemoteFs and reconnectRemoteFs
// all key off it. Two DIFFERENT configs hashing the SAME means they share
// one pooled connection -- which, for serverManager's privileged lane on a
// hop profile, meant the root-authenticated "privileged" connection WAS the
// user's own SFTP connection: disposing it killed the user's live transfer,
// and if it connected first, every later upload ran as root.
describe('hashOption', () => {
  it('is stable for the same option', () => {
    const option = { host: 'h', port: 22, username: 'u' };
    expect(hashOption(option)).toBe(hashOption({ host: 'h', port: 22, username: 'u' }));
  });

  it('differs for options that differ only by a top-level value', () => {
    const a = hashOption({ host: 'h1', port: 22, username: 'u' });
    const b = hashOption({ host: 'h2', port: 22, username: 'u' });
    expect(a).not.toBe(b);
  });

  it('does not collide when a value moves across a key boundary (the profileId regression)', () => {
    // Naive concatenation would make {name:'a', host:'b'} and
    // {name:'ab', host:''} hash the same -- exactly what profileId's own
    // NUL separator (registry.ts) exists to prevent.
    const a = hashOption({ name: 'a', host: 'b' });
    const b = hashOption({ name: 'ab', host: '' });
    expect(a).not.toBe(b);
  });

  it('is order-independent: key insertion order does not affect the hash', () => {
    const a = hashOption({ host: 'h', username: 'u', port: 22 });
    const b = hashOption({ port: 22, host: 'h', username: 'u' });
    expect(a).toBe(b);
  });

  describe('nested hop objects (the critical fix)', () => {
    it('differs for two configs whose ONLY difference is a nested hop value', () => {
      const a = hashOption({
        host: 'bastion', port: 22, username: 'jump', privateKeyPath: '/home/me/.ssh/id_rsa',
        hop: { host: 'target-a', username: 'targetUser', password: 'p' },
      });
      const b = hashOption({
        host: 'bastion', port: 22, username: 'jump', privateKeyPath: '/home/me/.ssh/id_rsa',
        hop: { host: 'target-b', username: 'targetUser', password: 'p' },
      });
      // The old implementation (Object.keys(o).map(k => o[k]).join('')) hashed
      // these identically: the `hop` object stringifies to the literal text
      // "[object Object]" regardless of its contents under Array.join.
      expect(a).not.toBe(b);
    });

    it('differs for two configs whose only difference is the hop object having root credentials', () => {
      const withoutRoot = hashOption({
        host: 'bastion', username: 'jump',
        hop: { host: 'target', username: 'targetUser', password: 'p' },
      });
      const withRoot = hashOption({
        host: 'bastion', username: 'jump',
        hop: { host: 'target', username: 'root', password: 'r' },
      });
      expect(withoutRoot).not.toBe(withRoot);
    });

    it('two configs with an identical hop object still hash the same (no false split)', () => {
      const a = hashOption({ host: 'bastion', username: 'jump', hop: { host: 'target', username: 'u' } });
      const b = hashOption({ host: 'bastion', username: 'jump', hop: { host: 'target', username: 'u' } });
      expect(a).toBe(b);
    });

    it('differs for two configs whose only difference is the innermost element of an array hop (multi-hop)', () => {
      const a = hashOption({
        host: 'hopA', username: 'a',
        hop: [{ host: 'hopB', username: 'b' }, { host: 'target', username: 'user1' }],
      });
      const b = hashOption({
        host: 'hopA', username: 'a',
        hop: [{ host: 'hopB', username: 'b' }, { host: 'target', username: 'user2' }],
      });
      expect(a).not.toBe(b);
    });

    it('an object hop and an array hop with equivalent innermost content still hash differently (shape matters)', () => {
      const objectHop = hashOption({ host: 'h', hop: { host: 'target', username: 'u' } });
      const arrayHop = hashOption({ host: 'h', hop: [{ host: 'target', username: 'u' }] });
      expect(objectHop).not.toBe(arrayHop);
    });
  });

  describe('the exact scenario from the review', () => {
    it('a hop profile with root credentials on the target hashes differently from the session config (must be a SEPARATE pooled connection)', () => {
      const session = {
        protocol: 'sftp', host: 'bastion.example.com', port: 22, username: 'jump',
        privateKeyPath: '/home/me/.ssh/id_rsa',
        hop: { host: 'target.example.com', username: 'app', password: 'p' },
      };
      const privileged = {
        protocol: 'sftp', host: 'bastion.example.com', port: 22, username: 'jump',
        privateKeyPath: '/home/me/.ssh/id_rsa',
        hop: { host: 'target.example.com', username: 'root', password: 'r' },
      };
      expect(hashOption(session)).not.toBe(hashOption(privileged));
    });

    it('a hop profile with NO root credentials hashes the same for both configs (correctly shares the pool entry)', () => {
      const config = {
        protocol: 'sftp', host: 'bastion.example.com', port: 22, username: 'jump',
        privateKeyPath: '/home/me/.ssh/id_rsa',
        hop: { host: 'target.example.com', username: 'app', password: 'p' },
      };
      // privilegedConfig(config) returns a value-identical copy when there are
      // no root credentials -- confirm that copy still hashes the same.
      const copy = JSON.parse(JSON.stringify(config));
      expect(hashOption(config)).toBe(hashOption(copy));
    });
  });
});
