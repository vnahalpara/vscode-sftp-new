import { hashOption, copyConnectOption } from '../remoteFs';

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

  // A separator only separates if it cannot appear inside the things it
  // separates. JSON permits an escaped NUL inside a string, so a crafted
  // sftp.json could otherwise forge the separator: because keys are sorted,
  // a value in the alphabetically first key could swallow every later
  // key/value pair and impersonate a different config's pool key. These are
  // the exact colliding pairs a reviewer demonstrated against the previous
  // implementation.
  describe('a NUL inside a string value cannot forge the separator', () => {
    const SEP = '\u0000';

    test('a value cannot swallow the key/value pairs that follow it', () => {
      const real = { host: 'evil.example.com', password: 'r', username: 'root' };
      const forged = {
        host: ['evil.example.com', 'password', 'r', 'username', 'root'].join(SEP),
      };
      expect(hashOption(real)).not.toBe(hashOption(forged));
    });

    test('a string cannot impersonate a nested object', () => {
      const real = { hop: { host: 'target', username: 'root' } };
      const forged = {
        hop: '{' + ['host', 'target', 'username', 'root'].join(SEP) + '}',
      };
      expect(hashOption(real)).not.toBe(hashOption(forged));
    });

    test('a number and its string form stay distinguishable', () => {
      expect(hashOption({ port: 22 })).not.toBe(hashOption({ port: '22' }));
    });

    test('a null and the string "null" stay distinguishable', () => {
      expect(hashOption({ x: null })).not.toBe(hashOption({ x: 'null' }));
    });
  });
});

// Connecting mutates the option object it is given: sshClient.ts's
// `_doConnect` writes `port = 22` onto every non-final hop (`curOpt.port =
// 22`) and `privateKey = <file contents>` onto the innermost one
// (`lastOption.privateKey = buffer.toString()`), in place. Nothing between
// the file service and the client used to copy deeply enough to stop those
// writes reaching the caller's own config -- getHostInfo shallow-copies the
// top level only, so `config.hop` is the same object throughout.
//
// While hashOption was value-only that was invisible: every hop stringified
// to "[object Object]", so no write inside one could move the pool key. With
// a structure-aware key it is a live bug -- the key would change after the
// first successful connect, the next operation would miss the cache and open
// a SECOND connection, and the first would be orphaned where removeRemoteFs,
// reconnectRemoteFs and `SFTP: Reconnect` can never reach it.
describe('connect-time mutation cannot move the pool key', () => {
  // Exactly the writes `_doConnect` performs, against whatever object graph
  // it is handed. Kept as a faithful transcription rather than a call into
  // sshClient so this test needs no ssh2, no socket and no filesystem.
  function simulateConnectMutation(option: any): void {
    const { hop, vpn, ...top } = option; // tslint:disable-line no-unused-variable
    if (!hop || (Array.isArray(hop) && hop.length === 0)) {
      return;
    }
    const chain = Array.isArray(hop) ? [top].concat(hop) : [top, hop];
    const lastOption = chain.pop();
    chain.forEach(curOpt => {
      if (curOpt.port === undefined) {
        curOpt.port = 22;
      }
      if (curOpt.privateKeyPath) {
        curOpt.privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\n…';
      }
    });
    if (lastOption.privateKeyPath) {
      lastOption.privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\n…';
    }
  }

  it('an object hop keyed off privateKeyPath hashes identically before and after a connect', () => {
    const config = {
      protocol: 'sftp',
      host: 'bastion.example.com',
      port: 22,
      username: 'jump',
      hop: { host: 'target.example.com', username: 'app', privateKeyPath: '/home/me/.ssh/id_rsa' },
    };
    const before = hashOption(config);

    // What the pool actually hands the client: its own private copy.
    const pooled: any = copyConnectOption(config);
    simulateConnectMutation(pooled);

    expect(pooled.hop.privateKey).toBeDefined(); // the mutation really happened
    expect((config.hop as any).privateKey).toBeUndefined();
    expect(hashOption(config)).toBe(before);
  });

  it('an array hop whose middle entry omits `port` hashes identically before and after a connect', () => {
    const config = {
      protocol: 'sftp',
      host: 'first.example.com',
      port: 22,
      username: 'jump',
      hop: [
        { host: 'middle.example.com', username: 'mid' }, // no port: _doConnect writes 22
        { host: 'target.example.com', username: 'app', privateKeyPath: '/home/me/.ssh/id_rsa' },
      ],
    };
    const before = hashOption(config);

    const pooled: any = copyConnectOption(config);
    simulateConnectMutation(pooled);

    expect(pooled.hop[0].port).toBe(22);
    expect(pooled.hop[1].privateKey).toBeDefined();
    expect((config.hop[0] as any).port).toBeUndefined();
    expect((config.hop[1] as any).privateKey).toBeUndefined();
    expect(hashOption(config)).toBe(before);
  });

  it('without the copy the key really does move (the bug this pins)', () => {
    const config: any = {
      protocol: 'sftp',
      host: 'bastion.example.com',
      username: 'jump',
      hop: { host: 'target.example.com', username: 'app', privateKeyPath: '/home/me/.ssh/id_rsa' },
    };
    const before = hashOption(config);
    simulateConnectMutation(config); // the old shallow-copy behaviour
    expect(hashOption(config)).not.toBe(before);
  });

  describe('copyConnectOption', () => {
    it('shares no nested object or array with the original', () => {
      const config = { host: 'h', hop: [{ host: 'a' }, { host: 'b' }], vpn: { configFile: '/x.conf' } };
      const copy = copyConnectOption(config);
      expect(copy).toEqual(config);
      expect(copy.hop).not.toBe(config.hop);
      expect(copy.hop[0]).not.toBe(config.hop[0]);
      expect(copy.vpn).not.toBe(config.vpn);
    });

    // Copying a Buffer, a socket or a callback would change its behaviour,
    // and none of them is a container a connect-time write lands inside of.
    it('carries non-plain values over by reference', () => {
      const debug = () => undefined;
      const buffer = Buffer.from('key');
      const copy = copyConnectOption({ debug, buffer, sock: buffer });
      expect(copy.debug).toBe(debug);
      expect(copy.buffer).toBe(buffer);
    });
  });
});
