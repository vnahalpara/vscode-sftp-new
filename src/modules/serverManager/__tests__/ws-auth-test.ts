import { checkUpgrade } from '../wsServer';

const PORT = 5599;
const valid = (t: string) => t === 'good-token';
const ok = (over: any = {}) => ({
  url: '/ws/terminal?t=good-token',
  headers: { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}`, ...over },
});

test('accepts a well-formed upgrade', () => {
  expect(checkUpgrade(ok(), PORT, valid).ok).toBe(true);
});

test('rejects a missing token', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/terminal' }, PORT, valid).ok).toBe(false);
});

test('rejects a wrong token', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/terminal?t=nope' }, PORT, valid).ok).toBe(false);
});

test('rejects a foreign Origin even with a VALID token', () => {
  const res = checkUpgrade(ok({ origin: 'https://evil.example.com' }), PORT, valid);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/origin/i);
});

test('rejects a rebound Host even with a valid token and no Origin', () => {
  const res = checkUpgrade(
    { url: '/ws/terminal?t=good-token', headers: { host: 'evil.example.com' } }, PORT, valid);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/host/i);
});

test('accepts localhost as well as 127.0.0.1', () => {
  expect(checkUpgrade(ok({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }), PORT, valid).ok).toBe(true);
});

test('rejects a host on a DIFFERENT port', () => {
  expect(checkUpgrade(ok({ host: `127.0.0.1:${PORT + 1}` }), PORT, valid).ok).toBe(false);
});

test('rejects an unknown ws path', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/evil?t=good-token' }, PORT, valid).ok).toBe(false);
});

// The single most important acceptance case after the happy path: Origin is
// ABSENT for every non-browser client (curl, a test harness, the extension's
// own tooling). An implementation that rejected a missing Origin would look
// "stricter" and pass every rejection test above while breaking all of them.
test('ACCEPTS an absent Origin when Host and token are good', () => {
  const res = checkUpgrade(
    { url: '/ws/terminal?t=good-token', headers: { host: `127.0.0.1:${PORT}` } },
    PORT,
    valid
  );
  expect(res.ok).toBe(true);
  expect(res.reason).toBe(null);
});

test('accepts the token from the x-sftp-token header instead of the query', () => {
  const req = { ...ok({ 'x-sftp-token': 'good-token' }), url: '/ws/terminal' };
  expect(checkUpgrade(req, PORT, valid).ok).toBe(true);
});

test('accepts /ws/logs, the other known path', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/logs?t=good-token' }, PORT, valid).ok).toBe(true);
});

// Host names are case-insensitive; url.parse already lowercases the host it
// pulls out of an Origin, so without normalising the raw Host header the two
// checks disagreed and a legitimate client was refused.
test('accepts an upper-case Host, the same as the equivalent Origin', () => {
  const res = checkUpgrade(
    ok({ host: `LOCALHOST:${PORT}`, origin: `http://LOCALHOST:${PORT}` }),
    PORT,
    valid
  );
  expect(res.ok).toBe(true);
});

// url.parse throws ERR_INVALID_URL on an unterminated IPv6 literal. Both of
// these are parsed BEFORE the token check, so an unguarded parse would be an
// uncaught throw in the extension host reachable with no credential at all.
test('rejects -- and does not throw on -- an unparseable Origin, with no token', () => {
  let res: any;
  expect(() => {
    res = checkUpgrade(
      { url: '/ws/terminal', headers: { host: `127.0.0.1:${PORT}`, origin: 'http://[' } },
      PORT,
      valid
    );
  }).not.toThrow();
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/origin/i);
});

test('rejects -- and does not throw on -- an unparseable request target', () => {
  let res: any;
  expect(() => {
    res = checkUpgrade({ url: 'http://[', headers: { host: `127.0.0.1:${PORT}` } }, PORT, valid);
  }).not.toThrow();
  expect(res.ok).toBe(false);
});

test('rejects an https Origin on our own host and port', () => {
  const res = checkUpgrade(ok({ origin: `https://127.0.0.1:${PORT}` }), PORT, valid);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/origin/i);
});

test('rejects the literal Origin "null" (a sandboxed frame or file://)', () => {
  expect(checkUpgrade(ok({ origin: 'null' }), PORT, valid).ok).toBe(false);
});
