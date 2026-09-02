# Nested sftp.json Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find every `.vscode/sftp.json` under each workspace folder (to a bounded depth), load each with its own folder as the config root, keep them in sync as they are saved/created/deleted, and group the SFTP Explorer and Databases trees by workspace folder.

**Architecture:** All path arithmetic lives in one vscode-free module (`src/modules/configPaths.ts`) so jest can test it; the vscode-touching search wrapper (`src/modules/configDiscovery.ts`) is a thin shell over it. `FileService` gains a `workspaceFolder` field so a service can be grouped and disposed by folder while its existing `workspace` field becomes the **config root** that `context`, `privateKeyPath` and `ignoreFile` resolve against. The two tree providers share one pure grouping function (`src/modules/explorerGrouping.ts`).

**Tech Stack:** TypeScript 3.9.10, webpack + ts-loader, jest 29, `@types/vscode` 1.67, `@types/node` v9, fs-extra, VS Code Tree API.

**Spec:** `docs/superpowers/specs/2026-09-03-nested-sftp-json-design.md` — read it alongside this plan.

## Global Constraints

- `npm test` (jest) does NOT typecheck. `npm run compile` (webpack + ts-loader) DOES and is the gate; every task ends with `npm run compile` green and `npm test` green except the ONE known baseline failure `transfer algorithm › sync › sync --update with time offset` in `src/fileHandlers/transfer/__tests__/transfer-test.ts`.
- TypeScript 3.9.10; extension tsconfig `lib: ["es6"]`, `target` es6, `strictNullChecks`, `noUnusedLocals`: no `Array.prototype.includes`, `Object.entries`, `Object.fromEntries`, `flat`, `matchAll`, `replaceAll`, `padStart`. `@types/vscode` 1.67 (engine `^1.67.0`); `@types/node` v9. `path.posix`/`path.win32` exist for cross-platform tests.
- There is no `vscode` mock for jest: modules under test must not import `vscode`. Pure helpers go in vscode-free files (`src/modules/configDiscovery.ts` may import `vscode` for `findFiles`; put its pure helpers in `src/modules/configPaths.ts` and test those; likewise `src/modules/explorerGrouping.ts` must be vscode-free — pass plain `{ name, fsPath }` folder records, not `vscode.WorkspaceFolder`).
- Commit messages end with these two trailer lines exactly:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf`
- Version bumps to 1.33.0 (current 1.32.0). CHANGELOG entry `## 1.33.0 - 2026-09-03` at the top. README subsection placed in the config documentation near "Multiple Context".
- Never run anything against a real remote host. Comments minimal, truthful, WHY-focused, in the style of `src/modules/pdf/viewer.ts`.
- Keep diffs minimal; do not refactor beyond the spec.

## `noUnusedLocals` warning

Every task that removes the last use of an import MUST remove the import in the same edit, or `npm run compile` fails. This bites in Task 3 (`tryLoadConfigs` in `extension.ts`) and Task 4 (`path` and `CONGIF_FILENAME` in `src/helper/file.ts`). The steps below already do it — do not skip those lines.

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/modules/configPaths.ts` (new) | All pure path arithmetic and decisions: config root, depth, discovery filtering, watcher target. No vscode. | 1, 2, 4 |
| `src/modules/configDiscovery.ts` (new) | Thin vscode shell: `findFiles` + the depth setting. | 2 |
| `src/modules/serviceManager/trie.ts` | Gains an exact-key `get`, for collision detection. | 3 |
| `src/modules/serviceManager/index.ts` | `createFileService(config, configRoot, workspaceFolder)` + collision log. | 3 |
| `src/core/fileService.ts` | `workspaceFolder` field. | 3 |
| `src/extension.ts` | Discovery-driven setup, folder-scoped disposal. | 3 |
| `src/helper/file.ts` | `isConfigFile` delegates to `isConfigPath`. | 4 |
| `src/modules/fileActivityMonitor.ts` | Config-root-scoped save/create/delete handlers. | 4 |
| `src/modules/explorerGrouping.ts` (new) | Pure grouping. No vscode. | 5 |
| `src/modules/workspaceFolders.ts` (new) | The one place that turns `vscode.WorkspaceFolder[]` into grouping records. | 5 |
| `src/modules/remoteExplorer/*` | Group node kind. | 5 |
| `src/modules/dbExplorer/treeDataProvider.ts` | `'workspace'` node kind. | 5 |
| `src/commands/commandConfigHere.ts` (new) | `sftp.config.here`. | 6 |
| `package.json`, `README.md`, `CHANGELOG.md` | Setting, command, menus, activation, docs, version. | 2, 6, 7 |

---

### Task 1: Pure config path helpers

**Files:**
- Create: `src/modules/configPaths.ts`
- Test: `src/modules/__tests__/configPaths-test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface PathApi { sep: string; normalize(p: string): string; join(...paths: string[]): string; relative(from: string, to: string): string; dirname(p: string): string; basename(p: string, ext?: string): string; isAbsolute(p: string): boolean; }`
  - `const CONFIG_EXCLUDE_GLOB: string`
  - `const CONFIG_SEARCH_MAX_RESULTS: number`
  - `const DEFAULT_CONFIG_SEARCH_DEPTH: number`
  - `const MAX_CONFIG_SEARCH_DEPTH: number`
  - `function configRootOf(configPath: string, p?: PathApi): string`
  - `function configDepth(folderPath: string, configPath: string, p?: PathApi): number`
  - `function isConfigPath(fsPath: string, p?: PathApi): boolean`
  - `function clampDepth(value: any): number`
  - `function relativeConfigRootLabel(folderPath: string, configRoot: string, p?: PathApi): string`

**Notes (spec readings resolved here):**
- The spec says `configDepth` returns -1 "when not under the folder". A cross-drive Windows path makes `relative()` return an absolute path (`path.win32.relative('C:\\a','D:\\a\\b') === 'D:\\a\\b'`), so the "not under" test is *both* a leading `..` segment and `isAbsolute`.
- "handle case as the platform does": `path.win32.relative` already compares case-insensitively and `path.posix.relative` does not, so delegating to `p.relative` IS the platform behaviour. No extra lowercasing.
- `relativeConfigRootLabel` returns a `/`-separated label because it is display text in a tree row, and it returns the absolute config root when the root is not under the folder, so a stale row still says something true rather than `../../..`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/__tests__/configPaths-test.ts`:

```ts
import * as path from 'path';
import {
  CONFIG_EXCLUDE_GLOB,
  CONFIG_SEARCH_MAX_RESULTS,
  clampDepth,
  configDepth,
  configRootOf,
  isConfigPath,
  relativeConfigRootLabel,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/__tests__/configPaths-test.ts`
Expected: FAIL — `Cannot find module '../configPaths' from 'src/modules/__tests__/configPaths-test.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/configPaths.ts`:

```ts
import * as path from 'path';

// The subset of node's `path` these helpers use. Declared rather than reusing
// `typeof path` because `path.posix` and `path.win32` are typed as narrower
// namespaces in @types/node v9 and are not assignable to it -- and the tests
// need to run BOTH platforms' rules on a single host.
export interface PathApi {
  sep: string;
  normalize(p: string): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  isAbsolute(p: string): boolean;
}

export const CONFIG_EXCLUDE_GLOB =
  '**/{node_modules,vendor,.git,dist,build,.cache,bower_components}/**';
export const CONFIG_SEARCH_MAX_RESULTS = 500;
export const DEFAULT_CONFIG_SEARCH_DEPTH = 4;
export const MAX_CONFIG_SEARCH_DEPTH = 10;

const CONFIG_FILENAME = 'sftp.json';
const VENDOR_FOLDER = '.vscode';

/**
 * The folder that owns a config file: the parent of its `.vscode` directory.
 * This is what `context`, `privateKeyPath` and `ignoreFile` resolve against.
 */
export function configRootOf(configPath: string, p: PathApi = path): string {
  return p.dirname(p.dirname(configPath));
}

export function isConfigPath(fsPath: string, p: PathApi = path): boolean {
  return (
    p.basename(fsPath) === CONFIG_FILENAME &&
    p.basename(p.dirname(fsPath)) === VENDOR_FOLDER
  );
}

/**
 * Directories between `folderPath` and the config file's root; -1 when the
 * config file is not under the folder at all.
 *
 * `relative` does the platform's own comparison -- win32 matches
 * case-insensitively, posix does not -- so there is no lowercasing here. A
 * result that escapes the folder shows up either as a leading `..` segment or,
 * across Windows drives, as an absolute path.
 */
export function configDepth(
  folderPath: string,
  configPath: string,
  p: PathApi = path
): number {
  const relative = p.relative(folderPath, configRootOf(configPath, p));
  if (relative === '') {
    return 0;
  }
  if (p.isAbsolute(relative) || relative === '..' || relative.indexOf('..' + p.sep) === 0) {
    return -1;
  }
  return relative.split(p.sep).filter(segment => segment.length > 0).length;
}

/** 0..10, defaulting to 4 for anything that is not a number. */
export function clampDepth(value: any): number {
  if (typeof value !== 'number' || isNaN(value)) {
    return DEFAULT_CONFIG_SEARCH_DEPTH;
  }
  return Math.min(MAX_CONFIG_SEARCH_DEPTH, Math.max(0, Math.floor(value)));
}

/**
 * Display text for a config root: '' for the workspace folder itself, and
 * forward slashes on every platform because this ends up in a tree row next
 * to a remote path. A root that is not under the folder keeps its absolute
 * path rather than becoming a wall of `../`.
 */
