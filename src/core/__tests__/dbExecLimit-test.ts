import { createDbExecLimit, dbExecLimitMessage } from '../dbExecLimit';

describe('createDbExecLimit', () => {
  it('grants slots up to the max', () => {
    const limit = createDbExecLimit(2);
    expect(limit.acquire()).not.toBeNull();
    expect(limit.acquire()).not.toBeNull();
  });

  it('refuses once the max concurrent slots are held', () => {
    const limit = createDbExecLimit(2);
    limit.acquire();
    limit.acquire();
    expect(limit.acquire()).toBeNull();
  });

  it('frees a slot on release, allowing another acquire', () => {
    const limit = createDbExecLimit(1);
    const release = limit.acquire();
    expect(limit.acquire()).toBeNull();
    release!();
    expect(limit.acquire()).not.toBeNull();
  });

  it('is idempotent -- releasing twice does not free two slots', () => {
    const limit = createDbExecLimit(1);
    const release = limit.acquire();
    release!();
    release!();
    // Only one slot exists; a double release must not manufacture a second.
    expect(limit.acquire()).not.toBeNull();
    expect(limit.acquire()).toBeNull();
  });
});

describe('dbExecLimitMessage', () => {
  it('names the limit', () => {
    expect(dbExecLimitMessage(2)).toContain('2');
  });
});
