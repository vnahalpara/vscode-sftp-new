// A one-to-many callback list, deliberately tiny and deliberately free of
// any `vscode` import so it can be unit tested on its own.
//
// It exists because the three-line version of it in index.ts -- an array,
// a push, and a for-loop with a try/catch -- is load-bearing on a
// privileged-read allowlist: the session registry offers ONE onTokenDisposed
// hook, while more than one piece of per-token state (the routes layer's
// file allowlist, and index.ts's own socket teardown) needs to hear about a
// disposed token. Get the fan-out subtly wrong -- forget to reset it when
// the server is rebuilt, or let one throwing listener skip the rest -- and
// the failure is a stale allowlist entry or a live socket for a session that
// no longer exists, neither of which announces itself.
//
// The three properties that matter, each pinned by a test:
//
//   * reset() drops every listener, so a rebuilt server's routes do not
//     leave the PREVIOUS instance's listener attached to a map nobody reads.
//   * a listener that throws does not stop the ones after it, and does not
//     stop the caller's own work around the fire().
//   * listeners fire in registration order.
export interface Fanout<T> {
  add(listener: (value: T) => void): void;
  fire(value: T): void;
  reset(): void;
}

// `onError` is injected rather than imported: this module stays free of the
// logger (and through it, of `vscode`), and the caller decides what a
// misbehaving listener is worth reporting as.
export function createFanout<T>(onError: (error: Error) => void = () => undefined): Fanout<T> {
  let listeners: Array<(value: T) => void> = [];

  return {
    add(listener: (value: T) => void): void {
      listeners.push(listener);
    },
    fire(value: T): void {
      // Snapshot first: a listener that add()s or reset()s while being
      // notified must not mutate the list this fire is walking.
      listeners.slice().forEach(listener => {
        try {
          listener(value);
        } catch (error) {
          onError(error as Error);
        }
      });
    },
    reset(): void {
      // A fresh array, not a length-0 truncation of the old one: fire()
      // above may be holding a snapshot of it, and an in-flight fire should
      // finish notifying the set it started with.
      listeners = [];
    },
  };
}
