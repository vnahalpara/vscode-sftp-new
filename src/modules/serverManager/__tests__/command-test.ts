import {
  SERVICE_ACTIONS, isAllowedAction, isSafeUnitName, splitAt,
  servicesCommand, serviceActionCommand, serviceStatusCommand,
  detectWebServerCommand, configFilesCommand, testConfigCommand,
  certInfoCommand, readFileCommand,
} from '../ops/command';
import { shellSingle } from '../../../core/dbExec';

describe('isAllowedAction', () => {
  it('allows exactly the five documented actions', () => {
    expect(SERVICE_ACTIONS.slice().sort()).toEqual(
      ['reload', 'reload-or-restart', 'restart', 'start', 'stop']
    );
  });
  it('rejects enable and disable, which change boot behaviour', () => {
    expect(isAllowedAction('enable')).toBe(false);
    expect(isAllowedAction('disable')).toBe(false);
  });
  it('rejects anything not on the list', () => {
    ['', 'mask', 'restart; rm -rf /', 'RESTART', 'restart '].forEach(a =>
      expect(isAllowedAction(a)).toBe(false)
    );
  });
});

describe('isSafeUnitName', () => {
  it('accepts real unit names', () => {
    ['nginx', 'nginx.service', 'php8.2-fpm@www.service', 'getty@tty1.service', 'my_app.service']
      .forEach(u => expect(isSafeUnitName(u)).toBe(true));
  });
  it('rejects every shell metacharacter', () => {
    [
      'nginx; rm -rf /', 'nginx && reboot', 'nginx | tee x', 'nginx`id`',
      'nginx$(id)', "nginx'", 'nginx"', 'nginx\nrestart', 'nginx x',
      '../../etc/passwd', '/etc/passwd', '',
    ].forEach(u => expect(isSafeUnitName(u)).toBe(false));
  });
  it('rejects an absurdly long name', () => {
    expect(isSafeUnitName('a'.repeat(129))).toBe(false);
  });
  it('rejects a unit name that begins with a dash, since it would read as a flag', () => {
    // isSafeUnitName's charset (letters, @, ., -) is exactly enough to spell
    // an option like -Huser@host; a leading dash is rejected outright as
    // defence in depth alongside the `--` the command builders also add.
    ['-Hroot@evil', '-Mmachine', '--help', '-'].forEach(u => expect(isSafeUnitName(u)).toBe(false));
  });
});

describe('serviceActionCommand', () => {
  it('builds a quoted systemctl call with a -- terminator', () => {
    expect(serviceActionCommand('nginx.service', 'restart'))
      .toBe(`sudo -n systemctl restart -- 'nginx.service'`);
  });
  it('throws rather than building anything for a bad action', () => {
    expect(() => serviceActionCommand('nginx', 'enable')).toThrow();
  });
  it('throws rather than building anything for a bad unit', () => {
    expect(() => serviceActionCommand('nginx; reboot', 'restart')).toThrow();
  });
  it('throws for a unit that could be parsed as a systemctl flag (argument injection)', () => {
    expect(() => serviceActionCommand('-Hroot@evil', 'restart')).toThrow();
  });
  it('never emits an unquoted unit name', () => {
    // Property check: whatever passes validation must still be quoted.
    expect(serviceActionCommand('php8.2-fpm@www.service', 'reload'))
      .toContain(`'php8.2-fpm@www.service'`);
  });
});

describe('serviceStatusCommand', () => {
  it('builds a quoted systemctl status call with flags before -- and the unit after', () => {
    expect(serviceStatusCommand('nginx.service')).toBe(
      `systemctl status --no-pager -l -- 'nginx.service' 2>&1 | head -n 60`
    );
  });
  it('throws rather than building anything for a bad unit', () => {
    expect(() => serviceStatusCommand('nginx; reboot')).toThrow();
  });
  it('throws for an empty unit', () => {
    expect(() => serviceStatusCommand('')).toThrow();
  });
  it('throws for a unit that could be parsed as a systemctl flag (argument injection)', () => {
    expect(() => serviceStatusCommand('-Hroot@evil')).toThrow();
  });
});

