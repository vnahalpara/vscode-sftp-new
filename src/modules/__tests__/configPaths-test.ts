import * as path from 'path';
import {
  CONFIG_EXCLUDE_GLOB,
  CONFIG_SEARCH_MAX_RESULTS,
  clampDepth,
  configDepth,
  configRootOf,
  isConfigPath,
  relativeConfigRootLabel,
  selectDiscovered,
} from '../configPaths';

const posix = path.posix;
const win32 = path.win32;

describe('configRootOf', () => {
  it('is the folder holding the .vscode directory (posix)', () => {
    expect(configRootOf('/ws/site/.vscode/sftp.json', posix)).toBe('/ws/site');
  });

  it('is the folder holding the .vscode directory (win32)', () => {
    expect(configRootOf('C:\\ws\\site\\.vscode\\sftp.json', win32)).toBe('C:\\ws\\site');
  });

  it('is the workspace folder itself for a root-level config', () => {
    expect(configRootOf('/ws/.vscode/sftp.json', posix)).toBe('/ws');
  });
});

describe('configDepth', () => {
  it('is 0 for a root-level config', () => {
    expect(configDepth('/ws', '/ws/.vscode/sftp.json', posix)).toBe(0);
  });

  it('is 1 for a config one directory down', () => {
    expect(configDepth('/ws', '/ws/DevServer/.vscode/sftp.json', posix)).toBe(1);
  });

  it('is 2 for the spec example', () => {
    expect(
      configDepth('/ws', '/ws/DevServer/stathmosgroup-online/.vscode/sftp.json', posix)
    ).toBe(2);
  });

  it('ignores a trailing separator on the folder', () => {
    expect(configDepth('/ws/', '/ws/a/.vscode/sftp.json', posix)).toBe(1);
  });

  it('is -1 for a config outside the folder', () => {
    expect(configDepth('/ws', '/other/a/.vscode/sftp.json', posix)).toBe(-1);
  });

  // '/ws-two' starts with '/ws' as a STRING but is not under it. A naive
  // indexOf(0) prefix check gets this wrong; path.relative does not.
  it('is -1 for a sibling folder whose name starts with the folder name', () => {
    expect(configDepth('/ws', '/ws-two/.vscode/sftp.json', posix)).toBe(-1);
  });

  it('counts win32 segments', () => {
    expect(configDepth('C:\\ws', 'C:\\ws\\a\\b\\.vscode\\sftp.json', win32)).toBe(2);
  });

  it('matches a win32 folder case-insensitively, as Windows does', () => {
    expect(configDepth('C:\\Work\\Proj', 'C:\\work\\proj\\site\\.vscode\\sftp.json', win32)).toBe(1);
  });

  it('is -1 across win32 drives', () => {
    expect(configDepth('C:\\ws', 'D:\\ws\\a\\.vscode\\sftp.json', win32)).toBe(-1);
  });
});

describe('isConfigPath', () => {
  it('accepts sftp.json inside a .vscode directory', () => {
    expect(isConfigPath('/ws/a/.vscode/sftp.json', posix)).toBe(true);
  });

  it('accepts a win32 config path', () => {
    expect(isConfigPath('C:\\ws\\a\\.vscode\\sftp.json', win32)).toBe(true);
  });

  // This is the guard that keeps a stray sftp.json from reloading the wrong
  // folder's services: its config root would be two levels up from a file
  // that has nothing to do with the extension.
  it('rejects sftp.json outside a .vscode directory', () => {
    expect(isConfigPath('/ws/a/sftp.json', posix)).toBe(false);
  });

  it('rejects another file inside .vscode', () => {
    expect(isConfigPath('/ws/a/.vscode/settings.json', posix)).toBe(false);
  });
});

