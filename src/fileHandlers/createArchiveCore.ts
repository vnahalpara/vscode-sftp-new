import { shellSingle } from '../core/dbExec';

// Patterns excluded when a profile sets no `archiveExcludes` of its own. Every
// one of these is REGENERABLE -- a cache, a log, a build artefact, or a VCS
// directory -- so dropping it costs nothing that cannot be rebuilt on the
// server.
//
// `vendor` and `composer.lock`-adjacent trees are deliberately NOT here.
// Excluding a dependency tree by default would quietly turn "I archived this
// before a risky change" into an archive that cannot be restored without a
// working `composer install`/`npm install` and network access from the server
// -- which is exactly the situation someone restoring a backup is least likely
// to have. It stays available as an opt-in pattern.
export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.svn',
  'var/cache',
  'var/log',
  'var/session',
  'var/tmp',
  'pub/static',
  '.DS_Store',
];

// A pattern reaches `tar --exclude=` and `find -name`. Both are
// shellSingle-quoted before they reach a shell, so a quote or a `;` cannot
// break out -- but a NEWLINE would split the verbose output this feature
// parses for progress, and a pattern is a user-authored config value, not
// something to trust blindly. Reject the characters that break the FORMAT
// rather than trying to reject "dangerous" ones.
export function isSafeExclude(pattern: string): boolean {
  return (
    typeof pattern === 'string' &&
    pattern.length > 0 &&
    pattern.length <= 255 &&
    // Control characters ONLY, written as escapes rather than literal
    // bytes. A space or a hyphen is perfectly legitimate in a directory
    // name (`my-cache`, `Application Support`) and must not be rejected;
    // the character that actually breaks this feature is a newline, which
    // would split a line of tar's verbose output and desynchronise the
    // progress count from the files actually archived.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(pattern)
  );
}

export function resolveExcludes(configured: any): string[] {
  const list = Array.isArray(configured) ? configured : DEFAULT_EXCLUDES;
  return list.filter(isSafeExclude);
}

// Two digits, so the timestamp sorts lexicographically and reads unambiguously.
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// `<folder>-YYYY-MM-DD-HHmmss.tar.gz`. Timestamped so a second run can never
// silently overwrite the first -- there is no "are you sure?" to get wrong if
// the name is unique by construction.
//
// The folder name is sanitised because it becomes a FILENAME on the server: a
// directory legitimately called `my data/` or one carrying a shell character
// would otherwise produce an archive name that is awkward at best. Everything
// outside a conservative set collapses to `_`.
export function archiveName(folderName: string, at: Date): string {
  const safe = (folderName || 'archive').replace(/[^A-Za-z0-9_.-]/g, '_');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${safe}-${stamp}.tar.gz`;
}

// Split a POSIX remote path into the parent directory and the final segment.
// tar runs with `-C <parent>` and is handed the bare `<name>`, which is what
// keeps the archive's internal paths relative (`folder/file`) rather than
// absolute -- an archive of `/var/www/html` that unpacks over `/var/www/html`
// no matter where you extract it is a foot-gun, and GNU tar warns about it.
export function splitRemotePath(remotePath: string): { parent: string; name: string } {
  const trimmed = remotePath.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  if (at < 0) {
    return { parent: '.', name: trimmed };
  }
  if (at === 0) {
    return { parent: '/', name: trimmed.slice(1) };
  }
  return { parent: trimmed.slice(0, at), name: trimmed.slice(at + 1) };
}

// Counts what tar is about to add, so the progress bar has a real denominator
// instead of an indeterminate spinner.
//
// `find` prunes an excluded directory rather than merely skipping its entry
// (`-prune`), which is what makes this count agree with tar's own
// `--exclude` behaviour: tar does not descend into an excluded directory
// either. Counting the entries and then watching tar skip a subtree would
// make the bar stall short of 100%.
export function buildCountCommand(parent: string, name: string, excludes: string[]): string {
  const prunes = excludes
    .map(pattern => `-name ${shellSingle(pattern)} -prune -o`)
    .join(' ');
  return (
    `cd ${shellSingle(parent)} && find ${shellSingle('./' + name)} ` +
    `${prunes} -print | wc -l`
  );
}

// The archive command itself.
//
// `--` before the path is the end-of-options guard this repo uses on every
// remote command: a directory legitimately named `--checkpoint` is a flag to
// getopt otherwise, quoted or not. `-C <parent>` plus a bare relative name
// keeps the archive's contents relative (see splitRemotePath).
//
// The archive is written to the PARENT directory, never inside the folder
// being archived -- tar reading the file it is writing produces a growing
// archive and a "file changed as we read it" warning at best.
export function buildTarCommand(
  parent: string,
  name: string,
  archiveFile: string,
  excludes: string[]
): string {
  const excludeArgs = excludes
    .map(pattern => `--exclude=${shellSingle(pattern)}`)
    .join(' ');
  return (
    `cd ${shellSingle(parent)} && tar -czvf ${shellSingle(archiveFile)} ` +
    `${excludeArgs} -- ${shellSingle('./' + name)}`
  );
}

// Removes a partial archive after a cancel or a failure. Best-effort: a
// cleanup that cannot run must never replace the error that caused it.
export function buildCleanupCommand(parent: string, archiveFile: string): string {
  return `rm -f ${shellSingle(parent + '/' + archiveFile)}`;
}

export function buildStatCommand(parent: string, archiveFile: string): string {
  const target = shellSingle(parent + '/' + archiveFile);
  // BSD/macOS servers take -f%z, GNU takes -c%s. Try GNU first, fall back.
  return `stat -c%s ${target} 2>/dev/null || stat -f%z ${target} 2>/dev/null || echo 0`;
}

// tar -v writes one line per member to STDERR (stdout carries the archive
// itself when writing to `-`, and GNU tar keeps the split even when writing to
// a file, so parsing stderr is correct rather than incidental).
//
// Returns the member names in a chunk plus whatever trailing partial line is
// left over, which the caller carries into the next chunk. A chunk boundary
// falls mid-line often enough at these volumes that ignoring the remainder
// silently under-counts.
export function parseVerboseChunk(
  chunk: string,
  carry: string
): { names: string[]; carry: string } {
  const text = carry + chunk;
  const lines = text.split('\n');
  const rest = lines.pop() || '';
  return {
    names: lines.map(line => line.replace(/\r$/, '')).filter(line => line.length > 0),
    carry: rest,
  };
}

// tar's own diagnostics also arrive on stderr, interleaved with the member
// list. A line that is a real WARNING must not be counted as a file, or the
// progress bar overshoots.
export function isDiagnosticLine(line: string): boolean {
  return /^tar:\s/.test(line) || /^\s*$/.test(line);
}
