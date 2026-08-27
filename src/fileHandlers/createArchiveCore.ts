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
// The predicate has to agree with what GNU tar's `--exclude` actually does, or
// the denominator is wrong and the bar never reaches 100%.
//
// `-name` matches the BASENAME only, so `-name 'var/cache'` can never match
// anything -- five of the nine default excludes contain a slash, and every one
// of them was silently counted in while tar went on to exclude them. A pattern
// containing a slash needs `-path`, matched against the whole path, with a
// leading `*/` because tar's `--exclude` is unanchored by default and matches
// at any depth.
//
// `-prune` (rather than a plain filter) is what makes this agree with tar on
// DIRECTORIES: tar does not descend into an excluded directory, so counting
// its contents and then watching tar skip them would stall the bar short.
function findPredicate(pattern: string): string {
  return pattern.indexOf('/') === -1
    ? `-name ${shellSingle(pattern)}`
    : `-path ${shellSingle('*/' + pattern)}`;
}

export function buildCountCommand(parent: string, name: string, excludes: string[]): string {
  const target = shellSingle('./' + name);
  if (excludes.length === 0) {
    return `cd ${shellSingle(parent)} && find ${target} -print | wc -l`;
  }
  // One parenthesised group of alternatives, pruned together. Escaped for the
  // shell, since find's own parentheses would otherwise be subshell syntax.
  const group = excludes.map(findPredicate).join(' -o ');
  return (
    `cd ${shellSingle(parent)} && find ${target} ` +
    `\\( ${group} \\) -prune -o -print | wc -l`
  );
}

// The archive command itself.
//
// `--` before the path is the end-of-options guard this repo uses on every
// remote command. `-C <parent>` plus a bare relative name keeps the archive's
// contents relative (see splitRemotePath).
//
// The archive is written to the PARENT directory, never inside the folder
// being archived -- tar reading the file it is writing produces a growing
// archive and a "file changed as we read it" warning at best.
//
// `echo $$ && exec tar` is what makes CANCEL actually work. ssh2 can send an
// SSH `signal` request, but OpenSSH's sshd ignores it on a pty-less exec
// channel, and closing our end of the channel only tears down the CLIENT's
// view -- the remote tar carries on to completion, still writing an archive
// nobody wants, and the `rm -f` that follows merely unlinks a file tar still
// holds open, so the disk space is not even released until it finishes.
//
// Printing the shell's PID first and then `exec`ing tar into that same PID
// gives the client a real handle to kill over a second channel. It goes to
// STDOUT, where nothing else is written -- tar's verbose member list is on
// stderr -- so the two never interleave.
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
    `cd ${shellSingle(parent)} && echo $$ && ` +
    `exec tar -czvf ${shellSingle(archiveFile)} ${excludeArgs} -- ${shellSingle('./' + name)}`
  );
}

// Stops the remote tar started by buildTarCommand. Runs over its OWN exec
// channel, because the channel tar is running on is exactly the one that will
// not respond. TERM first, then KILL after a moment for a tar that ignores it;
// `|| true` so a process that has already exited is not an error.
export function buildKillCommand(pid: number): string {
  return `kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL ${pid} 2>/dev/null; true`;
}

// Integrity check for the exit-1 case.
//
// GNU tar uses exit 1 for "some files differ" (a log written to mid-run) and 2
// for a fatal error, so exit 1 there means the archive is usable. bsdtar
// (libarchive, the default tar on macOS and the BSDs) does NOT make that
// distinction -- it returns 1 for a genuine failure too, so trusting the exit
// code alone would report success on a total failure against a non-Linux
// server. Ask gzip whether the file it produced is actually intact instead of
// inferring it from a code whose meaning depends on which tar is installed.
export function buildVerifyCommand(parent: string, archiveFile: string): string {
  return `gzip -t -- ${shellSingle(parent + '/' + archiveFile)} 2>&1 && echo OK`;
}

// Removes a partial archive after a cancel or a failure. Best-effort: a
// cleanup that cannot run must never replace the error that caused it.
export function buildCleanupCommand(parent: string, archiveFile: string): string {
  // `--` for the same reason every other remote command in this repo carries
  // one: an absolute path is the normal case, but a relative parent makes
  // `-something/archive.tar.gz` a flag to getopt, quoted or not.
  return `rm -f -- ${shellSingle(parent + '/' + archiveFile)}`;
}

export function buildStatCommand(parent: string, archiveFile: string): string {
  const target = shellSingle(parent + '/' + archiveFile);
  // BSD/macOS servers take -f%z, GNU takes -c%s. Try GNU first, fall back.
  return (
    `stat -c%s -- ${target} 2>/dev/null || ` +
    `stat -f%z -- ${target} 2>/dev/null || echo 0`
  );
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
