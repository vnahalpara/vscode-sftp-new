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

// The directories a config search skips. The glob is derived from the list so
// the two can never drift: the event path checks the list, findFiles the glob.
export const CONFIG_EXCLUDED_DIRS: ReadonlyArray<string> = [
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '.cache',
  'bower_components',
];
export const CONFIG_EXCLUDE_GLOB = '**/{' + CONFIG_EXCLUDED_DIRS.join(',') + '}/**';
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

/**
 * Whether the config's root sits inside one of `CONFIG_EXCLUDED_DIRS`, i.e. a
 * directory the startup search skips. A root that IS the folder, or is not
 * under it at all, is never excluded.
 *
 * win32 compares case-insensitively because its filesystem does, so findFiles
 * would have skipped the folder however the user spelled it.
 */
export function isExcludedConfigPath(
  folderPath: string,
  configPath: string,
  p: PathApi = path
): boolean {
  const relative = p.relative(folderPath, configRootOf(configPath, p));
  if (relative === '') {
    return false;
  }
  if (p.isAbsolute(relative) || relative === '..' || relative.indexOf('..' + p.sep) === 0) {
    return false;
  }

  const fold = p.sep === '\\';
  return relative.split(p.sep).some(segment => {
    const name = fold ? segment.toLowerCase() : segment;
    return CONFIG_EXCLUDED_DIRS.indexOf(name) !== -1;
  });
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

// Two spellings of one file must collapse to one entry, or the second load
// overwrites the first service on the same baseDir. Windows is where this
// actually happens: the same path comes back with either case and either
// separator depending on who produced it. Exported because the event handlers
// compare config roots the same way.
export function pathKey(fsPath: string, p: PathApi = path): string {
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
    // Symmetry with the exclude glob: a search that returned one anyway (a
    // stale index, a caller passing its own list) must not sneak it in.
    if (isExcludedConfigPath(folderPath, configPath, p)) {
      return;
    }
    take(configPath);
  });

  // By code unit, not localeCompare: its answer depends on the host's ICU
  // data, and this order is what the tree shows.
  return selected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface ConfigEventFolder {
  fsPath: string;
}

export type ConfigEventTarget =
  | { kind: 'load'; configRoot: string; workspaceFolder: string }
  | { kind: 'tooDeep'; actual: number; configRoot: string }
  | { kind: 'excluded' }
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

  // Before the depth check: an excluded file is not loaded at any depth, so
  // telling the user to raise a setting that would not help is worse than
  // saying nothing.
  if (isExcludedConfigPath(owner.fsPath, configPath, p)) {
    return { kind: 'excluded' };
  }

  const configRoot = configRootOf(configPath, p);
  if (ownerDepth > depth) {
    return { kind: 'tooDeep', actual: ownerDepth, configRoot };
  }

  return { kind: 'load', configRoot, workspaceFolder: owner.fsPath };
}
