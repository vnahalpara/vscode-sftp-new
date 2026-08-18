import { shellSingle } from '../../../core/dbExec';

// This file is the injection boundary for the whole "Manage Server" feature.
// Every string that ends up executed on a remote shell is built here, and
// every value that came from outside this process (a unit name, a file
// path, a "kind") is validated and/or single-quote escaped before it is
// interpolated. Nothing downstream should build a command string itself.

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
// `|`, `&`, a newline or a path separator is rejected outright.
const UNIT_NAME_RE = /^[A-Za-z0-9._@:-]+$/;
const MAX_UNIT_NAME_LENGTH = 128;

export function isSafeUnitName(unit: string): boolean {
  return (
    typeof unit === 'string' &&
    unit.length > 0 &&
    unit.length <= MAX_UNIT_NAME_LENGTH &&
    UNIT_NAME_RE.test(unit)
  );
}

// Splits `@@key\n...\n@@key2\n...` framed shell output into sections keyed
// by the text after each `@@` marker. Deliberately separate from
// `splitSections` in `src/modules/monitor/frame.ts`, which is tuned to that
// module's own TICK/END + `--name` framing.
export function splitAt(text: string): { [key: string]: string } {
  const result: { [key: string]: string } = {};
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

export function servicesCommand(): string {
  return [
    'echo "@@units"',
    'systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null',
    'echo "@@files"',
    'systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null',
  ].join('; ');
}

// The only command in this file that mutates the remote host. Both the
// action and the unit are validated against an allowlist/pattern before
// being used, and the unit is single-quoted on top of that -- belt and
// braces, since the validator is a denylist of consequences and the
// quoting is the positive guarantee.
export function serviceActionCommand(unit: string, action: string): string {
  if (!isAllowedAction(action)) {
    throw new Error(`Action not allowed: ${action}`);
  }
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  return `sudo -n systemctl ${action} ${shellSingle(unit)}`;
}

export function serviceStatusCommand(unit: string): string {
  if (!isSafeUnitName(unit)) {
    throw new Error(`Unsafe unit name: ${unit}`);
  }
  return `systemctl status ${shellSingle(unit)} --no-pager -l 2>&1 | head -n 60`;
}

// ----------------------------------------------------------- web servers --

export function detectWebServerCommand(): string {
  return [
    'echo "@@nginx"',
    '(command -v nginx >/dev/null 2>&1 && nginx -v 2>&1) || true',
    'echo "@@apache_bin"',
    '(command -v apache2 >/dev/null 2>&1 && echo apache2) || (command -v httpd >/dev/null 2>&1 && echo httpd) || true',
    'echo "@@apache"',
    '(command -v apache2 >/dev/null 2>&1 && apache2 -v 2>&1) || (command -v httpd >/dev/null 2>&1 && httpd -v 2>&1) || true',
    'echo "@@active"',
    // A pipe-delimited record keeps empty fields from collapsing when systemctl prints nothing.
    'for u in nginx apache2 httpd; do printf "%s|%s|%s\\n" "$u" "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"; done',
    'echo "@@ports"',
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
  const script = `for f in ${globs}; do [ -f "$f" ] && { echo "@@$f"; cat "$f"; }; done 2>/dev/null || true`;
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

// Certificate paths cannot be pattern-validated the way unit names can -- a
// legitimate path contains `/` -- so they rely on `shellSingle` alone.
//
// Each path is also announced to the caller via an `@@<path>` marker line so
// the combined openssl output can be split back apart per-path. That header
// is built as `echo @@` immediately followed (no space) by the single-quoted
// path, so the two words concatenate into one argument for `echo`. This
// deliberately avoids `echo "@@$path"`, which would place the path inside a
// double-quoted context where `$(...)` and backticks in the path would still
// be expanded by the remote shell.
//
// Deliberately NOT wrapped in an outer `sh -c ${shellSingle(...)}` layer: the
// per-path values here are already `shellSingle`-quoted for the one real
// shell that will parse this string, and re-quoting the whole script for a
// second, nested shell would require re-escaping those already-quoted spans
// (a doubling that is easy to get subtly wrong). One command string, one
// escaping pass per value, one shell to parse it.
export function certInfoCommand(paths: string[]): string {
  const list: string[] = [];
  const seen: { [key: string]: boolean } = {};
  (paths || []).forEach(p => {
    if (p && !seen[p]) {
      seen[p] = true;
      list.push(p);
    }
  });
  if (list.length === 0) {
    return '';
  }
  return list
    .map(p => `echo @@${shellSingle(p)}; openssl x509 -noout -enddate -subject -issuer -in ${shellSingle(p)} 2>&1`)
    .join('; ');
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

export function readFileCommand(path: string, lines: number): string {
  const n = clampLines(lines);
  return `sudo -n sed -n '1,${n}p' ${shellSingle(path)}`;
}
