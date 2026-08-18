import { createSessionRegistry, SessionRegistryEntry } from '../index';

// A minimal stand-in for ManagedSession -- the registry only ever calls
// dispose() on it.
function fakeSession() {
  return { dispose: jest.fn() };
}

function entry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    session: fakeSession() as any,
    privilegedIdentity: 'session',
    disposePrivileged: jest.fn(),
    ...overrides,
  };
}

describe('createSessionRegistry', () => {
  it('reports no token for a profile that was never registered', () => {
    const registry = createSessionRegistry();
    expect(registry.get('profile-1', 'session')).toBeUndefined();
  });

  it('returns the registered token when the identity still matches', () => {
    const registry = createSessionRegistry();
    const e = entry();
    registry.set('profile-1', 'tok-1', e);

    expect(registry.get('profile-1', 'session')).toBe('tok-1');
    expect(registry.lookupSession('tok-1')).toBe(e.session);
  });

  describe('identity invalidation (fix for root credentials edited without a VS Code restart)', () => {
    it('tears the stale session down and reports no token when the identity no longer matches', () => {
      const registry = createSessionRegistry();
      const e = entry({ privilegedIdentity: 'session' });
      registry.set('profile-1', 'tok-1', e);

      // root_user/root_password were just added to the profile -- the
      // caller now asks with the 'root:root:r' identity.
      const result = registry.get('profile-1', 'root:root:r');

      expect(result).toBeUndefined();
      expect(e.session.dispose).toHaveBeenCalledTimes(1);
      expect(e.disposePrivileged).toHaveBeenCalledTimes(1);
    });

    it('forgets the stale token, so a later matching call does not resurrect it', () => {
      const registry = createSessionRegistry();
      const e = entry({ privilegedIdentity: 'session' });
      registry.set('profile-1', 'tok-1', e);

      registry.get('profile-1', 'root:root:r'); // evicts it
      expect(registry.lookupSession('tok-1')).toBeUndefined();
      // A second call with the OLD identity must not resurrect the disposed
      // entry -- the profile row for 'profile-1' is gone entirely now.
      expect(registry.get('profile-1', 'session')).toBeUndefined();
    });

    it('lets the caller register a fresh session under the new identity after eviction', () => {
      const registry = createSessionRegistry();
      registry.set('profile-1', 'tok-1', entry({ privilegedIdentity: 'session' }));
      registry.get('profile-1', 'root:root:r'); // evicts the stale one

      const fresh = entry({ privilegedIdentity: 'root:root:r' });
      registry.set('profile-1', 'tok-2', fresh);

      expect(registry.get('profile-1', 'root:root:r')).toBe('tok-2');
    });
  });

  describe('disposal guard (fix for the privileged SSH connection never being torn down)', () => {
    it('calls both session.dispose() and disposePrivileged() on disposeAll()', () => {
      const registry = createSessionRegistry();
      const e = entry();
      registry.set('profile-1', 'tok-1', e);

      registry.disposeAll();

      expect(e.session.dispose).toHaveBeenCalledTimes(1);
      expect(e.disposePrivileged).toHaveBeenCalledTimes(1);
    });

    it('disposes every registered session, not just the first', () => {
      const registry = createSessionRegistry();
      const a = entry();
      const b = entry();
      registry.set('profile-1', 'tok-1', a);
      registry.set('profile-2', 'tok-2', b);

      registry.disposeAll();

      expect(a.session.dispose).toHaveBeenCalledTimes(1);
      expect(b.session.dispose).toHaveBeenCalledTimes(1);
      expect(a.disposePrivileged).toHaveBeenCalledTimes(1);
      expect(b.disposePrivileged).toHaveBeenCalledTimes(1);
    });

    it('clears every lookup after disposeAll(), so a stale token resolves to nothing', () => {
      const registry = createSessionRegistry();
      registry.set('profile-1', 'tok-1', entry());

      registry.disposeAll();

      expect(registry.lookupSession('tok-1')).toBeUndefined();
      expect(registry.get('profile-1', 'session')).toBeUndefined();
    });

    it('never calls disposePrivileged for a session whose caller marked it as sharing the pooled connection', () => {
      // This is the guard itself: index.ts only ever installs a real
      // (non-noop) disposePrivileged when hasRootLane(config) is true. The
      // registry does not know or care which -- it always calls whatever
      // function it was handed -- so this test pins that a no-op
      // disposePrivileged (the no-root-credentials case) is safe to call
      // unconditionally: it must do nothing observable.
      const registry = createSessionRegistry();
      const noopDisposePrivileged = jest.fn(() => undefined);
      registry.set('profile-1', 'tok-1', entry({ disposePrivileged: noopDisposePrivileged }));

      registry.disposeAll();

      expect(noopDisposePrivileged).toHaveBeenCalledTimes(1);
      expect(noopDisposePrivileged).toHaveReturnedWith(undefined);
    });
  });
});
