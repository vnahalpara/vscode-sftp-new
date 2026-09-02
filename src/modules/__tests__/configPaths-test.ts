import * as path from 'path';
import {
  CONFIG_EXCLUDED_DIRS,
  CONFIG_EXCLUDE_GLOB,
  CONFIG_SEARCH_MAX_RESULTS,
  clampDepth,
  configDepth,
  configEventTarget,
  configRootOf,
  isConfigPath,
  isExcludedConfigPath,
  pathKey,
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

  it('builds the glob from the excluded directory list', () => {
    expect(CONFIG_EXCLUDE_GLOB).toBe('**/{' + CONFIG_EXCLUDED_DIRS.join(',') + '}/**');
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

  it('drops a result inside an excluded directory', () => {
    expect(
      selectDiscovered(
        '/w',
        null,
        ['/w/vendor/x/.vscode/sftp.json', '/w/a/.vscode/sftp.json'],
        4,
        posix
      )
    ).toEqual(['/w/a/.vscode/sftp.json']);
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

describe('configEventTarget', () => {
  const folders = [{ fsPath: '/ws' }, { fsPath: '/other' }];

  it('loads a root-level config against its folder', () => {
    expect(configEventTarget('/ws/.vscode/sftp.json', folders, 4, posix)).toEqual({
      kind: 'load',
      configRoot: '/ws',
      workspaceFolder: '/ws',
    });
  });

  it('loads a nested config against its own config root', () => {
    expect(
      configEventTarget('/ws/DevServer/site/.vscode/sftp.json', folders, 4, posix)
    ).toEqual({
      kind: 'load',
      configRoot: '/ws/DevServer/site',
      workspaceFolder: '/ws',
    });
  });

  it('reports a config deeper than the setting, with its depth', () => {
    expect(
      configEventTarget('/ws/a/b/c/.vscode/sftp.json', folders, 2, posix)
    ).toEqual({ kind: 'tooDeep', depth: 3, configRoot: '/ws/a/b/c' });
  });

  it('loads a config exactly at the depth limit', () => {
    expect(configEventTarget('/ws/a/b/.vscode/sftp.json', folders, 2, posix)).toEqual({
      kind: 'load',
      configRoot: '/ws/a/b',
      workspaceFolder: '/ws',
    });
  });

  it('reports a config outside every workspace folder', () => {
    expect(configEventTarget('/elsewhere/.vscode/sftp.json', folders, 4, posix)).toEqual({
      kind: 'outside',
    });
  });

  it('reports outside when there are no workspace folders at all', () => {
    expect(configEventTarget('/ws/.vscode/sftp.json', [], 4, posix)).toEqual({
      kind: 'outside',
    });
  });

  // vscode.workspace.getWorkspaceFolder picks the innermost folder when folders
  // are nested, and the depth the user is told about has to be measured from
  // the same folder.
  it('picks the innermost workspace folder when folders are nested', () => {
    expect(
      configEventTarget(
        '/ws/inner/site/.vscode/sftp.json',
        [{ fsPath: '/ws' }, { fsPath: '/ws/inner' }],
        4,
        posix
      )
    ).toEqual({ kind: 'load', configRoot: '/ws/inner/site', workspaceFolder: '/ws/inner' });
  });

  it('works on win32 paths', () => {
    expect(
      configEventTarget('C:\\ws\\a\\.vscode\\sftp.json', [{ fsPath: 'C:\\ws' }], 4, win32)
    ).toEqual({ kind: 'load', configRoot: 'C:\\ws\\a', workspaceFolder: 'C:\\ws' });
  });
});

describe('isExcludedConfigPath', () => {
  it('is false for the workspace folder itself', () => {
    expect(isExcludedConfigPath('/ws', '/ws/.vscode/sftp.json', posix)).toBe(false);
  });

  it('is true for any excluded segment on the way down', () => {
    expect(
      isExcludedConfigPath('/ws', '/ws/a/node_modules/pkg/.vscode/sftp.json', posix)
    ).toBe(true);
  });

  it('needs an exact segment, not a prefix', () => {
    expect(isExcludedConfigPath('/ws', '/ws/dist-old/.vscode/sftp.json', posix)).toBe(false);
  });

  it('is false for a config outside the folder', () => {
    expect(isExcludedConfigPath('/ws', '/other/dist/.vscode/sftp.json', posix)).toBe(false);
  });
});

describe('configEventTarget exclusions', () => {
  const folders = [{ fsPath: '/ws' }];

  it('excludes a config directly inside node_modules', () => {
    expect(
      configEventTarget('/ws/node_modules/.vscode/sftp.json', folders, 4, posix)
    ).toEqual({ kind: 'excluded' });
  });

  it('excludes a config nested deeper inside node_modules', () => {
    expect(
      configEventTarget('/ws/node_modules/a/b/.vscode/sftp.json', folders, 4, posix)
    ).toEqual({ kind: 'excluded' });
  });

  // Excluded before too deep: the file is never loaded either way, and telling
  // the user to raise a depth setting that would not help is worse than silence.
  it('prefers excluded over tooDeep', () => {
    expect(
      configEventTarget('/ws/node_modules/a/b/.vscode/sftp.json', folders, 1, posix)
    ).toEqual({ kind: 'excluded' });
  });

  it('loads a folder merely named like an excluded one', () => {
    expect(configEventTarget('/ws/dist-old/.vscode/sftp.json', folders, 4, posix)).toEqual({
      kind: 'load',
      configRoot: '/ws/dist-old',
      workspaceFolder: '/ws',
    });
    expect(configEventTarget('/ws/my-vendor/.vscode/sftp.json', folders, 4, posix)).toEqual({
      kind: 'load',
      configRoot: '/ws/my-vendor',
      workspaceFolder: '/ws',
    });
  });

  // The win32 filesystem matches case-insensitively, so findFiles would have
  // skipped this folder whatever the user spelled it.
  it('matches an excluded directory case-insensitively on win32', () => {
    expect(
      configEventTarget('C:\\ws\\Node_Modules\\a\\.vscode\\sftp.json', [{ fsPath: 'C:\\ws' }], 4, win32)
    ).toEqual({ kind: 'excluded' });
  });

  it('keeps case-sensitive matching on posix', () => {
    expect(
      configEventTarget('/ws/Node_Modules/.vscode/sftp.json', folders, 4, posix)
    ).toEqual({ kind: 'load', configRoot: '/ws/Node_Modules', workspaceFolder: '/ws' });
  });
});

describe('pathKey', () => {
  it('is stable across win32 case and separator spellings', () => {
    expect(pathKey('C:\\WS\\Site', win32)).toBe(pathKey('C:/ws/site', win32));
  });

  it('does not fold case on posix', () => {
    expect(pathKey('/ws/Site', posix)).not.toBe(pathKey('/ws/site', posix));
  });
});

// What "Create Config Here" measures before it warns: the depth of the config
// file the command is ABOUT to create in the chosen folder.
describe('configDepth for a folder about to get a config', () => {
  function depthOfNewConfigIn(folderPath: string, target: string) {
    return configDepth(folderPath, posix.join(target, '.vscode', 'sftp.json'), posix);
  }

  it('is 0 for the workspace folder itself', () => {
    expect(depthOfNewConfigIn('/ws', '/ws')).toBe(0);
  });

  it('is 5 for a folder five levels down, which is past the default of 4', () => {
    expect(depthOfNewConfigIn('/ws', '/ws/a/b/c/d/e')).toBe(5);
  });

  it('is -1 for a folder outside the workspace folder', () => {
    expect(depthOfNewConfigIn('/ws', '/elsewhere/a')).toBe(-1);
  });
});
