import * as fs from 'fs';
import * as path from 'path';

/**
 * Find an external program by name when PATH cannot be trusted.
 *
 * A VS Code launched from the Dock or Spotlight (rather than from a shell)
 * gives its extension host whatever PATH the OS hands a GUI app -- on macOS
 * since Tahoe that is just "/usr/bin:/bin:/usr/sbin:/sbin", with no shell
 * profile applied. Anything installed by Homebrew, MacPorts, `go install` or
 * pip is then invisible, and spawning it by bare name fails with ENOENT even
 * though the same command works in the user's terminal.
 *
 * So: search PATH first (it is still the user's own answer where it has one),
 * then the handful of places these tools actually get installed. Pure and
 * fully injected, so it is unit-testable without touching a real filesystem.
 */
export interface ResolveOptions {
  // The PATH environment variable, exactly as the process received it.
  pathEnv: string | undefined;
  platform: NodeJS.Platform;
  homeDir: string;
  // True when the path names a file that can be executed. Injected so tests
  // do not depend on what happens to be installed on the machine running them.
  exists(p: string): boolean;
}

export interface ResolvedBinary {
  // An absolute path once the search found one; otherwise the name unchanged,
  // so the caller's spawn still fails with the ENOENT its error path expects.
  path: string;
  // The directories actually visited, in order. Empty for an explicit path.
  tried: string[];
}

// The parts of `path` this module uses, so the target platform's rules can be
// picked at runtime. @types/node declares path.posix/path.win32 as namespaces
// with no shared type of their own, hence the hand-written shape.
interface PathRules {
  join(...parts: string[]): string;
  delimiter: string;
}

// Where a command-line tool installed outside the system prefix tends to live.
function fallbackDirs(platform: NodeJS.Platform, homeDir: string, p: PathRules): string[] {
  if (platform === 'win32') {
    // Windows has no equivalent convention, and its own PATH is not stripped
    // the way a macOS GUI launch strips ours.
    return [];
  }
  return [
    '/opt/homebrew/bin', // Homebrew, Apple silicon
    '/usr/local/bin', // Homebrew on Intel, and the usual hand-install prefix
    '/opt/local/bin', // MacPorts
    p.join(homeDir, 'go', 'bin'), // `go install`, which is how wireproxy ships
    p.join(homeDir, '.local', 'bin'), // pip/pipx and friends
    '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
  ];
}

export function resolveBinary(name: string, opts: ResolveOptions): ResolvedBinary {
  const { pathEnv, platform, homeDir, exists } = opts;
  // Join and split using the target platform's rules rather than the running
  // process's, so the search behaves the same under test as in production.
  const p: PathRules = platform === 'win32' ? path.win32 : path.posix;

  // A configured value with a separator in it is the user pointing at a
  // specific file. Take it as given: searching from there could only find
  // some other binary than the one they asked for.
  if (name.indexOf('/') !== -1 || (platform === 'win32' && name.indexOf('\\') !== -1)) {
    return { path: expandHome(name, homeDir, p), tried: [] };
  }

  // `.exe` second: a bare `wireproxy` on Windows may well be a shim script.
  const names = platform === 'win32' ? [name, `${name}.exe`] : [name];
  const pathDirs = (pathEnv || '').split(p.delimiter).filter(dir => dir.length > 0);

  const tried: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathDirs.concat(fallbackDirs(platform, homeDir, p))) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    tried.push(dir);
    for (const candidate of names) {
      const full = p.join(dir, candidate);
      if (exists(full)) {
        return { path: full, tried };
      }
    }
  }

  return { path: name, tried };
}

function expandHome(p: string, homeDir: string, rules: PathRules): string {
  if (p === '~') {
    return homeDir;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return rules.join(homeDir, p.slice(2));
  }
  return p;
}

/** The production `exists`: a file that is there and that we may execute. */
export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    // X_OK on a directory only means "traversable", so ask as well: a
    // directory called `wireproxy` would otherwise pass for the binary.
    return fs.statSync(p).isFile();
  } catch (_e) {
    // Missing, a directory, or not ours to run -- all "keep looking".
    return false;
  }
}