export function relativeConfigRootLabel(
  folderPath: string,
  configRoot: string,
  p: PathApi = path
): string {
  const relative = p.relative(folderPath, configRoot);
  if (relative === '') {
    return '';
  }
  if (p.isAbsolute(relative) || relative === '..' || relative.indexOf('..' + p.sep) === 0) {
    return configRoot;
  }
  return relative.split(p.sep).join('/');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/__tests__/configPaths-test.ts`
Expected: PASS — all describes green.

- [ ] **Step 5: Run the gate**

Run: `npm run compile`
Expected: webpack finishes with no TypeScript errors.

Run: `npm test`
Expected: green except the known baseline failure `transfer algorithm › sync › sync --update with time offset`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/configPaths.ts src/modules/__tests__/configPaths-test.ts
git commit -m "$(cat <<'EOF'
feat: pure helpers for locating a config file's root and depth

configPaths.ts holds every path decision nested sftp.json discovery needs,
with no vscode import, so jest can run both platforms' rules on one host:
path.relative already compares case-insensitively on win32 and not on posix,
so depth and the "outside the folder" answer come from it rather than from a
string prefix check that would call /ws-two a child of /ws.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 2: Discovery — filtering, the vscode search, and the setting

**Files:**
- Modify: `src/modules/configPaths.ts` (append `selectDiscovered`)
- Create: `src/modules/configDiscovery.ts`
- Modify: `package.json` — `contributes.configuration.properties`, after `sftp.showSizeInRemoteExplorer`
- Test: `src/modules/__tests__/configPaths-test.ts` (append a `selectDiscovered` describe)

**Interfaces:**
- Consumes (Task 1): `PathApi`, `CONFIG_EXCLUDE_GLOB`, `CONFIG_SEARCH_MAX_RESULTS`, `clampDepth`, `configDepth`, `isConfigPath`.
- Produces:
  - `function selectDiscovered(folderPath: string, rootPath: string | null, found: string[], depth: number, p?: PathApi): string[]` (in `configPaths.ts`)
  - `interface DiscoveryFolder { name: string; fsPath: string; }` (in `configDiscovery.ts`)
  - `function discoverConfigFiles(folder: DiscoveryFolder, depth: number): Promise<string[]>`
  - `function readDepthSetting(): number`
  - Setting `sftp.configSearchDepth`

**Notes:** the vscode half of this task has no jest coverage by design (no `vscode` mock exists); `npm run compile` is its gate and `selectDiscovered` carries the logic that can actually be wrong.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/__tests__/configPaths-test.ts`:

```ts
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
```

Add `selectDiscovered` to the import list at the top of the test file:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/__tests__/configPaths-test.ts -t selectDiscovered`
Expected: FAIL — `selectDiscovered is not a function`.

- [ ] **Step 3: Implement `selectDiscovered`**

Append to `src/modules/configPaths.ts`:

```ts
// Two spellings of one file must collapse to one entry, or the second load
// overwrites the first service on the same baseDir. Windows is where this
// actually happens: the same path comes back with either case and either
// separator depending on who produced it.
function pathKey(fsPath: string, p: PathApi): string {
  const normalized = p.normalize(fsPath);
  return p.sep === '\\' ? normalized.toLowerCase() : normalized;
}

/**
 * The config files to load for one workspace folder: the root-level file (found
 * without any search, so it is independent of the depth setting) plus every
 * search result inside the folder and within `depth`, de-duplicated and sorted.
 */
export function selectDiscovered(
  folderPath: string,
  rootPath: string | null,
  found: string[],
  depth: number,
  p: PathApi = path
): string[] {
  const selected: string[] = [];
  const seen: { [key: string]: boolean } = {};

  const take = (configPath: string) => {
    const key = pathKey(configPath, p);
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    selected.push(configPath);
  };

  if (rootPath) {
    take(rootPath);
  }

  found.forEach(configPath => {
    if (!isConfigPath(configPath, p)) {
      return;
    }
    const fileDepth = configDepth(folderPath, configPath, p);
    if (fileDepth < 0 || fileDepth > depth) {
      return;
    }
    take(configPath);
  });

  return selected.sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/__tests__/configPaths-test.ts`
Expected: PASS.

- [ ] **Step 5: Write `configDiscovery.ts`**

Create `src/modules/configDiscovery.ts`:

```ts
import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import logger from '../logger';
import { CONFIG_PATH } from '../constants';
import {
  CONFIG_EXCLUDE_GLOB,
  CONFIG_SEARCH_MAX_RESULTS,
  clampDepth,
  selectDiscovered,
} from './configPaths';

// A workspace folder reduced to what discovery needs, so callers can pass a
// plain record and the pure helpers stay testable.
export interface DiscoveryFolder {
  name: string;
  fsPath: string;
}

export function readDepthSetting(): number {
  return clampDepth(vscode.workspace.getConfiguration('sftp').get('configSearchDepth'));
}

/**
 * Every `.vscode/sftp.json` to load for one workspace folder.
 *
 * The root-level file is checked directly rather than through the search, so
 * the behaviour every existing workspace relies on cannot be taken away by a
 * search setting, an exclude glob, or a search that fails outright.
 */
export async function discoverConfigFiles(
  folder: DiscoveryFolder,
  depth: number
): Promise<string[]> {
  const rootConfigPath = path.join(folder.fsPath, CONFIG_PATH);
  let rootPath: string | null = null;
  try {
    rootPath = (await fse.pathExists(rootConfigPath)) ? rootConfigPath : null;
  } catch (error) {
    rootPath = null;
  }

  let found: string[] = [];
  if (depth > 0) {
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder.fsPath, '**/.vscode/sftp.json'),
        CONFIG_EXCLUDE_GLOB,
        CONFIG_SEARCH_MAX_RESULTS
      );
      found = uris.map(uri => uri.fsPath);
    } catch (error) {
      logger.warn(`config search failed in ${folder.fsPath}: ${error && error.message}`);
      found = [];
    }
  }

  const files = selectDiscovered(folder.fsPath, rootPath, found, depth);
  logger.info(`${files.length} sftp.json in workspace folder "${folder.name}"`);
  return files;
}
```

- [ ] **Step 6: Add the setting to `package.json`**

In `contributes.configuration.properties`, insert this entry immediately after the `"sftp.showSizeInRemoteExplorer"` block (add the comma after that block's closing brace):

```json
        "sftp.configSearchDepth": {
          "type": "integer",
          "default": 4,
          "minimum": 0,
          "maximum": 10,
          "description": "How many folder levels below each workspace folder to search for .vscode/sftp.json. 0 searches only the workspace folder itself. Reload the window after changing."
        },
```

- [ ] **Step 7: Run the gate**

Run: `npm run compile`
Expected: no TypeScript errors. (This is the only check the vscode half of `configDiscovery.ts` gets.)

Run: `npm test`
Expected: green except the known baseline failure.

- [ ] **Step 8: Commit**

```bash
git add src/modules/configPaths.ts src/modules/configDiscovery.ts src/modules/__tests__/configPaths-test.ts package.json
git commit -m "$(cat <<'EOF'
feat: find every .vscode/sftp.json under a workspace folder

discoverConfigFiles checks the root-level file directly and only then runs
vscode's findFiles, so today's behaviour survives an exclude glob, a depth of
0, or a search that throws. selectDiscovered does the filtering and the
de-duplication in configPaths.ts, where jest can reach it -- including the
win32 case where one file arrives twice under two spellings.

sftp.configSearchDepth (0..10, default 4) is read once per setup; the
description says to reload the window, like the other sftp.* settings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 3: Load every discovered config with its own root

**Files:**
- Modify: `src/modules/serviceManager/trie.ts` — add `get` next to `findPrefix`
- Modify: `src/core/fileService.ts` — fields at lines 394-396 and the constructor at line 398
- Modify: `src/modules/serviceManager/index.ts` — `createFileService` (line 64)
- Modify: `src/modules/fileActivityMonitor.ts` — the `createFileService` call in `handleConfigSave` (line 34) only, so compile stays green; Task 4 rewrites the handler
- Modify: `src/extension.ts` — imports, `setupWorkspaceFolder`, `setup`, `onDidChangeWorkspaceFolders`
- Modify: `package.json` — `activationEvents`
- Test: `src/modules/serviceManager/__tests__/trie-test.ts` (new)

**Interfaces:**
- Consumes (Tasks 1-2): `configRootOf(configPath)`, `discoverConfigFiles(folder, depth)`, `readDepthSetting()`.
- Produces:
  - `Trie<T>.get(path: string | string[]): T | null` — exact key, unlike `findPrefix`
  - `FileService` field `workspaceFolder: string`
  - `new FileService(baseDir: string, workspace: string, workspaceFolder: string, config: FileServiceConfig)`
  - `createFileService(config: any, configRoot: string, workspaceFolder: string): FileService`

**Notes:** `FileService.workspace` keeps its name and now carries the **config root**. That is deliberate: `getCompleteConfig(config, this.workspace)` and `getBasePath(context, workspace)` already resolve everything relative to it, so a nested config resolves exactly like a root-level one with no change to either. The new `workspaceFolder` field is used only for grouping and for disposal when a folder is removed.

- [ ] **Step 1: Write the failing test**

Create `src/modules/serviceManager/__tests__/trie-test.ts`:

```ts
import Trie from '../trie';

function trie() {
  return new Trie<string>({}, { delimiter: '/' });
}

describe('Trie.get', () => {
  it('returns the value stored at exactly that key', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.get('/a/b')).toBe('service');
  });

  // The difference that matters for collision detection: findPrefix answers
  // "who owns this path", which for an unclaimed child is the ANCESTOR. Asking
  // "is this exact folder already claimed" needs get.
  it('returns null for a descendant of a stored key, where findPrefix returns the ancestor', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.findPrefix('/a/b/c')).toBe('service');
    expect(t.get('/a/b/c')).toBeNull();
  });

  it('returns null for a key that was never added', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.get('/x/y')).toBeNull();
  });

  it('returns null for an interior node with no value', () => {
    const t = trie();
    t.add('/a/b/c', 'service');
    expect(t.get('/a/b')).toBeNull();
  });

  it('returns null after the key is removed', () => {
    const t = trie();
    t.add('/a/b', 'service');
    t.remove('/a/b');
    expect(t.get('/a/b')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serviceManager/__tests__/trie-test.ts`
Expected: FAIL — `t.get is not a function`.

