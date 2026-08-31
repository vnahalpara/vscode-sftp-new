import {
  MAX_CONCURRENT_TERMINALS,
  createChannelLimit,
} from '../channelLimit';
import { MAX_CONCURRENT_FOLLOWS, createFollowLimit } from '../logFollow';

describe('createChannelLimit', () => {
  it('hands out slots up to the cap', () => {
    const limit = createChannelLimit(2);
    expect(limit.acquire('a')).not.toBeNull();
    expect(limit.acquire('a')).not.toBeNull();
    expect(limit.acquire('a')).toBeNull();
  });

  // Sessions must not spend each other's budget: the cap is per pooled SSH
  // connection, and two tokens are two connections.
  it('counts each token separately', () => {
    const limit = createChannelLimit(1);
    expect(limit.acquire('a')).not.toBeNull();
    expect(limit.acquire('b')).not.toBeNull();
    expect(limit.acquire('a')).toBeNull();
  });

  it('frees a slot on release', () => {
    const limit = createChannelLimit(1);
    const release = limit.acquire('a')!;
    expect(limit.acquire('a')).toBeNull();
    release();
    expect(limit.acquire('a')).not.toBeNull();
  });

  // A double release would hand the session a slot it is not entitled to,
  // which is precisely how a cap stops being one.
  it('ignores a second release', () => {
    const limit = createChannelLimit(1);
    const release = limit.acquire('a')!;
    release();
    release();
    expect(limit.acquire('a')).not.toBeNull();
    expect(limit.acquire('a')).toBeNull();
  });

  // Self-pruning matters because these instances are module-level and outlive
  // any one http.Server, so nothing clears them on session disposal.
  it('forgets a token once it holds nothing', () => {
    const limit = createChannelLimit(1);
    limit.acquire('a')!();
    expect(limit.active('a')).toBe(0);
  });
});

describe('the channel budget', () => {
  // The whole point of the Terminal cap: follows were bounded at four while
  // terminals were unbounded, against the same OpenSSH MaxSessions of 10.
  it('caps terminals as well as follows', () => {
    expect(MAX_CONCURRENT_TERMINALS).toBeGreaterThan(0);
    expect(MAX_CONCURRENT_FOLLOWS).toBeGreaterThan(0);
  });

  // A person opens a shell by clicking a tab; a follow can be re-opened by a
  // reconnect loop. The consumer that can multiply on its own gets the larger
  // share.
  it('gives follows more headroom than terminals, since only follows multiply', () => {
    expect(MAX_CONCURRENT_TERMINALS).toBeLessThan(MAX_CONCURRENT_FOLLOWS);
  });

  // 1 SFTP + 1 sampler + 4 follows + 2 terminals + 2 db-exec = 10, which is
  // exactly OpenSSH's default. Anything above this would mean the long-lived
  // channels alone could exhaust it before a single privileged command ran.
  it('keeps the long-lived consumers within OpenSSH MaxSessions', () => {
    const SFTP = 1;
    const SAMPLER = 1;
    const DB_EXEC = 2;
    expect(SFTP + SAMPLER + MAX_CONCURRENT_FOLLOWS + MAX_CONCURRENT_TERMINALS + DB_EXEC)
      .toBeLessThanOrEqual(10);
  });
});

describe('createFollowLimit', () => {
  // It is now a thin wrapper over the shared primitive; the behaviour every
  // existing caller relies on must be unchanged.
  it('still defaults to MAX_CONCURRENT_FOLLOWS', () => {
    const limit = createFollowLimit();
    for (let i = 0; i < MAX_CONCURRENT_FOLLOWS; i++) {
      expect(limit.acquire('t')).not.toBeNull();
    }
    expect(limit.acquire('t')).toBeNull();
  });
});