describe('certInfoCommand', () => {
  it('escapes a path containing a single quote so it cannot break out', () => {
    const cmd = certInfoCommand(["/etc/ssl/o'brien.pem"]);
    expect(cmd).toContain(`'/etc/ssl/o'\\''brien.pem'`);
    expect(cmd).not.toMatch(/;\s*rm/);
  });
  it('de-duplicates and drops empty paths', () => {
    const cmd = certInfoCommand(['/a.pem', '/a.pem', '', null as any]);
    expect(cmd.match(/openssl/g)!.length).toBe(1);
  });
  it('returns an empty string for no paths, so no command is run at all', () => {
    expect(certInfoCommand([])).toBe('');
  });
  it('keeps the path out of any double-quoted (interpolating) shell context', () => {
    // The path is never spliced into the script body -- the script only
    // ever refers to the positional parameter "$1", so a value containing
    // $(...) or `...` can never reach an interpolating context.
    const evil = '$(touch /tmp/pwned)`id`';
    const cmd = certInfoCommand([evil]);
    expect(cmd).toMatch(/"@@\$1"/);
    expect(cmd).toMatch(/-in "\$1"/);
    expect(cmd).not.toContain(`"@@${evil}`);
    expect(cmd).not.toMatch(/echo "@@\$\(/);
    // The hostile value appears exactly once: as the single-quoted
    // positional argument appended after the script.
    expect(cmd.split(shellSingle(evil)).length - 1).toBe(1);
  });
  it('quotes a path that tries to close the surrounding quoting, so the injected command never runs unquoted', () => {
    const evil = "/tmp/x'; rm -rf / #";
    const cmd = certInfoCommand([evil]);
    // The hostile text must reach the command only inside a correctly
    // escaped single-quoted span -- never as bare, executable shell syntax.
    expect(cmd.split(shellSingle(evil)).length - 1).toBe(1);
    const withoutEscapedSpans = cmd.split(shellSingle(evil)).join('');
    expect(withoutEscapedSpans).not.toMatch(/;\s*rm -rf \//);
  });
  it('bakes sudo -n into the returned command, per the file-wide privilege contract', () => {
    expect(certInfoCommand(['/a.pem'])).toMatch(/^sudo -n sh -c /);
  });
  it('uses printf, not the shell builtin echo, for its @@ marker', () => {
    const cmd = certInfoCommand(['/a.pem']);
    expect(cmd).not.toMatch(/echo /);
    expect(cmd).toContain('printf');
    expect(cmd).toMatch(/"@@\$1"/);
  });
});

describe('splitAt', () => {
  it('splits @@-prefixed sections', () => {
    expect(splitAt('@@units\na\nb\n@@files\nc')).toEqual({ units: 'a\nb', files: 'c' });
  });
  it('returns an empty object for output with no markers', () => {
    expect(splitAt('noise')).toEqual({});
  });
  it('keeps a section that is present but empty', () => {
    expect(splitAt('@@units\n@@files\nc')).toEqual({ units: '', files: 'c' });
  });
  it('keeps the last occurrence when a key repeats', () => {
    expect(splitAt('@@units\na\n@@units\nb')).toEqual({ units: 'b' });
  });
  it('treats any @@-prefixed line as a new section, even mid-content', () => {
    // This documents the framing's actual behaviour: it has no concept of
    // an "expected" set of markers, so any line beginning with @@ starts a
    // new section. Guarding against attacker-chosen output reaching this
    // parser at all is the job of the command builders (e.g. certInfoCommand
    // keeping paths out of interpolating contexts), not of splitAt itself.
    expect(splitAt('@@units\na\n@@forged\nb')).toEqual({ units: 'a', forged: 'b' });
  });
  it('does not let a forged @@__proto__ section pollute Object.prototype', () => {
    const result = splitAt('@@__proto__\npolluted') as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(result.__proto__).toBe('polluted');
  });
});

describe('configFilesCommand', () => {
  it('builds a privileged command for nginx', () => {
    const cmd = configFilesCommand('nginx');
    expect(cmd).toContain('sudo -n sh -c');
    expect(cmd).toMatch(/nginx/);
  });
  it('builds a privileged command for apache', () => {
    const cmd = configFilesCommand('apache');
    expect(cmd).toContain('sudo -n sh -c');
    expect(cmd).toMatch(/apache|httpd/);
  });
  it('uses printf, not echo, for its per-file @@ marker', () => {
    const cmd = configFilesCommand('nginx');
    expect(cmd).toContain('printf');
    expect(cmd).toContain('"@@$f"');
    expect(cmd).not.toMatch(/echo "@@/);
  });
  it('rejects a kind other than nginx/apache', () => {
    expect(() => configFilesCommand('haproxy' as any)).toThrow();
    expect(() => configFilesCommand('' as any)).toThrow();
    expect(() => configFilesCommand(undefined as any)).toThrow();
  });
});

describe('testConfigCommand', () => {
  it('builds nginx -t for nginx', () => {
    expect(testConfigCommand('nginx')).toMatch(/nginx -t/);
  });
  it('builds a configtest fallback chain for apache', () => {
    const cmd = testConfigCommand('apache');
    expect(cmd).toMatch(/apachectl configtest/);
    expect(cmd).toMatch(/httpd -t/);
  });
  it('rejects a kind other than nginx/apache', () => {
    expect(() => testConfigCommand('caddy' as any)).toThrow();
  });
});

describe('readFileCommand', () => {
  it('escapes a path containing a single quote', () => {
    const cmd = readFileCommand("/var/log/o'brien.log", 100);
    expect(cmd).toContain(`'/var/log/o'\\''brien.log'`);
    expect(cmd).not.toMatch(/;\s*rm/);
  });
  it('clamps an excessive line count to a sane maximum', () => {
    const cmd = readFileCommand('/var/log/syslog', 999999999);
    expect(cmd).not.toContain('999999999');
    expect(cmd).toMatch(/sed -n '1,\d+p'/);
  });
  it('falls back to a sane default for a non-numeric or non-positive line count', () => {
    expect(readFileCommand('/var/log/syslog', NaN)).toMatch(/sed -n '1,\d+p'/);
    expect(readFileCommand('/var/log/syslog', -5)).toMatch(/sed -n '1,\d+p'/);
    expect(readFileCommand('/var/log/syslog', 0)).toMatch(/sed -n '1,\d+p'/);
  });
  it('never lets a path break out of its single quotes to inject a command', () => {
    const evil = "/tmp/x'; rm -rf / #";
    const cmd = readFileCommand(evil, 10);
    // The hostile text must appear only inside a correctly escaped
    // single-quoted span, never as bare shell syntax outside of one.
    expect(cmd).toContain(shellSingle(evil));
    const withoutEscapedSpan = cmd.split(shellSingle(evil)).join('');
    expect(withoutEscapedSpan).not.toMatch(/;\s*rm -rf \//);
  });
  it('adds a -- terminator so a path cannot be read as a sed flag (argument injection)', () => {
    // Without `--`, GNU sed happily parses a leading-`-` operand as a flag:
    // `-e '1w/etc/passwd'` would open (and truncate) /etc/passwd at
    // script-compile time, before any input is read. Quoting alone does
    // NOT defend against this -- a quoted flag is still a flag.
    const cmd = readFileCommand('--expression=1w/etc/passwd', 100);
    expect(cmd).toBe(`sudo -n sed -n '1,100p' -- '--expression=1w/etc/passwd'`);
    expect(cmd).toMatch(/ -- '--expression=1w\/etc\/passwd'$/);
  });
});

describe('servicesCommand', () => {
  it('lists both units and unit-files under @@ markers', () => {
    const cmd = servicesCommand();
    expect(cmd).toMatch(/@@units/);
    expect(cmd).toMatch(/@@files/);
    expect(cmd).toMatch(/systemctl list-units/);
    expect(cmd).toMatch(/systemctl list-unit-files/);
  });
  it('uses printf, not echo, for its @@ markers', () => {
    const cmd = servicesCommand();
    expect(cmd).not.toMatch(/echo "@@/);
    expect(cmd).toContain(`printf '%s\\n' '@@units'`);
    expect(cmd).toContain(`printf '%s\\n' '@@files'`);
  });
});

describe('detectWebServerCommand', () => {
  it('probes nginx, apache and listening ports under @@ markers', () => {
    const cmd = detectWebServerCommand();
    expect(cmd).toMatch(/@@nginx/);
    expect(cmd).toMatch(/@@apache/);
    expect(cmd).toMatch(/@@active/);
    expect(cmd).toMatch(/@@ports/);
  });
  it('uses printf, not echo, for its @@ markers', () => {
    const cmd = detectWebServerCommand();
    expect(cmd).not.toMatch(/echo "@@/);
    expect(cmd).toContain(`printf '%s\\n' '@@nginx'`);
  });
});
