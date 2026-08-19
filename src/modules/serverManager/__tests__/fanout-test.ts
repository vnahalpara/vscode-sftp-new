import { createFanout } from '../fanout';

test('fires every listener with the value', () => {
  const fanout = createFanout<string>();
  const seen: string[] = [];
  fanout.add(v => seen.push(`a:${v}`));
  fanout.add(v => seen.push(`b:${v}`));

  fanout.fire('tok');

  expect(seen).toEqual(['a:tok', 'b:tok']);
});

test('preserves registration order', () => {
  const fanout = createFanout<number>();
  const order: string[] = [];
  fanout.add(() => order.push('first'));
  fanout.add(() => order.push('second'));
  fanout.add(() => order.push('third'));

  fanout.fire(1);

  expect(order).toEqual(['first', 'second', 'third']);
});

// The whole reason this is a fan-out and not a single callback: index.ts
// rebuilds its routes on every server start, and each buildRoutes registers
// a listener. Without reset(), the previous instance's listener stays
// attached to an allowlist map nobody will ever read again.
test('reset drops previously registered listeners', () => {
  const fanout = createFanout<string>();
  const stale = jest.fn();
  fanout.add(stale);

  fanout.reset();
  const fresh = jest.fn();
  fanout.add(fresh);
  fanout.fire('tok');

  expect(stale).not.toHaveBeenCalled();
  expect(fresh).toHaveBeenCalledWith('tok');
});

test('reset with no listeners registered is harmless', () => {
  const fanout = createFanout<string>();
  expect(() => {
    fanout.reset();
    fanout.fire('tok');
  }).not.toThrow();
});

// A listener that throws must not take the others with it: the ones after
// it are the ones that prune a disposed session's allowlist.
test('a throwing listener does not stop the ones after it', () => {
  const errors: string[] = [];
  const fanout = createFanout<string>(error => errors.push(error.message));
  const after = jest.fn();
  fanout.add(() => {
    throw new Error('boom');
  });
  fanout.add(after);

  expect(() => fanout.fire('tok')).not.toThrow();
  expect(after).toHaveBeenCalledWith('tok');
  expect(errors).toEqual(['boom']);
});

test('a throwing listener with no onError supplied still does not escape', () => {
  const fanout = createFanout<string>();
  fanout.add(() => {
    throw new Error('boom');
  });

  expect(() => fanout.fire('tok')).not.toThrow();
});

// A listener that mutates the list while it is being notified must not
// change the set this fire() is walking -- otherwise the notification order
// depends on what the listeners themselves did halfway through.
test('a listener added during fire is not called by that same fire', () => {
  const fanout = createFanout<string>();
  const late = jest.fn();
  fanout.add(() => fanout.add(late));

  fanout.fire('first');
  expect(late).not.toHaveBeenCalled();

  fanout.fire('second');
  expect(late).toHaveBeenCalledWith('second');
});

test('a reset during fire still notifies the listeners that fire started with', () => {
  const fanout = createFanout<string>();
  const second = jest.fn();
  fanout.add(() => fanout.reset());
  fanout.add(second);

  fanout.fire('tok');

  expect(second).toHaveBeenCalledWith('tok');
});
