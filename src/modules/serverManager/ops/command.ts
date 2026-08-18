import { shellSingle } from '../../../core/dbExec';

// This file is the injection boundary for the whole "Manage Server" feature.
// Every string that ends up executed on a remote shell is built here, and
// every value that came from outside this process (a unit name, a file
// path, a "kind") is validated and/or single-quote escaped before it is
// interpolated. Nothing downstream should build a command string itself.
//
// Privilege contract: every builder below returns a COMPLETE, ready-to-run
// command with any required privilege escalation already baked in as a
// literal `sudo -n` in the returned string. The exec layer that eventually
// runs these strings must never prepend `sudo` itself -- if a command needs
// it, it is already there.
//
// Quoting alone is not enough: a value can be a perfectly safe single shell
// word and still be a *flag* rather than an *operand* if it starts with
// `-` (e.g. a "path" of `--expression=1w/etc/passwd` handed to `sed`, or a
// unit name of `-Hroot@evil` handed to `systemctl`). Every caller-supplied
// operand below is therefore both quoted AND passed after a `--`
// end-of-options marker wherever the target tool honours one, so a
// leading-`-` value can never be reinterpreted as an option.
//
// Bad-input contract: a builder that names ONE specific target (a unit, a
// single file path) throws on invalid input -- the caller asked for that
// exact thing and wants an error, not silence. A builder that names a
// BATCH of targets (a list of certificate paths gathered from many vhosts)
// skips and reports the offending entry instead of throwing, so one
// pathological path can't blank the whole batch for every other, valid
// entry in it.

// -------------------------------------------------------------- services --

export const SERVICE_ACTIONS: string[] = ['start', 'stop', 'restart', 'reload', 'reload-or-restart'];

// `enable` and `disable` are deliberately not here: they change boot
// behaviour (a different class of decision from restarting a running
// service) and nothing in this milestone's UI offers them.
export function isAllowedAction(action: string): boolean {
  return typeof action === 'string' && SERVICE_ACTIONS.indexOf(action) !== -1;
}

// Real systemd unit names look like `nginx.service`, `php8.2-fpm@www.service`
// or `getty@tty1.service`. Anything with a space, quote, backtick, `$`, `;`,
// `|`, `&`, a newline or a path separator is rejected outright. A leading
// `-` is rejected too: systemd's own charset (letters, `@`, `.`, `-`) is
// exactly enough to spell an option like `-Huser@host`, which `systemctl`
// would parse as `--host=` if it ever reached argv without a `--` guard --
// belt and braces alongside the `--` inserted by the command builders below.
const UNIT_NAME_RE = /^[A-Za-z0-9._@:-]+$/;
const MAX_UNIT_NAME_LENGTH = 128;

export function isSafeUnitName(unit: string): boolean {
  return (
    typeof unit === 'string' &&
    unit.length > 0 &&
    unit.length <= MAX_UNIT_NAME_LENGTH &&
    unit.charAt(0) !== '-' &&
    UNIT_NAME_RE.test(unit)
  );
}

// Splits `@@key\n...\n@@key2\n...` framed shell output into sections keyed
// by the text after each `@@` marker. Deliberately separate from
// `splitSections` in `src/modules/monitor/frame.ts`, which is tuned to that
// module's own TICK/END + `--name` framing.
//
// Uses a null-prototype accumulator so a forged `@@__proto__` (or
// `@@constructor`) section in remote output becomes an ordinary own-key
// entry instead of reaching or mutating `Object.prototype`.
export function splitAt(text: string): { [key: string]: string } {
  const result: { [key: string]: string } = Object.create(null);
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.indexOf('@@') === 0) {
      if (currentKey !== null) {
        result[currentKey] = currentLines.join('\n');
      }
      currentKey = line.slice(2);
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }
  if (currentKey !== null) {
    result[currentKey] = currentLines.join('\n');
  }
  return result;
}

