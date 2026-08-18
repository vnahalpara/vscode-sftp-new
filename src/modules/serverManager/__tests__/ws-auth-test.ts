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