- [ ] **Step 3: Add `Trie.get`**

In `src/modules/serviceManager/trie.ts`, insert this method immediately after `findPrefix` (which ends at line 136):

```ts
  // Exact key, not longest prefix: "is this folder already claimed by a
  // service" has a different answer from "which service owns this path".
  get(path: string | string[]): T | null {
    const tokens = Array.isArray(path) ? path : this.splitPath(path);
    const node = this.findNode(this.root, tokens);
    if (!node) {
      return null;
    }
    return node.getValue();
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serviceManager/__tests__/trie-test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add `workspaceFolder` to `FileService`**

In `src/core/fileService.ts`, replace the field block and constructor (lines 394-407) with:

```ts
  id: number;
  baseDir: string;
  workspace: string;
  // The VS Code workspace folder that CONTAINS this service's config file.
  // `workspace` above is the config root -- the folder holding .vscode -- and
  // the two differ for a nested sftp.json. Only grouping and folder-removal
  // disposal use this; every path resolution still goes through `workspace`.
  workspaceFolder: string;

  constructor(
    baseDir: string,
    workspace: string,
    workspaceFolder: string,
    config: FileServiceConfig
  ) {
    this.id = ++id;
    this.workspace = workspace;
    this.workspaceFolder = workspaceFolder;
    this.baseDir = baseDir;
    this._watcherConfig = config.watcher;
    this._config = config;
    if (config.profiles) {
      this._profiles = Object.keys(config.profiles);
    }
  }