// `printf '%s\n'` rather than `echo`: POSIX `sh`'s builtin `echo` is free to
// expand backslash escapes in its argument (dash's does, unconditionally),
// so a value containing a literal `\n` could forge a second `@@` line.
// `printf`'s `%s` conversion copies its argument verbatim -- only the
// format string itself is escape-processed, never the substituted data.
export function servicesCommand(): string {
  return [
    `printf '%s\\n' '@@units'`,
    'systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null',
    `printf '%s\\n' '@@files'`,
    'systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null',
  ].join('; ');
}

// The only command in this file that mutates the remote host. Both the
// action and the unit are validated against an allowlist/pattern before
// being used, and the unit is single-quoted on top of that -- belt and
// braces, since the validator is a denylist of consequences and the
// quoting is the positive guarantee. The `--` stops `systemctl` from ever
// reinterpreting the unit as an option, independent of the leading-`-`
// check in `isSafeUnitName`.
export function serviceActionCommand(unit: string, action: string): string {
  if (!isAllowedAction(action)) {
    throw new Error(`Action not allowed: ${action}`);
  }
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  return `sudo -n systemctl ${action} -- ${shellSingle(unit)}`;
}

export function serviceStatusCommand(unit: string): string {
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  // Flags before `--`, unit after: systemctl's own option parsing only
  // stops at `--`, so putting it before `--no-pager`/`-l` would make those
  // flags be swallowed as extra positional units instead of options.
  return `systemctl status --no-pager -l -- ${shellSingle(unit)} 2>&1 | head -n 60`;
}

// ----------------------------------------------------------- web servers --

export function detectWebServerCommand(): string {
  return [
    // RHEL/Rocky/Alma keep /usr/sbin and /sbin off a non-root user's PATH,
    // and an SSH exec channel is not a login shell, so `command -v nginx` /
    // `command -v httpd` there answers "not installed" for a web server that
    // is plainly installed -- and the UI reports "No web server detected",
    // which reads as a normal answer rather than a lookup failure. Appended
    // rather than prepended, and never replacing $PATH: this only has to make
    // the sbin directories REACHABLE, and putting them first would shadow a
    // user's own nginx/httpd (a /usr/local/bin build, an asdf/nix shim) with
    // the distro one, reporting a version the host does not actually run.
    'PATH=$PATH:/usr/sbin:/sbin',
    `printf '%s\\n' '@@nginx'`,
    '(command -v nginx >/dev/null 2>&1 && nginx -v 2>&1) || true',
    `printf '%s\\n' '@@apache_bin'`,
    '(command -v apache2 >/dev/null 2>&1 && echo apache2) || (command -v httpd >/dev/null 2>&1 && echo httpd) || true',
    `printf '%s\\n' '@@apache'`,
    '(command -v apache2 >/dev/null 2>&1 && apache2 -v 2>&1) || (command -v httpd >/dev/null 2>&1 && httpd -v 2>&1) || true',
    `printf '%s\\n' '@@active'`,
    // A pipe-delimited record keeps empty fields from collapsing when systemctl prints nothing.
    'for u in nginx apache2 httpd; do printf "%s|%s|%s\\n" "$u" "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"; done',
    `printf '%s\\n' '@@ports'`,
    '(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":(80|443|8080|8443)[[:space:]]" || true',
  ].join('; ');
}

type WebServerKind = 'nginx' | 'apache';

function assertWebServerKind(kind: WebServerKind): void {
  if (kind !== 'nginx' && kind !== 'apache') {
    throw new Error(`Unknown web server kind: ${kind}`);
  }
}

// One glob per entry, and the shell word list is derived from it, so the
// list a command expands and the list a path is checked against below can
// never drift apart.
const NGINX_GLOB_LIST = [
  '/etc/nginx/sites-enabled/*',
  '/etc/nginx/conf.d/*.conf',
  '/usr/local/etc/nginx/conf.d/*.conf',
];
const APACHE_GLOB_LIST = [
  '/etc/apache2/sites-enabled/*.conf',
  '/etc/httpd/conf.d/*.conf',
  '/etc/httpd/sites-enabled/*.conf',
  '/etc/apache2/vhosts.d/*.conf',
];

