// The timer functions, injected so this module has no global dependency and
// the tests can run the clock themselves. `any` for the handle because node's
// setTimeout returns a Timer and a browser's returns a number.
export interface TimerApi {
  set(handler: () => void, delayMs: number): any;
  clear(handle: any): void;
}

export interface Coalescer<K> {
  schedule(key: K): void;
  cancel(key: K): void;
  dispose(): void;
}

/**
 * Collapses repeated triggers for one key into a single trailing `run(key)`.
 *
 * A config file reaches us from more than one source -- an editor save fires
 * both onDidSaveTextDocument and the watcher's onDidChange -- and two reloads
 * of the same file racing each other would dispose and recreate its services
 * twice and log a collision that is not real.
 */
export function createCoalescer<K>(
  run: (key: K) => void,
  delayMs: number,
  timers: TimerApi = { set: setTimeout, clear: clearTimeout }
): Coalescer<K> {
  const pending = new Map<K, any>();

  return {
    schedule(key: K) {
      const existing = pending.get(key);
      if (existing !== undefined) {
        timers.clear(existing);
      }
      pending.set(
        key,
        timers.set(() => {
          pending.delete(key);
          run(key);
        }, delayMs)
      );
    },

    cancel(key: K) {
      const existing = pending.get(key);
      if (existing !== undefined) {
        timers.clear(existing);
        pending.delete(key);
      }
    },

    dispose() {
      pending.forEach(handle => timers.clear(handle));
      pending.clear();
    },
  };
}
