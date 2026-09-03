import { createCoalescer, TimerApi } from '../reloadCoalescer';

// A hand-rolled clock rather than jest's: the coalescer takes its timers as an
// argument precisely so the test can drive them without touching globals.
function fakeTimers() {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextHandle = 1;
  let now = 0;

  const api: TimerApi = {
    set(fn: () => void, delayMs: number) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { at: now + delayMs, fn });
      return handle;
    },
    clear(handle: any) {
      pending.delete(handle as number);
    },
  };

  return {
    api,
    pendingCount: () => pending.size,
    advance(ms: number) {
      now += ms;
      const due: Array<() => void> = [];
      pending.forEach((entry, handle) => {
        if (entry.at <= now) {
          due.push(entry.fn);
          pending.delete(handle);
        }
      });
      due.forEach(fn => fn());
    },
  };
}

describe('createCoalescer', () => {
  it('runs once for two schedules of the same key inside the delay', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    // What one editor save looks like: onDidSaveTextDocument and the file
    // watcher's onDidChange, both for the same file.
    coalescer.schedule('/ws/a');
    clock.advance(100);
    coalescer.schedule('/ws/a');
    clock.advance(250);
    expect(ran).toEqual([]);

    clock.advance(100);
    expect(ran).toEqual(['/ws/a']);
  });

  it('does not run a key that was cancelled', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    coalescer.schedule('/ws/a');
    coalescer.cancel('/ws/a');
    clock.advance(1000);

    expect(ran).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('cancels only the key it is given', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    coalescer.schedule('/ws/a');
    coalescer.schedule('/ws/b');
    coalescer.cancel('/ws/a');
    clock.advance(300);

    expect(ran).toEqual(['/ws/b']);
  });

  it('runs each key once', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    coalescer.schedule('/ws/a');
    coalescer.schedule('/ws/b');
    clock.advance(300);

    expect(ran.sort()).toEqual(['/ws/a', '/ws/b']);
  });

  it('runs again for a key that is scheduled after its first run', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    coalescer.schedule('/ws/a');
    clock.advance(300);
    coalescer.schedule('/ws/a');
    clock.advance(300);

    expect(ran).toEqual(['/ws/a', '/ws/a']);
  });

  it('drops every pending key on dispose', () => {
    const clock = fakeTimers();
    const ran: string[] = [];
    const coalescer = createCoalescer<string>(key => ran.push(key), 300, clock.api);

    coalescer.schedule('/ws/a');
    coalescer.schedule('/ws/b');
    coalescer.dispose();
    clock.advance(1000);

    expect(ran).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });
});