const NGINX_GLOBS = NGINX_GLOB_LIST.join(' ');
const APACHE_GLOBS = APACHE_GLOB_LIST.join(' ');

// Whether a path could have been produced by expanding one of the globs
// above -- i.e. whether it is a path this feature is allowed to have
// surfaced as a config file at all.
//
// This exists because `configFilesCommand` frames its output as
// `printf '@@$f'; cat "$f"`, so the file BYTES travel in the same stream as
// the `@@` markers that delimit them. A line beginning `@@/etc/shadow`
// inside any config file under these directories is indistinguishable, to
// `splitAt`, from a real marker -- so remote file CONTENT can name any path
// it likes. Section keys are therefore untrusted input, and routes.ts
// intersects them against this predicate before any of them can reach the
// `/api/file` allowlist (which runs a privileged read).
//
// `*` in a shell glob never matches a `/`, so a match requires the literal
// directory prefix, a non-empty name containing no separator, and the
// glob's own suffix where it has one. `.` and `..` are excluded explicitly:
// `/etc/nginx/sites-enabled/..` satisfies the shape but names a directory
// outside the allowed one.
function matchesGlob(glob: string, path: string): boolean {
  const star = glob.indexOf('*');
  const prefix = glob.slice(0, star);
  const suffix = glob.slice(star + 1);
  if (typeof path !== 'string' || path.indexOf(prefix) !== 0) {
    return false;
  }
  const name = path.slice(prefix.length);
  if (name.indexOf('/') !== -1 || name === '.' || name === '..') {
    return false;
  }
  if (name.length <= suffix.length) {
    return false;
  }
  return name.slice(name.length - suffix.length) === suffix;
}

export function isConfigFilePath(kind: WebServerKind, path: string): boolean {
  assertWebServerKind(kind);
  const globs = kind === 'nginx' ? NGINX_GLOB_LIST : APACHE_GLOB_LIST;
  return globs.some(glob => matchesGlob(glob, path));
}

// Config file paths come from a fixed, hard-coded glob under /etc, never
// from caller input, so they need no escaping here -- only `kind` is
// externally controlled, and it is checked against an exact allowlist.
export function configFilesCommand(kind: WebServerKind): string {
  assertWebServerKind(kind);
  const globs = kind === 'nginx' ? NGINX_GLOBS : APACHE_GLOBS;
  // The `printf '\n'` after `cat` is load-bearing, not cosmetic. `cat`
  // reproduces the file byte for byte, so a config file that does not end in
  // a newline -- an ordinary result of hand-editing a vhost -- leaves the
  // stream mid-line, and the NEXT file's `@@` marker lands appended to that
  // last line. splitAt requires `line.indexOf('@@') === 0`, so that marker is
  // not recognised: the following file's vhosts are attributed to the
  // previous file, and its own path never reaches the allowlist, making the
  // View button show the wrong file or 403. One unconditional newline costs a
  // blank line at the end of each section (harmless to every parser here) and
  // removes the failure entirely.
  const script = `for f in ${globs}; do [ -f "$f" ] && { printf '%s\\n' "@@$f"; cat "$f"; printf '\\n'; }; done 2>/dev/null || true`;
  return `sudo -n sh -c ${shellSingle(script)}`;
}

export function testConfigCommand(kind: WebServerKind): string {
  assertWebServerKind(kind);
  const script =
    kind === 'nginx'
      ? 'nginx -t 2>&1'
      : '(apachectl configtest 2>&1) || (apache2ctl configtest 2>&1) || (httpd -t 2>&1)';
  return `sudo -n sh -c ${shellSingle(script)}`;
}

// ------------------------------------------------------------ certificates --

// A path containing a raw newline, carriage return, or NUL can never be a
// legitimate filesystem path reference we should act on, and -- for the
// two builders below that frame their output with `@@` markers keyed by
// path -- a raw newline would forge extra section boundaries downstream in
// `splitAt`. Reject rather than silently drop: a control character in a
// cert path pulled from a live nginx/apache config means that config is
// corrupt or hostile, and quietly omitting a certificate from a listing
// (or silently no-op'ing a file read) is worse than surfacing an error.
function hasControlChars(value: string): boolean {
  return /[\n\r\0]/.test(value);
}

