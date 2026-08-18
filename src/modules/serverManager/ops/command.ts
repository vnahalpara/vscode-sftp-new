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

const NGINX_GLOBS = '/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /usr/local/etc/nginx/conf.d/*.conf';
const APACHE_GLOBS =
  '/etc/apache2/sites-enabled/*.conf /etc/httpd/conf.d/*.conf /etc/httpd/sites-enabled/*.conf /etc/apache2/vhosts.d/*.conf';

// Config file paths come from a fixed, hard-coded glob under /etc, never
// from caller input, so they need no escaping here -- only `kind` is
// externally controlled, and it is checked against an exact allowlist.
export function configFilesCommand(kind: WebServerKind): string {
  assertWebServerKind(kind);
  const globs = kind === 'nginx' ? NGINX_GLOBS : APACHE_GLOBS;
  const script = `for f in ${globs}; do [ -f "$f" ] && { printf '%s\\n' "@@$f"; cat "$f"; }; done 2>/dev/null || true`;
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
// Each path is passed as a positional parameter to a `sh -c` script rather
// than spliced into the script text: the script body only ever refers to
// `${1}`, `${2}`, ... and the actual values are appended, each `shellSingle`-
// quoted exactly once, after the script. This sidesteps the classic nested-
// quoting trap where wrapping an already-quoted value in a second outer
// quoting layer would require re-escaping it -- here every value is quoted
// exactly once, for the one shell that will parse this string.
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
export function certInfoCommand(paths: string[]): string {
  const list: string[] = [];
  const seen = new Set<string>();
  (paths || []).forEach(p => {
    if (!p) {
      return;
    }
    if (hasControlChars(p)) {
      throw new Error('Refusing to build a certificate command for a path containing a newline or NUL byte');
    }
    if (!seen.has(p)) {
      seen.add(p);
      list.push(p);
    }
  });
  if (list.length === 0) {
    return '';
  }
  const script = list
    .map((_p, i) => {
      const posParam = `\${${i + 1}}`;
      return `printf '%s\\n' "@@${posParam}"; openssl x509 -noout -enddate -subject -issuer -in "${posParam}" 2>&1`;
    })
    .join('; ');
  const args = list.map(shellSingle).join(' ');
  return `sudo -n sh -c ${shellSingle(script)} sh ${args}`;
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
// A path containing a newline/CR/NUL is rejected the same way certInfoCommand
// rejects one (see `hasControlChars` above): this builder names a single,
// specific file to read, so unlike a batch listing there is no reasonable
// "silently skip it" option -- either a real file gets read or the caller
// gets a clear error, matching how `serviceActionCommand` etc. throw rather
// than quietly building nothing for bad input.
export function readFileCommand(path: string, lines: number): string {
  if (hasControlChars(path)) {
    throw new Error('Refusing to build a read command for a path containing a newline or NUL byte');
  }
  const n = clampLines(lines);
  return `sudo -n sed -n '1,${n}p' -- ${shellSingle(path)}`;
}