describe('clampDepth', () => {
  it('defaults to 4 when the setting is missing', () => {
    expect(clampDepth(undefined)).toBe(4);
  });

  it('defaults to 4 for a non-number', () => {
    expect(clampDepth('3' as any)).toBe(4);
  });

  it('defaults to 4 for NaN', () => {
    expect(clampDepth(NaN)).toBe(4);
  });

  it('keeps a value in range', () => {
    expect(clampDepth(0)).toBe(0);
    expect(clampDepth(7)).toBe(7);
  });

  it('clamps below 0 and above 10', () => {
    expect(clampDepth(-3)).toBe(0);
    expect(clampDepth(99)).toBe(10);
  });

  it('floors a fractional value', () => {
    expect(clampDepth(2.9)).toBe(2);
  });
});

describe('relativeConfigRootLabel', () => {
  it('is empty for the workspace folder itself', () => {
    expect(relativeConfigRootLabel('/ws', '/ws', posix)).toBe('');
  });

  it('is the relative path for a nested root', () => {
    expect(relativeConfigRootLabel('/ws', '/ws/DevServer/site', posix)).toBe('DevServer/site');
  });

  it('uses forward slashes for a win32 root, because it is display text', () => {
    expect(relativeConfigRootLabel('C:\\ws', 'C:\\ws\\a\\b', win32)).toBe('a/b');
  });

  it('falls back to the absolute root when it is not under the folder', () => {
    expect(relativeConfigRootLabel('/ws', '/other/a', posix)).toBe('/other/a');
  });
});

describe('search constants', () => {
  it('excludes the heavy directories the spec names', () => {
    expect(CONFIG_EXCLUDE_GLOB).toBe(
      '**/{node_modules,vendor,.git,dist,build,.cache,bower_components}/**'
    );
  });

  it('caps the search at 500 results', () => {
    expect(CONFIG_SEARCH_MAX_RESULTS).toBe(500);
  });
});

describe('selectDiscovered', () => {
  it('keeps the root-level config even when the search found nothing', () => {
    expect(
      selectDiscovered('/ws', '/ws/.vscode/sftp.json', [], 0, posix)
    ).toEqual(['/ws/.vscode/sftp.json']);
  });

  it('returns nothing when there is no root config and no results', () => {
    expect(selectDiscovered('/ws', null, [], 4, posix)).toEqual([]);
  });

  it('de-duplicates the root config against the search results', () => {
    expect(
      selectDiscovered(
        '/ws',
        '/ws/.vscode/sftp.json',
        ['/ws/.vscode/sftp.json', '/ws/a/.vscode/sftp.json'],
        4,
        posix
      )
    ).toEqual(['/ws/.vscode/sftp.json', '/ws/a/.vscode/sftp.json']);
  });

  it('drops results deeper than the depth', () => {
    expect(
      selectDiscovered(
        '/ws',
        null,
        ['/ws/a/.vscode/sftp.json', '/ws/a/b/c/.vscode/sftp.json'],
        2,
        posix
      )
    ).toEqual(['/ws/a/.vscode/sftp.json']);
  });

  it('drops results outside the folder', () => {
    expect(
      selectDiscovered('/ws', null, ['/other/.vscode/sftp.json'], 4, posix)
    ).toEqual([]);
  });

  it('drops a result that is not a .vscode/sftp.json', () => {
    expect(selectDiscovered('/ws', null, ['/ws/a/sftp.json'], 4, posix)).toEqual([]);
  });

  it('sorts by path', () => {
    expect(
      selectDiscovered(
        '/ws',
        null,
        ['/ws/c/.vscode/sftp.json', '/ws/a/.vscode/sftp.json', '/ws/b/.vscode/sftp.json'],
        4,
        posix
      )
    ).toEqual([
      '/ws/a/.vscode/sftp.json',
      '/ws/b/.vscode/sftp.json',
      '/ws/c/.vscode/sftp.json',
    ]);
  });

  // Windows hands the same file back with either case or either separator
  // depending on who asked; loading it twice would put two services on one
  // baseDir and lose one of them.
  it('de-duplicates win32 paths that differ only in case or separator', () => {
    expect(
      selectDiscovered(
        'C:\\ws',
        'C:\\ws\\.vscode\\sftp.json',
        ['C:\\WS\\.vscode\\sftp.json', 'C:/ws/.vscode/sftp.json'],
        4,
        win32
      )
    ).toEqual(['C:\\ws\\.vscode\\sftp.json']);
  });
});