// Certificate paths cannot be pattern-validated the way unit names can -- a
// legitimate path contains `/` -- so they rely on `shellSingle` (plus the
// control-character rejection above) rather than a charset allowlist.
//
// Each surviving path is passed as a positional parameter to a `sh -c`
// script rather than spliced into the script text: the script body only
// ever refers to `${1}`, `${2}`, ... and the actual values are appended,
// each `shellSingle`-quoted exactly once, after the script. This sidesteps
// the classic nested-quoting trap where wrapping an already-quoted value in
// a second outer quoting layer would require re-escaping it -- here every
// value is quoted exactly once, for the one shell that will parse this
// string.
//
// Positional parameters are always braced (`${1}`, not `$1`), even below
// ten: POSIX `sh` parses the *unbraced* form `$10` as `${1}` followed by a
// literal `0`, not as parameter 10. With ten or more certificates -- not
// unusual on a multi-vhost host -- unbraced references would silently
// reference the wrong (or a nonexistent) parameter for the tenth path
// onward. Bracing uniformly, rather than only past nine, is what stops this
// from recurring the next time this template is edited.
//
// `openssl x509 -in "${1}"` needs no `--` guard: the path is only ever the
// *value* of the `-in` option (OpenSSL's own option table unconditionally
// consumes the next argv element for an option declared to take a value),
// never a bare positional operand, so there is no flag/operand ambiguity
// for a leading `-` to exploit -- and `openssl x509` does not accept `--`
// as an end-of-options marker in any case.
//
// This is a BATCH builder (see the bad-input contract note above): a
// caller-supplied path that contains a newline/CR/NUL is skipped and
// reported back in `skipped`, not thrown -- one pathological path (e.g.
// one corrupt `ssl_certificate` directive among forty vhosts) must not
// blank the certificate output for every other, valid path in the batch.
// The surviving paths are renumbered contiguously -- `${1}`, `${2}`, ...
// against the arguments actually passed -- so a skip never leaves a hole
// in the positional-parameter sequence (which would risk the same class of
// misnumbering the unbraced-`$10` bug produced).
export interface CertCommand {
  command: string; // '' when nothing is left to inspect
  skipped: string[]; // paths rejected as unsafe, so the caller can surface them
}

export function certInfoCommand(paths: string[]): CertCommand {
  const list: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  (paths || []).forEach(p => {
    if (!p) {
      return;
    }
    if (hasControlChars(p)) {
      skipped.push(p);
      return;
    }
    if (!seen.has(p)) {
      seen.add(p);
      list.push(p);
    }
  });
  if (list.length === 0) {
    return { command: '', skipped };
  }
  const script = list
    .map((_p, i) => {
      const posParam = `\${${i + 1}}`;
      return `printf '%s\\n' "@@${posParam}"; openssl x509 -noout -enddate -subject -issuer -in "${posParam}" 2>&1`;
    })
    .join('; ');
  const args = list.map(shellSingle).join(' ');
  return { command: `sudo -n sh -c ${shellSingle(script)} sh ${args}`, skipped };
}

// ------------------------------------------------------------------- files --

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 5000;

function clampLines(lines: number): number {
  const n = Number(lines);
  if (!isFinite(n) || n <= 0) {
    return DEFAULT_READ_LINES;
  }
  return Math.min(Math.floor(n), MAX_READ_LINES);
}

