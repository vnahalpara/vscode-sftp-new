import { derivePort, parsePortRange } from '../vpnTunnel';

test('derivePort is deterministic for the same key', () => {
  const a = derivePort('/home/me/wg0.conf', [21000, 21999]);
  const b = derivePort('/home/me/wg0.conf', [21000, 21999]);
  expect(a).toBe(b);
});

test('derivePort stays inside the range, inclusive at both ends', () => {
  for (let i = 0; i < 500; i++) {
    const p = derivePort(`/cfg/${i}.conf`, [21000, 21999]);
    expect(p).toBeGreaterThanOrEqual(21000);
    expect(p).toBeLessThanOrEqual(21999);
  }
});

test('derivePort spreads different keys across the range', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    seen.add(derivePort(`/cfg/${i}.conf`, [21000, 21999]));
  }
  // A constant or near-constant function would collapse this. Not a
  // distribution test -- just a smoke test that the hash is being used.
  expect(seen.size).toBeGreaterThan(150);
});

test('a single-port range always yields that port', () => {
  expect(derivePort('anything', [21000, 21000])).toBe(21000);
});

test('parsePortRange accepts the documented form', () => {
  expect(parsePortRange('21000-21999')).toEqual([21000, 21999]);
});

test('parsePortRange falls back to the default on nonsense', () => {
  const def: [number, number] = [21000, 21999];
  expect(parsePortRange(undefined)).toEqual(def);
  expect(parsePortRange('')).toEqual(def);
  expect(parsePortRange('garbage')).toEqual(def);
  expect(parsePortRange('21999-21000')).toEqual(def); // reversed
  expect(parsePortRange('0-70000')).toEqual(def); // out of bounds
  expect(parsePortRange('-1--5')).toEqual(def);
  expect(parsePortRange('21000')).toEqual(def); // not a range
});

test('parsePortRange survives a setting that is not a string at all', () => {
  const def: [number, number] = [21000, 21999];
  // The declared type says string, but the value arrives from a hand-edited
  // JSON settings file, where "portRange": 21000 (quotes and dash forgotten)
  // is an ordinary typo. Anything without .trim() must fall back, not throw:
  // throwing here breaks every SFTP connection on the machine.
  expect(parsePortRange(21000 as any)).toEqual(def);
  expect(parsePortRange(true as any)).toEqual(def);
  expect(parsePortRange({} as any)).toEqual(def);
  expect(parsePortRange([] as any)).toEqual(def);
  expect(parsePortRange([21000, 21999] as any)).toEqual(def);
});