```

- [ ] **Step 6: Rewrite `createFileService`**

In `src/modules/serviceManager/index.ts`, add `CONFIG_PATH` to the imports:

```ts
import { CONFIG_PATH } from '../../constants';
```

Then replace `createFileService` (lines 64-105) in full:

```ts
export function createFileService(config: any, configRoot: string, workspaceFolder: string) {
  if (config.defaultProfile) {
    app.state.profile = config.defaultProfile;
  }

  const normalizedBasePath = getBasePath(config.context, configRoot);
  // Two profiles on one folder still collide and the later one still wins, as
  // it always has. With nested configs the two can now come from different
  // files, so say which files rather than leaving the user to find them.
  const claimed = serviceManager.get(normalizedBasePath);
  if (claimed) {
    logger.warn(
      `Two sftp.json profiles claim ${normalizedBasePath}: ` +
        `${path.join(claimed.workspace, CONFIG_PATH)} and ` +
        `${path.join(configRoot, CONFIG_PATH)}. The later one wins; ` +
        'give them different "context" values.'
    );
  }

  const service = new FileService(normalizedBasePath, configRoot, workspaceFolder, config);

  logger.info(`config at ${normalizedBasePath}`, maskConfig(config));

  serviceManager.add(normalizedBasePath, service);
  service.name = config.name;
  service.setConfigValidator(validateConfig);
  service.setWatcherService(watcherService);
  service.beforeTransfer(task => {
    const { localFsPath, transferType } = task;
    const filename = path.basename(localFsPath);
    const filepath = simplifyPath(localFsPath);
    app.transferAggregator.onTaskStart(task, {
      direction: transferType,
      filename,
      filepath,
    });
    task.onProgress = transferred =>
      app.transferAggregator.onTaskProgress(task, transferred);
  });
  service.afterTransfer((error, task) => {
    const { localFsPath, transferType } = task;
    if (task.isCancelled()) {
      logger.info(`cancel transfer ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, { cancelled: true });
    } else if (error) {
      reportError(error, `when ${transferType} ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, { error: true });
    } else {
      logger.info(`${transferType} ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, {});
    }
  });

  return service;
}
```

- [ ] **Step 7: Keep `fileActivityMonitor` compiling**

In `src/modules/fileActivityMonitor.ts`, `handleConfigSave` currently calls `createFileService(config, workspacePath)`. Change ONLY that line (line 34) to:

```ts
    configs.forEach(config => createFileService(config, workspacePath, workspacePath));
```

This preserves today's (workspace-folder-scoped) behaviour verbatim. Task 4 replaces the whole handler.

- [ ] **Step 8: Rewrite `extension.ts` setup**

In `src/extension.ts`, replace the config import (line 11):

```ts
import { readConfigsFromFile } from './modules/config';
import { configRootOf } from './modules/configPaths';
import { discoverConfigFiles, readDepthSetting } from './modules/configDiscovery';
```

(`tryLoadConfigs` has no other use in this file — leaving the import would fail `noUnusedLocals`.)

Replace `setupWorkspaceFolder` (lines 26-31) in full:

```ts
async function setupWorkspaceFolder(folder: vscode.WorkspaceFolder) {
  const folderPath = folder.uri.fsPath;
  const configFiles = await discoverConfigFiles(
    { name: folder.name, fsPath: folderPath },
    readDepthSetting()
  );

  // One try/catch per file: a nested project with a broken sftp.json must cost
  // the user that project, not every other project in the folder.
  for (const configFile of configFiles) {
    try {
      const configs = await readConfigsFromFile(configFile);
      const configRoot = configRootOf(configFile);
      configs.forEach(config => createFileService(config, configRoot, folderPath));
    } catch (error) {
      reportError(error, `load config ${configFile}`);
    }
  }
}
```

Replace `setup` (lines 33-47) in full:

```ts
async function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  // Load every workspace folder's config first, isolating failures so one bad
  // folder doesn't prevent the others from initializing.
  await Promise.all(
    workspaceFolders.map(folder =>
      setupWorkspaceFolder(folder).catch(error =>
        reportError(error, `setup workspace folder ${folder.uri.fsPath}`)
      )
    )
  );

  // Start watching files only after all services exist. Otherwise a config save
  // firing mid-setup would run handleConfigSave against incomplete state.
  fileActivityMonitor.init();
}
```

Replace the `onDidChangeWorkspaceFolders` registration (lines 125-143) in full:

```ts
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      await Promise.all(
        event.added.map(folder =>
          setupWorkspaceFolder(folder).catch(error =>
            reportError(error, `setup workspace folder ${folder.uri.fsPath}`)
          )
        )
      );
      event.removed.forEach(folder => {
        // workspaceFolder, not workspace: a nested service's `workspace` is its
        // own config root, so keying on it would leave every nested service of
        // a removed folder behind in the Trie.
        findAllFileService(
          service => service.workspaceFolder === folder.uri.fsPath
        ).forEach(disposeFileService);
      });
      if (app.remoteExplorer) {
        app.remoteExplorer.refresh();
      }
      if (app.dbExplorer) {
        app.dbExplorer.refresh();
      }
    })
  );
```

`deactivate` is unchanged.

- [ ] **Step 9: Widen the activation event**

In `package.json`, in `activationEvents`, replace:

```json
    "workspaceContains:.vscode/sftp.json"
```

with:

```json
    "workspaceContains:**/.vscode/sftp.json"
```

- [ ] **Step 10: Run the gate**

Run: `npm run compile`
Expected: no TypeScript errors. (If `new FileService(` errors anywhere, a call site was missed — `src/modules/serviceManager/index.ts:70` is the only one in the repo.)

Run: `npm test`
Expected: green except the known baseline failure.

- [ ] **Step 11: Commit**

```bash
git add src/modules/serviceManager/trie.ts src/modules/serviceManager/index.ts src/modules/serviceManager/__tests__/trie-test.ts src/core/fileService.ts src/extension.ts src/modules/fileActivityMonitor.ts package.json
git commit -m "$(cat <<'EOF'
feat: load a nested sftp.json against its own folder

createFileService now takes the config root and the containing workspace
folder separately. The root keeps the name `workspace` on FileService because
getBasePath and getCompleteConfig already resolve context, privateKeyPath and
ignoreFile against it -- so a nested config resolves exactly like a root-level
one, with no change to either. The new workspaceFolder field exists only so a
removed folder can dispose its nested services, which keying on `workspace`
would have left in the Trie.

Trie.get answers "is this exact folder already claimed", which findPrefix
cannot: for an unclaimed child it returns the ancestor. The collision it finds
is logged with both config file paths.

Activation widens to workspaceContains:**/.vscode/sftp.json.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 4: Watch each config file against its own root

**Files:**
- Modify: `src/modules/configPaths.ts` (append `configEventTarget` and its types)
- Modify: `src/helper/file.ts` — `isConfigFile` (line 11) and the imports
- Modify: `src/modules/fileActivityMonitor.ts` — imports, `handleConfigSave`, `handleConfigDelete`, `destory`
- Test: `src/modules/__tests__/configPaths-test.ts` (append a `configEventTarget` describe)

**Interfaces:**
- Consumes (Tasks 1-3): `configDepth`, `configRootOf`, `isConfigPath`, `PathApi`, `readDepthSetting()`, `createFileService(config, configRoot, workspaceFolder)`, `FileService.workspace`.
- Produces:
  - `interface ConfigEventFolder { fsPath: string; }`
  - `type ConfigEventTarget = { kind: 'load'; configRoot: string; workspaceFolder: string } | { kind: 'tooDeep'; depth: number; configRoot: string } | { kind: 'outside' }`
  - `function configEventTarget(configPath: string, folders: ConfigEventFolder[], depth: number, p?: PathApi): ConfigEventTarget`

**Notes:** when workspace folders are nested inside each other, the target is the **innermost** containing folder — the one with the smallest depth — which is what `vscode.workspace.getWorkspaceFolder` does. Tightening `isConfigFile` is required, not cosmetic: with config roots now derived as "two levels up", a stray `foo/sftp.json` saved in the editor would have reloaded the services of an unrelated folder.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/__tests__/configPaths-test.ts`:

```ts
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
```

Add `configEventTarget` to the test file's import list from `'../configPaths'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/__tests__/configPaths-test.ts -t configEventTarget`
Expected: FAIL — `configEventTarget is not a function`.

- [ ] **Step 3: Implement `configEventTarget`**

Append to `src/modules/configPaths.ts`:

```ts
export interface ConfigEventFolder {
  fsPath: string;
}

export type ConfigEventTarget =
  | { kind: 'load'; configRoot: string; workspaceFolder: string }
  | { kind: 'tooDeep'; depth: number; configRoot: string }
  | { kind: 'outside' };

/**
 * What a save, create or delete of `configPath` should do.
 *
 * The innermost containing folder wins, matching
 * vscode.workspace.getWorkspaceFolder -- and the depth the user is told about
 * has to be measured from the same folder the loader would have used.
 */
export function configEventTarget(
  configPath: string,
  folders: ConfigEventFolder[],
  depth: number,
  p: PathApi = path
): ConfigEventTarget {
  let owner: ConfigEventFolder | null = null;
  let ownerDepth = -1;

  // A plain loop, not forEach: TypeScript does not un-narrow a `let` that a
  // closure assigns to, so `owner` would be `never` at the return below.
  for (const folder of folders) {
    const fileDepth = configDepth(folder.fsPath, configPath, p);
    if (fileDepth < 0) {
      continue;
    }
    if (owner === null || fileDepth < ownerDepth) {
      owner = folder;
      ownerDepth = fileDepth;
    }
  }

  if (owner === null) {
    return { kind: 'outside' };
  }

  const configRoot = configRootOf(configPath, p);
  if (ownerDepth > depth) {
    return { kind: 'tooDeep', depth: ownerDepth, configRoot };
  }

  return { kind: 'load', configRoot, workspaceFolder: owner.fsPath };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/__tests__/configPaths-test.ts`
Expected: PASS — every describe, including the earlier ones.

- [ ] **Step 5: Tighten `isConfigFile`**

Replace the top of `src/helper/file.ts` (lines 1-14) with:

```ts
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { upath } from '../core';
import { isConfigPath } from '../modules/configPaths';

export function isValidFile(uri: vscode.Uri) {
  return uri.scheme === 'file';
}

// A config file is sftp.json INSIDE a .vscode directory, at any depth -- not
// any file named sftp.json. The config handlers now derive a config root two
// levels up from the file, so a stray sftp.json elsewhere in the tree would
// reload an unrelated folder's services from it.
export function isConfigFile(uri: vscode.Uri) {
  return isConfigPath(uri.fsPath);
}
```

(`path` and `CONGIF_FILENAME` lose their last use here; leaving either import would fail `noUnusedLocals`. `upath` is still used by `fileDepth` below.)

- [ ] **Step 6: Rewrite the config handlers**

In `src/modules/fileActivityMonitor.ts`, replace the imports (lines 1-15) with:

```ts
import * as vscode from 'vscode';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  onDidOpenTextDocument,
  onDidSaveTextDocument,
  showConfirmMessage,
  showInformationMessage,
} from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { configEventTarget, ConfigEventFolder } from './configPaths';
import { readDepthSetting } from './configDiscovery';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';
```

Replace the module state and both handlers (lines 17-56) with:

```ts
let workspaceWatcher: vscode.Disposable;
let configWatcher: vscode.FileSystemWatcher;
// One notice per file per session, as the spec asks: a too-deep file is saved
// as often as any other, and a modal-adjacent toast on every keystroke's save
// would be worse than the file not loading.
const tooDeepNotified = new Set<string>();

function workspaceFolderPaths(): ConfigEventFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  return folders ? folders.map(folder => ({ fsPath: folder.uri.fsPath })) : [];
}

function refreshExplorers() {
  if (app.remoteExplorer) {
    app.remoteExplorer.refresh();
  }
  if (app.dbExplorer) {
    app.dbExplorer.refresh();
  }
}

function noticeTooDeep(configPath: string, actual: number, allowed: number) {
  if (tooDeepNotified.has(configPath)) {
    return;
  }
  tooDeepNotified.add(configPath);
  showInformationMessage(
    `sftp.json at ${vscode.workspace.asRelativePath(configPath)} is ${actual} levels deep, ` +
      `beyond sftp.configSearchDepth (${allowed}). Raise the setting to load it.`
  );
}

async function handleConfigSave(uri: vscode.Uri) {
  const allowed = readDepthSetting();
  const target = configEventTarget(uri.fsPath, workspaceFolderPaths(), allowed);
  if (target.kind === 'outside') {
    return;
  }
  if (target.kind === 'tooDeep') {
    noticeTooDeep(uri.fsPath, target.depth, allowed);
    return;
  }

  // Only this file's own services. Keying on the workspace folder, as this used
  // to, replaced every sibling project's servers on any nested save.
  findAllFileService(service => service.workspace === target.configRoot).forEach(
    disposeFileService
  );

  try {
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config =>
      createFileService(config, target.configRoot, target.workspaceFolder)
    );
  } catch (error) {
    reportError(error, `load config ${uri.fsPath}`);
  } finally {
    refreshExplorers();
  }
}

function handleConfigDelete(uri: vscode.Uri) {
  const allowed = readDepthSetting();
  const target = configEventTarget(uri.fsPath, workspaceFolderPaths(), allowed);
  if (target.kind === 'outside') {
    return;
  }
  if (target.kind === 'tooDeep') {
    // Nothing was loaded from it, so there is nothing to dispose -- but a
    // deleted file should not keep its notice, in case it comes back.
    tooDeepNotified.delete(uri.fsPath);
    return;
  }

  tooDeepNotified.delete(uri.fsPath);
  findAllFileService(service => service.workspace === target.configRoot).forEach(
    disposeFileService
  );
  refreshExplorers();
}
```

Replace `destory` (lines 158-165) in full:

```ts
function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (configWatcher) {
    configWatcher.dispose();
  }
  tooDeepNotified.clear();
}
```

`watchWorkspace`, `init`, `handleFileSave` and `downloadOnOpen` are unchanged: `init` already registers `handleConfigSave` for text saves (through `onDidSaveSftpConfig`, gated by the now-stricter `isConfigFile`) and for `configWatcher.onDidCreate`, and `handleConfigDelete` for `onDidDelete`, with the glob already `**/.vscode/sftp.json`.

- [ ] **Step 7: Run the gate**

Run: `npm run compile`
Expected: no TypeScript errors.

Run: `npm test`
Expected: green except the known baseline failure.

- [ ] **Step 8: Commit**

```bash
git add src/modules/configPaths.ts src/modules/__tests__/configPaths-test.ts src/helper/file.ts src/modules/fileActivityMonitor.ts
git commit -m "$(cat <<'EOF'
fix: a nested sftp.json save reloads only its own site

The config handlers resolved a saved file to its WORKSPACE FOLDER and disposed
every service of that folder, so saving one nested sftp.json replaced fourteen
sibling projects' servers and resolved their paths against the wrong folder.
They now key on the file's own config root, through a pure configEventTarget
that also reports a file deeper than sftp.configSearchDepth (told once per
file per session) or outside every folder.

isConfigFile now means sftp.json inside a .vscode directory, not any file so
named: with config roots derived two levels up, a stray sftp.json saved in the
editor would have reloaded an unrelated folder's services.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 5: Group both trees by workspace folder

**Files:**
- Create: `src/modules/explorerGrouping.ts`
- Create: `src/modules/workspaceFolders.ts`
- Modify: `src/modules/remoteExplorer/treeDataProvider.ts` — types, `refresh`, `getTreeItem`, `getChildren`, `getParent`, `showItem`, `_getRoots`
- Modify: `src/modules/remoteExplorer/index.ts` — export `ExplorerChild`, `ExplorerGroup`, `isExplorerGroup`
- Modify: `src/modules/remoteExplorer/explorer.ts` — `refresh`, `_refreshSelection`
- Modify: `src/commands/shared.ts` — lines 128, 130, 152 cast to `ExplorerChild`
- Modify: `src/modules/dbExplorer/treeDataProvider.ts` — `DbNodeKind`, `DbNode`, `getTreeItem`, `getChildren`, `_connections`, new `_topLevel`
- Modify: `package.json` — 7 `menus.view/item/context` when-clauses (see Step 9)
- Test: `src/modules/__tests__/explorerGrouping-test.ts` (new)

**Interfaces:**
- Consumes (Tasks 1-4): `relativeConfigRootLabel(folderPath, configRoot)`, `FileService.workspaceFolder`, `FileService.workspace`.
- Produces:
  - `interface GroupingFolder { name: string; fsPath: string; }`
  - `interface FolderGroup<T, F extends GroupingFolder> { folder: F; items: T[]; }`
  - `function groupByWorkspaceFolder<T, F extends GroupingFolder>(items: T[], folderOf: (item: T) => string, folders: F[]): FolderGroup<T, F>[]`
  - `function shouldGroup(folders: GroupingFolder[]): boolean`
  - `interface WorkspaceFolderRecord extends GroupingFolder { workspaceFolder: vscode.WorkspaceFolder; }`
  - `function workspaceFolderRecords(): WorkspaceFolderRecord[]`
  - `interface ExplorerGroup { kind: 'group'; workspaceFolder: vscode.WorkspaceFolder; isDirectory: true; }`
  - `function isExplorerGroup(item: ExplorerItem): item is ExplorerGroup`
  - `ExplorerChild` becomes exported

**Notes (spec readings resolved here):**
- The spec says a root's description is the config-root label "joined with the existing size description when that setting is on". `sizeDescription` returns `undefined` for a root by construction (`opts.isRoot` short-circuits), so there is nothing to join: a root shows the config-root label and non-roots keep exactly today's size text. The spec's "description text for a root" test is `relativeConfigRootLabel` from Task 1.
- `groupByWorkspaceFolder` is generic over the folder type so callers can carry the `vscode.WorkspaceFolder` along in a record the module never has to know about. The module itself stays vscode-free.
- A service whose `workspaceFolder` matches no current folder is dropped while grouping is active. It cannot survive a folder removal (Task 3 disposes those), so this is a transient state, not a hiding place.
- The group objects are cached in `_groups`, cleared with `_roots`: VS Code's tree needs `getParent` to return the *same* object it was handed from `getChildren`, or reveal and targeted refresh miss.
- **Spec gap found while reading `package.json`.** The spec says the Databases tree's "existing menus are unaffected (their when-clauses name other kinds)" — true there, every dbExplorer clause is a positive `viewItem == …`. It is NOT true for the SFTP Explorer: seven of its `view/item/context` entries match *negatively* (`viewItem != root`, `viewItem != file`), so a group node would offer Delete Remote, Create Folder, Create File, Go To Folder, Get Size, Create Archive and Reveal in Explorer — all of which need a resource the group has not got. The spec's own rule ("No commands on a group") is what settles this: Step 9 excludes `workspaceGroup` from those seven.

- [ ] **Step 1: Write the failing test**

Create `src/modules/__tests__/explorerGrouping-test.ts`:

```ts
import { groupByWorkspaceFolder, shouldGroup } from '../explorerGrouping';

interface Service {
  name: string;
  folder: string;
}

const hostkicker = { name: 'hostkicker', fsPath: '/ws/hostkicker' };
const devServer = { name: 'DevServer', fsPath: '/ws/DevServer' };
const empty = { name: 'empty', fsPath: '/ws/empty' };

function service(name: string, folder: string): Service {
  return { name, folder };
}

describe('shouldGroup', () => {
  it('is false with no folders', () => {
    expect(shouldGroup([])).toBe(false);
  });

  it('is false with one folder, so a single-folder workspace looks as it always has', () => {
    expect(shouldGroup([hostkicker])).toBe(false);
  });

  it('is true with two folders', () => {
    expect(shouldGroup([hostkicker, devServer])).toBe(true);
  });
});

describe('groupByWorkspaceFolder', () => {
  const folderOf = (s: Service) => s.folder;

  it('puts each item under its own folder', () => {
    const items = [
      service('a', '/ws/hostkicker'),
      service('b', '/ws/DevServer'),
      service('c', '/ws/DevServer'),
    ];
    expect(groupByWorkspaceFolder(items, folderOf, [hostkicker, devServer])).toEqual([
      { folder: hostkicker, items: [items[0]] },
      { folder: devServer, items: [items[1], items[2]] },
    ]);
  });

  it('omits a folder with no items', () => {
    const items = [service('a', '/ws/hostkicker')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker, empty, devServer]);
    expect(groups.map(group => group.folder.name)).toEqual(['hostkicker']);
  });

  it('keeps workspace-folder order, not item order', () => {
    const items = [service('a', '/ws/DevServer'), service('b', '/ws/hostkicker')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker, devServer]);
    expect(groups.map(group => group.folder.name)).toEqual(['hostkicker', 'DevServer']);
  });

  // The callers sort by remoteExplorer.order then name BEFORE grouping, so the
  // order inside a group has to survive untouched.
  it('keeps the incoming order inside a group', () => {
    const items = [
      service('z', '/ws/DevServer'),
      service('a', '/ws/DevServer'),
      service('m', '/ws/DevServer'),
    ];
    const groups = groupByWorkspaceFolder(items, folderOf, [devServer]);
    expect(groups[0].items.map(item => item.name)).toEqual(['z', 'a', 'm']);
  });

  it('drops an item whose folder is not in the list', () => {
    const items = [service('a', '/ws/hostkicker'), service('gone', '/ws/removed')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker]);
    expect(groups).toEqual([{ folder: hostkicker, items: [items[0]] }]);
  });

  it('returns no groups for no items', () => {
    expect(groupByWorkspaceFolder([] as Service[], folderOf, [hostkicker])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/__tests__/explorerGrouping-test.ts`
Expected: FAIL — `Cannot find module '../explorerGrouping'`.

- [ ] **Step 3: Write the grouping module**

Create `src/modules/explorerGrouping.ts`:

```ts
// A workspace folder reduced to what grouping needs. Deliberately not
// vscode.WorkspaceFolder: this module has to stay importable by jest, which
// has no vscode module to give it. Callers carry the real folder along in a
// record that extends this one.
export interface GroupingFolder {
  name: string;
  fsPath: string;
}

export interface FolderGroup<T, F extends GroupingFolder> {
  folder: F;
  items: T[];
}

/** Grouping starts at two folders; one folder shows a flat tree, as it always has. */
export function shouldGroup(folders: GroupingFolder[]): boolean {
  return folders.length >= 2;
}

/**
 * One group per workspace folder that owns at least one item, in workspace
 * folder order, each group keeping the incoming order of its items (the trees
 * sort before they group).
 */
export function groupByWorkspaceFolder<T, F extends GroupingFolder>(
  items: T[],
  folderOf: (item: T) => string,
  folders: F[]
): FolderGroup<T, F>[] {
  const groups: FolderGroup<T, F>[] = [];
  folders.forEach(folder => {
    const owned = items.filter(item => folderOf(item) === folder.fsPath);
    if (owned.length > 0) {
      groups.push({ folder, items: owned });
    }
  });
  return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/__tests__/explorerGrouping-test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Write the workspace folder records helper**

Create `src/modules/workspaceFolders.ts`:

```ts
import * as vscode from 'vscode';
import { GroupingFolder } from './explorerGrouping';

// The one place a vscode.WorkspaceFolder becomes a grouping record. The folder
// itself rides along so a tree can hand it back out as a node without either
// tree provider learning how grouping works.
export interface WorkspaceFolderRecord extends GroupingFolder {
  workspaceFolder: vscode.WorkspaceFolder;
}

export function workspaceFolderRecords(): WorkspaceFolderRecord[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return [];
  }
  return folders.map(folder => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
    workspaceFolder: folder,
  }));
}
```

- [ ] **Step 6: Add the group node to the Remote Explorer**

In `src/modules/remoteExplorer/treeDataProvider.ts`, replace the imports (lines 16-18) with:

```ts
import { getAllFileService } from '../serviceManager';
import { getExtensionSetting } from '../ext';
import { relativeConfigRootLabel } from '../configPaths';
import { groupByWorkspaceFolder, shouldGroup } from '../explorerGrouping';
import { workspaceFolderRecords } from '../workspaceFolders';
import { sizeDescription } from './sizeDescription';
```

Replace the item types (lines 43-57) with:

```ts
export interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
  size?: number;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
  };
}

// A workspace folder heading. It has no remote resource of its own, which is
// why every place that reaches for `.resource` has to narrow it away first.
export interface ExplorerGroup {
  kind: 'group';
  workspaceFolder: vscode.WorkspaceFolder;
  isDirectory: true;
}

export type ExplorerItem = ExplorerGroup | ExplorerRoot | ExplorerChild;

export function isExplorerGroup(item: ExplorerItem): item is ExplorerGroup {
  return (item as ExplorerGroup).kind === 'group';
}

// @types/vscode marks the ThemeIcon(id) constructor public from 1.45; the cast
// mirrors dbExplorer's so both trees build icons the same way.
function themeIcon(id: string): vscode.ThemeIcon {
  return new (vscode.ThemeIcon as any)(id);
}

function configRootDescription(root: ExplorerRoot): string | undefined {
  const fileService = root.explorerContext.fileService;
  // `workspace` is the config root; `workspaceFolder` is the folder it sits in.
  const label = relativeConfigRootLabel(fileService.workspaceFolder, fileService.workspace);
  return label === '' ? undefined : label;
}
```

Then narrow `dirFirstSort` (lines 59-65), which sorts a remote directory listing and so never sees a group — but reads `.resource`, which the widened union no longer has:

```ts
function dirFirstSort(fileA: ExplorerChild, fileB: ExplorerChild) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}
```

Add the group cache field next to `_roots` (line 69) — the class field block becomes:

```ts
  private _roots: ExplorerRoot[] | null;
  private _rootsMap: Map<Id, ExplorerRoot> | null;
  private _groups: Map<string, ExplorerGroup> | null;
  private _map: Map<vscode.Uri['query'], ExplorerItem>;
```

Replace `refresh` (lines 80-109) in full:

```ts
  async refresh(item?: ExplorerItem): Promise<any> {
    // refresh root
    if (!item) {
      // clear cache
      this._roots = null;
      this._rootsMap = null;
      this._groups = null;

      // undefined means "the whole tree changed" to VS Code -- the caches
      // were just cleared, so that is exactly the message. The emitter is typed
      // to allow it rather than cast around it.
      this._onDidChangeFolder.fire(undefined);
      return;
    }

    // A group owns no resource; firing it is enough to have VS Code re-ask for
    // its children.
    if (isExplorerGroup(item)) {
      this._onDidChangeFolder.fire(item);
      return;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children.forEach(child => {
        if (!isExplorerGroup(child) && !child.isDirectory) {
          this._onDidChangeFile.fire(makePreivewUrl(child.resource.uri));
        }
      });
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(makePreivewUrl(item.resource.uri));
    }
  }
```

Replace `getTreeItem` (lines 111-139) in full:

```ts
  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    if (isExplorerGroup(item)) {
      return {
        label: item.workspaceFolder.name,
        iconPath: themeIcon('root-folder'),
        contextValue: 'workspaceGroup',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      };
    }

    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel;
    if (isRoot) {
      customLabel = (item as ExplorerRoot).explorerContext.fileService.name;
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }
    return {
      label: customLabel,
      resourceUri: item.resource.uri,
      // A root says WHERE its config lives -- empty for a root-level one.
      // sizeDescription has always returned undefined for a root, so there is
      // nothing of it to keep here.
      description: isRoot
        ? configRootDescription(item as ExplorerRoot)
        : sizeDescription(
            { isDirectory: item.isDirectory, isRoot, size: (item as ExplorerChild).size },
            getExtensionSetting().showSizeInRemoteExplorer
          ),
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: isRoot ? 'root' : item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }
```

Replace `getChildren` (lines 141-190) in full:

```ts
  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getTopLevel();
    }

    if (isExplorerGroup(item)) {
      const folderPath = item.workspaceFolder.uri.fsPath;
      return this._getRoots().filter(
        root => root.explorerContext.fileService.workspaceFolder === folderPath
      );
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resource.uri}.`);
    }
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const fileEntries = await remotefs.list(item.resource.fsPath);

    const filesExcludeList: string[] =
      config.remoteExplorer && config.remoteExplorer.filesExclude
        ? config.remoteExplorer.filesExclude.concat(DEFAULT_FILES_EXCLUDE)
        : DEFAULT_FILES_EXCLUDE;

    const ignore = new Ignore(filesExcludeList);
    function filterFile(file: FileEntry) {
      const relativePath = upath.relative(config.remotePath, file.fspath);
      return !ignore.ignores(relativePath);
    }

    // Annotated, so the cached-item branch is checked against ExplorerChild
    // rather than widening the array to ExplorerItem and pushing a group into
    // dirFirstSort's parameter type. Nothing a remote listing produces is a
    // group.
    const children: ExplorerChild[] = fileEntries.filter(filterFile).map(file => {
      const isDirectory = file.type === FileType.Directory;
      const newResource = UResource.updateResource(item.resource, {
        remotePath: file.fspath,
      });
      const mapItem = this._map.get(newResource.uri.query);
      if (mapItem) {
        // keep the size current across refreshes (the cache persists items)
        (mapItem as ExplorerChild).size = file.size;
        return mapItem as ExplorerChild;
      } else {
        const newItem = {
          resource: UResource.updateResource(item.resource, {
            remotePath: file.fspath,
          }),
          isDirectory,
          size: file.size,
        };
        this._map.set(newItem.resource.uri.query, newItem);
        return newItem;
      }
    });

    return children.sort(dirFirstSort);
  }
```

Note `item.resource` after the group guard: TypeScript narrows `item` to `ExplorerRoot | ExplorerChild` there, so the rest of the body reads as before.

Replace `getParent` (lines 192-219) in full:

```ts
  async getParent(item: ExplorerItem): Promise<ExplorerItem | undefined> {
    if (isExplorerGroup(item)) {
      return undefined;
    }

    if ((item as ExplorerRoot).explorerContext !== undefined) {
      const records = workspaceFolderRecords();
      if (!shouldGroup(records)) {
        return undefined;
      }
      const folderPath = (item as ExplorerRoot).explorerContext.fileService.workspaceFolder;
      const owner = records.filter(record => record.fsPath === folderPath)[0];
      return owner ? this._groupFor(owner.workspaceFolder) : undefined;
    }

    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${resourceUri}.`);
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }
```

Replace `showItem` (lines 256-269) in full:

```ts
  showItem(item: ExplorerItem): void {
    if (isExplorerGroup(item) || item.isDirectory) {
      return;
    }

    // `vscode.open`, not showTextDocument. showTextDocument goes straight to
    // the TEXT editor and never consults the custom-editor associations, so
    // a remote PDF opened this way rendered as binary garbage and a remote
    // README bypassed the Markdown viewer. `vscode.open` resolves the editor
    // the same way a click in the file explorer does -- custom editors
    // included -- and falls through to the text editor for everything else,
    // which is exactly what showTextDocument did.
    vscode.commands.executeCommand('vscode.open', makePreivewUrl(item.resource.uri));
  }
```

Add these two private methods immediately before `_getRoots` (line 271), and leave `_getRoots` itself unchanged:

```ts
  private _getTopLevel(): ExplorerItem[] {
    const roots = this._getRoots();
    const records = workspaceFolderRecords();
    if (!shouldGroup(records)) {
      return roots;
    }

    return groupByWorkspaceFolder(
      roots,
      root => root.explorerContext.fileService.workspaceFolder,
      records
    ).map(group => this._groupFor(group.folder.workspaceFolder));
  }

  // Cached because VS Code identifies tree nodes by object identity: getParent
  // has to hand back the same group object getChildren produced, or reveal and
  // targeted refresh miss it.
  private _groupFor(folder: vscode.WorkspaceFolder): ExplorerGroup {
    if (!this._groups) {
      this._groups = new Map();
    }
    const key = folder.uri.fsPath;
    const existing = this._groups.get(key);
    if (existing) {
      return existing;
    }
    const group: ExplorerGroup = {
      kind: 'group',
      workspaceFolder: folder,
      isDirectory: true,
    };
    this._groups.set(key, group);
    return group;
  }
```

- [ ] **Step 7: Update the Remote Explorer's exports and callers**

Replace `src/modules/remoteExplorer/index.ts` in full:

```ts
export { default } from './explorer';
export {
  ExplorerItem,
  ExplorerRoot,
  ExplorerChild,
  ExplorerGroup,
  isExplorerGroup,
} from './treeDataProvider';
```

In `src/modules/remoteExplorer/explorer.ts`, change the import (line 11) to:

```ts
import RemoteTreeDataProvider, { ExplorerItem, isExplorerGroup } from './treeDataProvider';
```

Replace `refresh` (lines 41-66) in full:

```ts
  refresh(item?: ExplorerItem) {
    if (item && !isExplorerGroup(item) && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        if (uri.toString(true) == "file:///${command:sftp.sync.remoteToLocal}") {
          throw '';
        } else {
          throw new Error(`Config Not Found. (${uri.toString(true)})`);
        }
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId: fileService.id,
      });
    }

    this._treeDataProvider.refresh(item);
  }
```

Replace `_refreshSelection` (lines 76-82) in full:

```ts
  private _refreshSelection() {
    const selection = this._explorerView.selection;
    // A group stands for the whole folder, and there is nothing under it this
    // view could refresh piecemeal -- so refresh the tree, as the spec asks.
    if (!selection.length || selection.some(isExplorerGroup)) {
      this.refresh();
      return;
    }
    selection.forEach(item => this.refresh(item));
  }
```

In `src/commands/shared.ts`, change the import (line 5) to:

```ts
import { ExplorerChild } from '../modules/remoteExplorer';
```

and the three casts (lines 128, 130, 152) from `(item as ExplorerItem)` / `(items[0] as ExplorerItem)` to `(item as ExplorerChild)` / `(items[0] as ExplorerChild)`. `ExplorerGroup` has no `resource`, so the union no longer has that property and the old casts stop compiling; a group never reaches these paths anyway (its `contextValue` is `workspaceGroup`, which no menu names).

- [ ] **Step 8: Add the workspace node to the Databases tree**

In `src/modules/dbExplorer/treeDataProvider.ts`, replace the imports (lines 1-6) with:

```ts
import * as vscode from 'vscode';
import { getAllFileService } from '../serviceManager';
import { getDbClient } from '../../core/dbConnectionManager';
import { DatabaseConfig } from '../../core/dbClient';
import { COMMAND_DB_OPEN_TABLE } from '../../constants';
import { groupByWorkspaceFolder, shouldGroup } from '../explorerGrouping';
import { workspaceFolderRecords } from '../workspaceFolders';
import logger from '../../logger';
```

Replace the node types (lines 8-19) with:

```ts
export type DbNodeKind = 'workspace' | 'connection' | 'database' | 'table' | 'column';

export interface DbNode {
  kind: DbNodeKind;
  label: string;
  description?: string;
  // set on 'workspace' and 'connection': the containing workspace folder's path
  workspaceFolder?: string;
  // carried down the tree so any node can reach its connection/database
  fileService?: any;
  config?: any;
  dbConfig?: DatabaseConfig;
  table?: string;
}
```

Replace `getTreeItem` (lines 39-63) in full:

```ts
  getTreeItem(node: DbNode): vscode.TreeItem {
    let collapsible: vscode.TreeItemCollapsibleState;
    if (node.kind === 'column') {
      collapsible = vscode.TreeItemCollapsibleState.None;
    } else if (node.kind === 'workspace') {
      collapsible = vscode.TreeItemCollapsibleState.Expanded;
    } else {
      collapsible = vscode.TreeItemCollapsibleState.Collapsed;
    }
    const item = new vscode.TreeItem(node.label, collapsible);
    item.description = node.description;
    item.contextValue = node.kind;
    switch (node.kind) {
      case 'workspace':
        item.iconPath = themeIcon('root-folder');
        break;
      case 'connection':
        item.iconPath = themeIcon('server-environment');
        break;
      case 'database':
        item.iconPath = themeIcon('database');
        break;
      case 'table':
        item.iconPath = themeIcon('list-flat');
        item.command = { command: COMMAND_DB_OPEN_TABLE, title: 'Open Table', arguments: [node] };
        break;
      case 'column':
        item.iconPath = themeIcon('symbol-field');
        break;
    }
    return item;
  }
```

Replace `getChildren` (lines 65-79) in full:

```ts
  async getChildren(node?: DbNode): Promise<DbNode[]> {
    if (!node) {
      return this._topLevel();
    }
    switch (node.kind) {
      case 'workspace':
        return this._connections().filter(
          connection => connection.workspaceFolder === node.workspaceFolder
        );
      case 'connection':
        return this._databases(node);
      case 'database':
        return this._tables(node);
      case 'table':
        return this._columns(node);
      default:
        return [];
    }
  }

  private _topLevel(): DbNode[] {
    const connections = this._connections();
    const records = workspaceFolderRecords();
    if (!shouldGroup(records)) {
      return connections;
    }

    return groupByWorkspaceFolder(
      connections,
      connection => connection.workspaceFolder || '',
      records
    ).map(group => ({
      kind: 'workspace' as DbNodeKind,
      label: group.folder.name,
      workspaceFolder: group.folder.fsPath,
    }));
  }
```

Replace `_connections` (lines 81-102) in full:

```ts
  private _connections(): DbNode[] {
    const nodes: DbNode[] = [];
    getAllFileService().forEach(fileService => {
      let config;
      try {
        config = fileService.getConfig();
      } catch (e) {
        return;
      }
      if (dbConfigsOf(config).length === 0) {
        return;
      }
      nodes.push({
        kind: 'connection',
        label: config.name || config.host,
        description: config.host,
        workspaceFolder: fileService.workspaceFolder,
        fileService,
        config,
      });
    });
    return nodes;
  }
```

Every existing dbExplorer `view/item/context` clause names `connection`, `database` or `table` positively, so the `workspace` node picks up none of them — no package.json change is needed for the Databases tree.

- [ ] **Step 9: Keep the SFTP Explorer's menus off the group node**

Unlike the Databases tree, seven SFTP Explorer entries in `menus.view/item/context` match negatively and would otherwise appear on a group. In `package.json`, add `&& viewItem != workspaceGroup` to exactly these seven `when` clauses — command, group and the rest of the clause unchanged:

| command | group | new `when` |
| --- | --- | --- |
| `sftp.revealInExplorer` | `2_files` | `view == remoteExplorer && viewItem != root && viewItem != workspaceGroup` |
| `sftp.delete.remote` | `7_modification` | `view == remoteExplorer && viewItem != root && viewItem != workspaceGroup` |
| `sftp.create.folder` | `7_modification` | `view == remoteExplorer && viewItem != file && viewItem != workspaceGroup` |
| `sftp.goto.folder` | `7_modification` | `view == remoteExplorer && viewItem != file && viewItem != workspaceGroup` |
| `sftp.getSize` | `5_info` | `view == remoteExplorer && viewItem != file && viewItem != workspaceGroup` |
| `sftp.createArchive` | `5_info` | `view == remoteExplorer && viewItem != file && viewItem != workspaceGroup` |
| `sftp.create.file` | `7_modification` | `view == remoteExplorer && viewItem != file && viewItem != workspaceGroup` |

Leave every other entry alone: `sftp.openConnectInTerminal` and `sftp.manageServer` are `viewItem == root`, the three upload/download file entries also require `viewItem == file`, and both editInLocal/viewContent are `viewItem == file` — none of them can match a group.

Verify no negative clause was missed:

```bash
node -e "
const pkg = require('./package.json');
const bad = pkg.contributes.menus['view/item/context'].filter(entry => {
  const when = entry.when || '';
  return when.indexOf('remoteExplorer') !== -1 &&
    when.indexOf('!=') !== -1 &&
    when.indexOf('viewItem == file') === -1 &&
    when.indexOf('viewItem != workspaceGroup') === -1;
});
console.log(bad.length === 0 ? 'no menu can match a group' : bad);
"
```
Expected: `no menu can match a group`.

- [ ] **Step 10: Run the gate**

Run: `npm run compile`
Expected: no TypeScript errors. Any `Property 'resource' does not exist on type 'ExplorerItem'` means a `.resource` access that still needs an `isExplorerGroup` guard or an `ExplorerChild` cast.

Run: `npm test`
Expected: green except the known baseline failure.

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json parses')"`
Expected: `package.json parses`.

- [ ] **Step 11: Commit**

```bash
git add src/modules/explorerGrouping.ts src/modules/workspaceFolders.ts src/modules/__tests__/explorerGrouping-test.ts src/modules/remoteExplorer src/modules/dbExplorer/treeDataProvider.ts src/commands/shared.ts package.json
git commit -m "$(cat <<'EOF'
feat: group the SFTP and Databases trees by workspace folder

With two or more workspace folders each tree grows one heading per folder that
owns a server, in folder order, folders with none omitted; a single-folder
workspace is untouched. Both trees share one pure groupByWorkspaceFolder, which
stays vscode-free by taking plain {name, fsPath} records and handing the real
folder back through a record type it never inspects.

Group nodes are cached: VS Code identifies tree nodes by object identity, so
getParent has to return the same object getChildren produced. A group carries
no resource, which is why ExplorerItem consumers now narrow it away, and why
the seven Explorer menu entries that match on `viewItem !=` now exclude it --
Delete Remote and Create Folder on a folder heading have nothing to act on. A
root also gained a description saying where its config lives, empty for a
root-level one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 6: SFTP: Create Config Here

**Files:**
- Create: `src/commands/commandConfigHere.ts`
- Modify: `src/constants.ts` — after `COMMAND_CONFIG` (line 17)
- Modify: `package.json` — `activationEvents`, `contributes.commands`, `menus.explorer/context`
- Test: `src/modules/__tests__/configPaths-test.ts` (append the depth arithmetic the warning uses)

**Interfaces:**
- Consumes (Tasks 1-2): `configDepth(folderPath, configPath)`, `readDepthSetting()`, and `CONFIG_PATH` from `src/constants.ts`, `newConfig(basePath)` from `src/modules/config.ts`.
- Produces: `COMMAND_CONFIG_HERE = 'sftp.config.here'`; the command module's default export (auto-registered by `initCommands` because the filename matches `/command.*\.ts$/` in `src/commands`, giving it the display name "Config Here").

**Notes:** the palette fallback is an open-folder dialog rather than a workspace-folder quick pick, because the whole point of the command is a folder *inside* a workspace folder — a quick pick of workspace folders would only ever reproduce `sftp.config`. The warning fires and the file is still created, exactly as the spec says.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/__tests__/configPaths-test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/__tests__/configPaths-test.ts -t "about to get a config"`
Expected: PASS immediately if Task 1 is in place — this test pins existing behaviour the command depends on. If it FAILS, `configDepth` is wrong and Task 1 must be fixed before continuing.

- [ ] **Step 3: Add the command id**

In `src/constants.ts`, after line 17 (`export const COMMAND_CONFIG = 'sftp.config';`) add:

```ts
export const COMMAND_CONFIG_HERE = 'sftp.config.here';
```

- [ ] **Step 4: Write the command**

Create `src/commands/commandConfigHere.ts`:

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_CONFIG_HERE, CONFIG_PATH } from '../constants';
import { newConfig } from '../modules/config';
import { showOpenDialog, showWarningMessage } from '../host';
import { configDepth } from '../modules/configPaths';
import { readDepthSetting } from '../modules/configDiscovery';
import { checkCommand } from './abstract/createCommand';

// The palette has no folder to work with. An open-folder dialog, not a pick
// from the workspace folders: the point of this command is a folder INSIDE a
// workspace folder, and a workspace-folder pick is what `sftp.config` already
// does.
async function pickFolder(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  const resources = await showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: folders && folders.length > 0 ? folders[0].uri : undefined,
    openLabel: 'Create Config Here',
  });

  return resources && resources.length > 0 ? resources[0] : undefined;
}

export default checkCommand({
  id: COMMAND_CONFIG_HERE,

  async handleCommand(uri?: vscode.Uri) {
    const folderUri = uri instanceof vscode.Uri ? uri : await pickFolder();
    if (!folderUri) {
      return;
    }

    const folderPath = folderUri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
    if (workspaceFolder) {
      const allowed = readDepthSetting();
      const depth = configDepth(
        workspaceFolder.uri.fsPath,
        path.join(folderPath, CONFIG_PATH)
      );
      // Warn, then create anyway: the file is what the user asked for, and a
      // setting they can raise is a better answer than a refusal.
      if (depth > allowed) {
        await showWarningMessage(
          `This folder is ${depth} levels deep; sftp.configSearchDepth is ${allowed}, ` +
            'so the file will not be loaded until you raise the setting.'
        );
      }
    }

    return newConfig(folderPath);
  },
});
```

- [ ] **Step 5: Wire it into `package.json`**

In `activationEvents`, after `"onCommand:sftp.config",` add:

```json
    "onCommand:sftp.config.here",
```

In `contributes.commands`, immediately after the `sftp.config` entry, add:

```json
      {
        "command": "sftp.config.here",
        "title": "Create Config Here",
        "category": "SFTP"
      },
```

In `menus.explorer/context`, add as the last entry of the array:

```json
        {
          "command": "sftp.config.here",
          "group": "sftp.config@1",
          "when": "explorerResourceIsFolder"
        }
```

(Remember the comma after the preceding `sftp.csv.openAsText` entry.)

- [ ] **Step 6: Run the gate**

Run: `npx jest src/modules/__tests__/configPaths-test.ts`
Expected: PASS.

Run: `npm run compile`
Expected: no TypeScript errors.

Run: `npm test`
Expected: green except the known baseline failure.

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json parses')"`
Expected: `package.json parses` — catches a missing or doubled comma from the three JSON edits.

- [ ] **Step 7: Commit**

```bash
git add src/commands/commandConfigHere.ts src/constants.ts package.json src/modules/__tests__/configPaths-test.ts
git commit -m "$(cat <<'EOF'
feat: SFTP: Create Config Here on any folder

Right-click a folder in the Explorer to create (or open) its
.vscode/sftp.json, so a nested project gets its own config without hand-making
the directory. From the palette it asks for the folder, since the whole point
is a folder inside a workspace folder and picking a workspace folder is what
sftp.config already does.

A folder deeper than sftp.configSearchDepth gets a warning naming both numbers
and the file is still created: the setting is one the user can raise, which is
a better answer than a refusal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

---

### Task 7: Docs and release

**Files:**
- Modify: `README.md` — the TOC list around line 540 and a new subsection after "Multiple Context" (which ends just before `### Connection Hopping`)
- Modify: `CHANGELOG.md` — new entry at the top, above `## 1.32.0 - 2026-09-03`
- Modify: `package.json` — `"version": "1.32.0"` → `"1.33.0"` (line 5)

**Interfaces:**
- Consumes (Tasks 1-6): the `sftp.configSearchDepth` setting, the `SFTP: Create Config Here` command, the grouped trees.
- Produces: nothing code depends on.

- [ ] **Step 1: Add the README TOC entry**

In `README.md`, in the table-of-contents list, after the line:

```markdown
    - [Multiple Context](#multiple-context)
```

add:

```markdown
    - [Nested sftp.json files](#nested-sftpjson-files)
```

- [ ] **Step 2: Add the README subsection**

In `README.md`, immediately after the "Multiple Context" subsection (after its `_Note：_ `name` is required in this mode.` line) and before `### Connection Hopping`, insert:

(This block is fenced with four backticks because the README text inside it contains its own three-backtick fence. Paste the content between the four-backtick lines, not the four-backtick lines themselves.)

````markdown
### Nested sftp.json files
A workspace folder can hold many projects, each with its own config. Every
`.vscode/sftp.json` under a workspace folder is loaded, not just the one at the
top:

```
DevServer/
  site-one/.vscode/sftp.json
  site-two/.vscode/sftp.json
hostkicker/.vscode/sftp.json
```

Each file's own folder — the one holding its `.vscode` directory — is its
**config root**. `context`, `privateKeyPath` and `ignoreFile` resolve against
that folder, so a nested config is written exactly like a top-level one.

`sftp.configSearchDepth` (default `4`) limits how many folder levels below each
workspace folder are searched. `0` searches only the workspace folder itself,
which is the behaviour before this feature. `node_modules`, `vendor`, `.git`,
`dist`, `build`, `.cache` and `bower_components` are never searched, and the
search stops at 500 files. **Reload the window after changing the setting.**
The workspace folder's own `.vscode/sftp.json` is always loaded, whatever the
setting says.

Saving, creating or deleting one nested `sftp.json` affects only that project's
servers; the others keep running.

With two or more workspace folders open, the SFTP Explorer and Databases views
show one heading per folder, with that folder's servers inside; a folder with
no server is not shown. With a single workspace folder the views look as they
always have. Each server row shows its config root's path inside the folder,
blank for a top-level config.

To create a config for a nested project, right-click its folder in the file
Explorer and choose **SFTP: Create Config Here**.
````

- [ ] **Step 3: Add the CHANGELOG entry**

At the very top of `CHANGELOG.md`, above `## 1.32.0 - 2026-09-03`, insert:

```markdown
## 1.33.0 - 2026-09-03
* New Feature : **Nested `sftp.json` files.** Every `.vscode/sftp.json` under a workspace folder
  is now loaded, not just the one at the top, so a folder holding many projects gets a server per
  project. Each file's own folder is its config root, so `context`, `privateKeyPath` and
  `ignoreFile` resolve exactly as they do for a top-level config. `sftp.configSearchDepth`
  (default 4, 0 = top level only) bounds the search, which skips `node_modules`, `vendor`,
  `.git`, `dist`, `build`, `.cache` and `bower_components` and stops at 500 files; reload the
  window after changing it. The workspace folder's own config is always loaded whatever the
  setting says, and a file that fails to parse costs you that project only.
* New Feature : **Grouped Explorer and Databases views.** With two or more workspace folders open,
  both views show one heading per folder with that folder's servers inside, in workspace-folder
  order, omitting folders with no server. A single-folder workspace is unchanged. Each server row
  now says where its config lives inside the folder.
* New Feature : **SFTP: Create Config Here.** Right-click any folder in the file Explorer to
  create (or open) its `.vscode/sftp.json`. A folder deeper than `sftp.configSearchDepth` is
  created anyway, with a warning naming both numbers.
* Fix : **a nested `sftp.json` save no longer replaces its neighbours.** The config handlers
  resolved a saved file to its workspace folder and disposed every service of that folder, so
  saving one project's config took out every sibling project's servers and resolved their paths
  against the wrong folder. They now key on the saved file's own config root.
```

- [ ] **Step 4: Bump the version**

In `package.json`, change line 5 from `"version": "1.32.0",` to:

```json
  "version": "1.33.0",
```

- [ ] **Step 5: Run the full gate**

Run: `npm run compile`
Expected: no TypeScript errors.

Run: `npm test`
Expected: green except the known baseline failure `transfer algorithm › sync › sync --update with time offset`.

Run: `npx vsce package`
Expected: `vaibhav-sftp-plus-1.33.0.vsix` written, no packaging errors.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "$(cat <<'EOF'
docs: nested sftp.json discovery, and 1.33.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf
EOF
)"
```

- [ ] **Step 7: Hand the manual smoke test to the user**

Nothing here is automatable — it needs a real workspace and a real remote — so report it as **pending on the user**, verbatim, and do not claim the feature verified until they answer:

1. Open a workspace with `hostkicker` and `DevServer` as two workspace folders.
2. The SFTP tab shows two headings, one per folder.
3. `DevServer`'s 14 sites all appear under its heading.
4. Save one nested `sftp.json`; only that site reloads, the other 13 keep their connections.
5. Delete one nested `sftp.json`; only that site disappears.
6. Upload a file from inside a nested site; it lands on that site's server, not a sibling's.
7. Right-click a new folder → **SFTP: Create Config Here**; the file is created and opens.
8. Set `sftp.configSearchDepth` to `0`, reload: only top-level configs load.

---

## Self-review

**1. Spec coverage** — every section of `2026-09-03-nested-sftp-json-design.md` mapped to a task:

| Spec section | Task |
| --- | --- |
| Discovery — `discoverConfigFiles`, exclude glob, max results, depth filter, de-dup, sort | 2 |
| Discovery — pure helpers `configRootOf`, `configDepth`, `isConfigPath`, `readDepthSetting` clamping | 1 (`clampDepth`), 2 (`readDepthSetting`) |
| Discovery — per-file try/catch, log line per folder | 3 (per-file try/catch in `setupWorkspaceFolder`), 2 (log line) |
| Loading — `createFileService(config, configRoot, workspaceFolderPath)`, `FileService.workspaceFolder` | 3 |
| Loading — existing `getAllFileService` consumers keep working, sorting unchanged | 3 (`_getRoots` sort untouched), 5 (grouping preserves incoming order) |
| Loading — collision logged with both config file paths, later one wins | 3 |
| Loading — `defaultProfile` unchanged | 3 (the `defaultProfile` branch is carried verbatim) |
| Watching — handlers key on config root, dispose only that root's services, reload, refresh both explorers | 4 |
| Watching — too-deep info message, once per file per session | 4 |
| Watching — file outside every folder ignored | 4 (`{ kind: 'outside' }`) |
| Watching — folder removal disposes by `workspaceFolder`; folder addition runs discovery | 3 |
| Watching — depth setting takes effect on reload, documented | 7 (README + setting description from Task 2) |
| Activation — `workspaceContains:**/.vscode/sftp.json` | 3 |
| Trees — `ExplorerGroup`, grouped/flat roots, `getChildren(group)`, `getParent(root)`, `getTreeItem(group)` | 5 |
| Trees — root description = config root relative to folder | 5 (`configRootDescription`), 1 (`relativeConfigRootLabel` + tests) |
| Trees — `findRoot`, `_rootsMap`, `_map`, `readBytes`, `showItem` unchanged | 5 (`showItem` gains only a group guard; the rest untouched) |
| Trees — `groupByWorkspaceFolder` in `explorerGrouping.ts`, unit-tested, both trees use it | 5 |
| Trees — Databases `'workspace'` kind, `root-folder`, `contextValue = 'workspace'`, expanded, existing menus unaffected | 5 |
| Trees — "No commands on a group" (spec's `getTreeItem(group)` bullet) | 5, Step 9 — the spec assumed this needed no package.json change; seven SFTP Explorer menus match `viewItem !=` and did |
| Command `sftp.config.here` — title, category, `explorer/context`, folder Uri, `newConfig`, depth warning, `sftp.config` unchanged | 6 |
| Setting `sftp.configSearchDepth` — type, default, min, max, description | 2 |
| Error handling — per-file parse failure, discovery failure falls back to the root file, one notice per file | 3, 2, 4 |
| Testing — jest on the pure helpers, grouping, watcher decision, root description; `npm run compile` green | 1, 2, 4, 5 (+ gate in every task) |
| Testing — manual smoke | 7 |
| Docs — README subsection, CHANGELOG `## 1.33.0`, version 1.33.0 | 7 |
| Out of scope — grouping preference, collapse memory, per-folder depth, `sftp.config` picker, hot-reload of depth | not implemented anywhere; confirmed absent |

No unmapped spec bullets.

**2. Placeholder scan** — no "TBD", "TODO", "implement later", "add error handling", "similar to Task N", or test steps without test code. Every code step carries the code; every modified function is written out in full; every run step names the exact command and the expected result.

**3. Type and name consistency**

- `PathApi` is defined once (Task 1) and used as the optional last parameter of `configRootOf`, `configDepth`, `isConfigPath`, `relativeConfigRootLabel` (Task 1), `selectDiscovered` (Task 2) and `configEventTarget` (Task 4). Consistent name and position throughout.
- `createFileService(config, configRoot, workspaceFolder)` — the 3-arg form is defined in Task 3 and every call site uses it: `extension.ts` (Task 3), `fileActivityMonitor.ts` (Task 3 stopgap, Task 4 final).
- `new FileService(baseDir, workspace, workspaceFolder, config)` — defined and used only in `serviceManager/index.ts`; verified to be the repo's single call site.
- `FileService.workspace` = config root, `FileService.workspaceFolder` = containing folder. Used with that meaning in Task 3 (disposal), Task 4 (`service.workspace === target.configRoot`), Task 5 (`fileService.workspaceFolder` for grouping, both fields in `configRootDescription`).
- `shouldGroup` / `groupByWorkspaceFolder` / `GroupingFolder` / `WorkspaceFolderRecord` / `workspaceFolderRecords` — one spelling each, used identically by both tree providers.
- `isExplorerGroup` is exported from `treeDataProvider.ts` (Task 5) and imported by `explorer.ts` in the same task; `ExplorerChild` is newly exported and is what `shared.ts` casts to.
- `readDepthSetting()` lives in `configDiscovery.ts` (Task 2) and is imported by `extension.ts` (Task 3), `fileActivityMonitor.ts` (Task 4) and `commandConfigHere.ts` (Task 6) — always from `configDiscovery`, never re-declared.
- `COMMAND_CONFIG_HERE = 'sftp.config.here'` matches the `package.json` command id, the `explorer/context` entry and the activation event.
- Test files: `src/modules/__tests__/configPaths-test.ts` (Tasks 1, 2, 4, 6 — each appends a describe and, where needed, extends the single import list), `src/modules/serviceManager/__tests__/trie-test.ts` (Task 3), `src/modules/__tests__/explorerGrouping-test.ts` (Task 5).