// `--` stops GNU sed from treating a "path" like `--expression=1w/etc/passwd`
// as a flag: sed scans its argv for options up to the file operand, and
// without `--` a leading-`-` value is a valid single argv element that sed
// happily parses as `-e '1w/etc/passwd'` -- opening (and truncating)
// `/etc/passwd` at script-compile time, before any input is even read.
//
// A path containing a newline/CR/NUL is rejected using the same
// `hasControlChars` check as `certInfoCommand`, but this builder THROWS
// rather than skipping-and-reporting: per the bad-input contract at the top
// of this file, `readFileCommand` names one specific file by explicit
// request, not a batch harvested from many sources. There is no list to
// shrink here -- either that one real file gets read, or the caller gets a
// clear error. Silently returning an empty command for a single explicit
// request would look like "the file has no content" rather than "the
// request was rejected", which is a worse failure mode than an exception.
export function readFileCommand(path: string, lines: number): string {
  if (hasControlChars(path)) {
    throw new Error('Refusing to build a read command for a path containing a newline or NUL byte');
  }
  const n = clampLines(lines);
  return `sudo -n sed -n '1,${n}p' -- ${shellSingle(path)}`;
}

// ------------------------------------------------------------------- logs --

// Where and how deep `logDiscoveryCommand` scans for candidate log files.
// Fixed, not caller-supplied, so -- like NGINX_GLOBS/APACHE_GLOBS above --
// neither needs escaping.
const LOG_SCAN_ROOT = '/var/log';
const LOG_SCAN_MAX_DEPTH = 3;

// `/var/log/journal/**` holds systemd-journald's binary journal files, not
// human-readable logs. Their content is already exposed -- properly, via
// `journalctl` -- through journalCommand/journalFollowCommand below, so
// listing them again here as "files" would duplicate the journald units
// already surfaced under @@units and offer a path that `tailCommand`/
// `followCommand` (plain `tail`) cannot usefully read anyway.
const LOG_SCAN_EXCLUDE = `${LOG_SCAN_ROOT}/journal/*`;

// Lists candidate log files under /var/log (regular files, bounded depth,
// with sizes) and journald units that have ever logged, framed with the
// `@@` marker convention and meant to be parsed with `splitAt` (see
// `parseLogDiscovery` in `ops/logs.ts`, which does both).
//
// Size is read with `stat -c%s`, not `find -printf '%s'`: `-printf` is a
// GNU findutils extension that busybox's `find` (Alpine and other minimal
// containers) does not support, and this feature already treats busybox
// compatibility as a real constraint (see the date fallback in
// `monitor/probe.ts`). `stat -c%s` costs one extra process per file but
// works on both GNU coreutils and busybox. A file that vanishes between
// `find` listing it and `stat` reading it (log rotation is exactly this
// race), or one this user cannot stat even under sudo, leaves `sz` empty
// rather than aborting the scan -- `parseLogDiscovery` turns that into
// `bytes: null`, never `bytes: 0`.
//
// Every line this command's own `stat` loop writes already ends in `\n`
// (each is its own `printf '...\n'` call), unlike `configFilesCommand`'s
// `cat "$f"`, which reproduces a THIRD PARTY file's bytes verbatim and can
// genuinely lack a trailing newline. Even so, an explicit `printf '\n'` is
// appended after each section here anyway, as a defensive belt-and-braces
// measure: it is what actually stops the `configFilesCommand`-class bug --
// the next `@@` marker landing appended to the previous section's last
// line and being swallowed by `splitAt` (which only recognises `@@` at
// index 0) -- from resurfacing the next time this script is edited to add
// a line-emitting step that doesn't already end in `\n` on its own.
export function logDiscoveryCommand(): string {
  const script = [
    `printf '%s\\n' '@@files'`,
    `find ${LOG_SCAN_ROOT} -maxdepth ${LOG_SCAN_MAX_DEPTH} -type f ! -path ${shellSingle(LOG_SCAN_EXCLUDE)} 2>/dev/null | while IFS= read -r f; do sz=$(stat -c%s "$f" 2>/dev/null); printf '%s\\t%s\\n' "$sz" "$f"; done`,
    `printf '\\n'`,
    `printf '%s\\n' '@@units'`,
    'journalctl -F _SYSTEMD_UNIT --no-pager 2>/dev/null',
    `printf '\\n'`,
  ].join('; ');
  return `sudo -n sh -c ${shellSingle(script)}`;
}

