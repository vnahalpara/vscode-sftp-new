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

    // Whether a given disposePrivileged is a real teardown or a no-op
    // standing in for the shared-connection case is decided entirely by the
    // CALLER (index.ts's privilegedConnectionIsSeparate -- see
    // privileged-lane-test.ts for that decision's own coverage, including
    // the hop/pool-key scenario that made a credential-presence check the
    // wrong test). The registry itself does not know or care which kind it
    // was handed; it always calls it exactly once. A no-op function is
    // "safe to call" *because* it is a no-op, not because the registry
    // treats it specially -- there is nothing here for the registry layer
    // to assert beyond "it gets called", which the disposeAll tests above
    // already establish for every disposePrivileged, no-op or not.

    describe('resilience to a throwing session.dispose() or disposePrivileged() (a leaked root SSH connection must not survive either failing)', () => {
      it('still calls disposePrivileged and forgets the token when session.dispose() throws', () => {
        const registry = createSessionRegistry();
        const disposePrivileged = jest.fn();
        const e = entry({
          session: { dispose: jest.fn(() => { throw new Error('dispose blew up'); }) } as any,
          disposePrivileged,
        });
        registry.set('profile-1', 'tok-1', e);

        expect(() => registry.disposeAll()).not.toThrow();

        expect(disposePrivileged).toHaveBeenCalledTimes(1);
        expect(registry.lookupSession('tok-1')).toBeUndefined();
      });

      it('still calls session.dispose() and forgets the token when disposePrivileged() throws', () => {
        const registry = createSessionRegistry();
        const e = entry({
          disposePrivileged: jest.fn(() => { throw new Error('removeRemoteFs blew up'); }),
        });
        registry.set('profile-1', 'tok-1', e);

        expect(() => registry.disposeAll()).not.toThrow();

        expect(e.session.dispose).toHaveBeenCalledTimes(1);
        expect(registry.lookupSession('tok-1')).toBeUndefined();
      });

      it('does not let one entry throwing stop later entries from being disposed', () => {
        const registry = createSessionRegistry();
        const broken = entry({
          session: { dispose: jest.fn(() => { throw new Error('boom'); }) } as any,
        });
        const healthy = entry();
        registry.set('profile-1', 'tok-1', broken);
        registry.set('profile-2', 'tok-2', healthy);

        registry.disposeAll();

        expect(healthy.session.dispose).toHaveBeenCalledTimes(1);
        expect(healthy.disposePrivileged).toHaveBeenCalledTimes(1);
      });

      it('does not let a throw during eviction (identity mismatch) escape to the caller', () => {
        const registry = createSessionRegistry();
        registry.set(
          'profile-1',
          'tok-1',
          entry({
            privilegedIdentity: 'session',
            disposePrivileged: jest.fn(() => { throw new Error('removeRemoteFs blew up'); }),
          })
        );

        // This runs on the request path (ensureSession -> registry.get()) --
        // a cleanup failure here must not surface as an uncaught exception
        // on an unrelated command.
        expect(() => registry.get('profile-1', 'root:abc123')).not.toThrow();
        expect(registry.lookupSession('tok-1')).toBeUndefined();
      });
    });
  });
});
