import { resolveBinary, ResolveOptions } from '../resolveBinary';

// A filesystem stand-in: only the listed paths exist and are executable.
function fsWith(...present: string[]): (p: string) => boolean {
  return p => present.indexOf(p) !== -1;
}

// A macOS machine with the minimal PATH a GUI-launched VS Code hands us.
function opts(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    pathEnv: '/usr/bin:/bin',
    platform: 'darwin',
    homeDir: '/Users/me',
    exists: fsWith(),
    ...overrides,
  };
}

const UNIX_FALLBACKS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/Users/me/go/bin',
  '/Users/me/.local/bin',
  '/home/linuxbrew/.linuxbrew/bin',
];

test('an explicit path is returned untouched', () => {
  expect(resolveBinary('/opt/custom/wireproxy', opts()).path).toBe('/opt/custom/wireproxy');
});

test('an explicit path is never searched for', () => {
  expect(resolveBinary('/opt/custom/wireproxy', opts()).tried).toEqual([]);
});

test('a leading ~/ in an explicit path expands to the home directory', () => {
  expect(resolveBinary('~/bin/wireproxy', opts()).path).toBe('/Users/me/bin/wireproxy');
});

test('a bare name found on PATH resolves to its absolute path', () => {
  const found = resolveBinary('wireproxy', opts({ exists: fsWith('/bin/wireproxy') }));
  expect(found.path).toBe('/bin/wireproxy');
});

test('a bare name found on PATH reports only the directories it visited', () => {
  const found = resolveBinary('wireproxy', opts({ exists: fsWith('/bin/wireproxy') }));
  expect(found.tried).toEqual(['/usr/bin', '/bin']);
});

test('a bare name missing from PATH is found in the Homebrew prefix', () => {
  const found = resolveBinary('wireproxy', opts({ exists: fsWith('/opt/homebrew/bin/wireproxy') }));
  expect(found.path).toBe('/opt/homebrew/bin/wireproxy');
});

test('a bare name missing from PATH is found under the home directory', () => {
  const found = resolveBinary('wireproxy', opts({ exists: fsWith('/Users/me/go/bin/wireproxy') }));
  expect(found.path).toBe('/Users/me/go/bin/wireproxy');
});

test('PATH wins over the well-known fallbacks', () => {
  const found = resolveBinary(
    'wireproxy',
    opts({ exists: fsWith('/bin/wireproxy', '/opt/homebrew/bin/wireproxy') })
  );
  expect(found.path).toBe('/bin/wireproxy');
});

test('an unfound name comes back bare, so the caller still gets its ENOENT', () => {
  expect(resolveBinary('wireproxy', opts()).path).toBe('wireproxy');
});

test('an unfound name reports every directory searched, PATH first', () => {
  expect(resolveBinary('wireproxy', opts()).tried).toEqual(
    ['/usr/bin', '/bin'].concat(UNIX_FALLBACKS)
  );
});

test('a directory already on PATH is not searched twice', () => {
  const found = resolveBinary('wireproxy', opts({ pathEnv: '/opt/homebrew/bin:/usr/bin' }));
  expect(found.tried).toEqual([
    '/opt/homebrew/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/Users/me/go/bin',
    '/Users/me/.local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ]);
});

test('an empty PATH still searches the well-known directories', () => {
  const found = resolveBinary(
    'wireproxy',
    opts({ pathEnv: '', exists: fsWith('/opt/homebrew/bin/wireproxy') })
  );
  expect(found.path).toBe('/opt/homebrew/bin/wireproxy');
});

test('an undefined PATH still searches the well-known directories', () => {
  const found = resolveBinary(
    'wireproxy',
    opts({ pathEnv: undefined, exists: fsWith('/usr/local/bin/wireproxy') })
  );
  expect(found.path).toBe('/usr/local/bin/wireproxy');
});

test('an empty PATH entry is skipped rather than searched as the working directory', () => {
  expect(resolveBinary('wireproxy', opts({ pathEnv: '/usr/bin::/bin' })).tried).toEqual(
    ['/usr/bin', '/bin'].concat(UNIX_FALLBACKS)
  );
});

function windows(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    pathEnv: 'C:\\Windows;C:\\bin',
    platform: 'win32',
    homeDir: 'C:\\Users\\me',
    exists: fsWith(),
    ...overrides,
  };
}

test('on Windows a bare name also matches the .exe', () => {
  const found = resolveBinary('wireproxy', windows({ exists: fsWith('C:\\bin\\wireproxy.exe') }));
  expect(found.path).toBe('C:\\bin\\wireproxy.exe');
});

test('on Windows the unix-only fallbacks are not searched', () => {
  expect(resolveBinary('wireproxy', windows()).tried).toEqual(['C:\\Windows', 'C:\\bin']);
});

test('on Windows a backslashed path counts as explicit', () => {
  const found = resolveBinary('C:\\tools\\wireproxy.exe', windows());
  expect(found.path).toBe('C:\\tools\\wireproxy.exe');
});