// `tail -n <N>` / `journalctl -n <N>` interpolate N directly into the
// command text with NO quoting -- this is a different kind of operand from
// every path/unit above. A path or unit name is made safe by quoting it
// (`shellSingle`) and/or validating its charset; a line count can't be
// quoted the way a path can, because `tail`/`journalctl` need to see a bare
// number in argv, not a quoted string -- `tail -n '200'` is fine, but
// `tail -n '200; rm -rf /'` is just as fine from the shell's point of view,
// because quoting only stops word-splitting, not `tail` itself later doing
// something dangerous with its argument; the real danger here is passing
// the value as a shell-syntax-bearing STRING at all. So instead of quoting,
// N is proven to be nothing but a small positive integer -- via
// `Number.isInteger` plus an explicit upper bound -- before it is
// interpolated at all. Unlike `clampLines` (used by `readFileCommand`),
// this THROWS rather than silently substituting a default: per the
// bad-input contract at the top of this file, `tailCommand`/`journalCommand`
// name one specific target by explicit request, so a bad count should
// surface as an error, not a silently-different result. A non-`number`
// value (e.g. the string `'200; rm -rf /'`) is rejected outright by the
// `typeof` check, with no numeric coercion attempted on it at all.
const MAX_TAIL_LINES = 5000;

function validateLineCount(lines: number): number {
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines <= 0 || lines > MAX_TAIL_LINES) {
    throw new Error(`Invalid line count: ${lines}`);
  }
  return lines;
}

// Single, specific file named by explicit request (not a batch), so this
// throws rather than skipping, per the bad-input contract. `--` stops GNU
// tail from treating a leading-`-` "path" as a flag, same reasoning as
// `readFileCommand`'s `sed -- `.
export function tailCommand(path: string, lines: number): string {
  if (hasControlChars(path)) {
    throw new Error('Refusing to build a tail command for a path containing a newline or NUL byte');
  }
  const n = validateLineCount(lines);
  return `sudo -n tail -n ${n} -- ${shellSingle(path)}`;
}

// A pure follow, not "show some history then follow": `-n 0` suppresses the
// last-N-lines dump `tail -F` would otherwise print before switching to
// follow mode, so a client (re)connecting to an already-flowing log (Task
// 5's WebSocket layer) does not get a replay of old content interleaved
// with genuinely new lines.
//
// No `sh -c` wrapper and no backgrounding (`&`) here, unlike the
// multi-step framed commands above -- this is a single, direct,
// long-running foreground process. That matters for the consumer's ability
// to kill it cleanly: a SIGTERM sent to this process (e.g. Task 5 closing
// the exec channel on client disconnect) reaches `tail` directly through
// `sudo`, with no extra shell layer in between that could be left running
// or need its own signal forwarded.
export function followCommand(path: string): string {
  if (hasControlChars(path)) {
    throw new Error('Refusing to build a follow command for a path containing a newline or NUL byte');
  }
  return `sudo -n tail -n 0 -F -- ${shellSingle(path)}`;
}

// The unit is validated with the existing `isSafeUnitName` (see the top of
// this file) -- deliberately not a second, parallel validator. Single,
// specific unit named by explicit request, so this throws rather than
// skipping.
//
// Flags before `--`, unit after -- the same convention `serviceStatusCommand`
// uses above -- even though `-u`/`--unit` is an option that normally
// consumes the very next argv element as its value regardless of content.
export function journalCommand(unit: string, lines: number): string {
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  const n = validateLineCount(lines);
  return `sudo -n journalctl -n ${n} --no-pager -u -- ${shellSingle(unit)}`;
}

// journalctl's own pure-follow shape: `-n 0` for the same "no replay on
// connect" reason as `followCommand`'s `tail -n 0 -F`, `-f` to follow, and
// -- like `followCommand` -- a single direct foreground process with no
// `sh -c` wrapper, so a consumer's SIGTERM reaches `journalctl` cleanly.
export function journalFollowCommand(unit: string): string {
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  return `sudo -n journalctl -n 0 -f --no-pager -u -- ${shellSingle(unit)}`;
}
