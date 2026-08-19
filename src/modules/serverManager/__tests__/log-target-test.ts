import { logTargetFromRequest } from '../index';

// Exactly one of ?path=/?unit= must be present. Anything else is not a
// request /ws/logs knows how to serve, and onLogs closes it 1011 with a
// reason -- never a bare ws.close(), which sends code 1005 and no text and
// is indistinguishable from a server bug.
function req(url: string): any {
  return { url, headers: {} };
}

test('reads a file target', () => {
  expect(logTargetFromRequest(req('/ws/logs?t=abc&path=/var/log/syslog'))).toEqual({
    kind: 'file',
    path: '/var/log/syslog',
  });
});

test('reads a unit target', () => {
  expect(logTargetFromRequest(req('/ws/logs?t=abc&unit=nginx.service'))).toEqual({
    kind: 'unit',
    unit: 'nginx.service',
  });
});

test('refuses both path and unit', () => {
  expect(logTargetFromRequest(req('/ws/logs?path=/var/log/syslog&unit=nginx.service'))).toBeNull();
});

test('refuses neither', () => {
  expect(logTargetFromRequest(req('/ws/logs?t=abc'))).toBeNull();
});

test('refuses an empty value', () => {
  expect(logTargetFromRequest(req('/ws/logs?path=&unit='))).toBeNull();
});

test('refuses a repeated parameter rather than picking one', () => {
  // node parses a repeated key into an array, which is neither a string nor
  // an unambiguous request.
  expect(logTargetFromRequest(req('/ws/logs?path=/var/log/a&path=/var/log/b'))).toBeNull();
});

test('refuses a missing url instead of throwing', () => {
  expect(logTargetFromRequest({ headers: {} } as any)).toBeNull();
});

// This runs inside wss.handleUpgrade's synchronous callback on an
// ALREADY-upgraded socket: a throw there is an uncaught exception in the
// extension host plus a leaked socket. Legacy url.parse throws on an
// unterminated IPv6 literal, which is why this goes through wsServer.ts's
// parseSafe rather than calling url.parse directly.
test('refuses an unparseable request target instead of throwing', () => {
  expect(() => logTargetFromRequest(req('http://['))).not.toThrow();
  expect(logTargetFromRequest(req('http://['))).toBeNull();
});
