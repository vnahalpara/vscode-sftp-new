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
});

describe('serviceActionCommand', () => {
  it('builds a quoted systemctl call', () => {
    expect(serviceActionCommand('nginx.service', 'restart'))
      .toBe(`sudo -n systemctl restart 'nginx.service'`);
  });
  it('throws rather than building anything for a bad action', () => {
    expect(() => serviceActionCommand('nginx', 'enable')).toThrow();
  });
  it('throws rather than building anything for a bad unit', () => {
    expect(() => serviceActionCommand('nginx; reboot', 'restart')).toThrow();
  });
  it('never emits an unquoted unit name', () => {
    // Property check: whatever passes validation must still be quoted.
    expect(serviceActionCommand('php8.2-fpm@www.service', 'reload'))
      .toContain(`'php8.2-fpm@www.service'`);
  });
});

describe('serviceStatusCommand', () => {
  it('builds a quoted systemctl status call', () => {
    expect(serviceStatusCommand('nginx.service')).toBe(
      `systemctl status 'nginx.service' --no-pager -l 2>&1 | head -n 60`
    );
  });
  it('throws rather than building anything for a bad unit', () => {
    expect(() => serviceStatusCommand('nginx; reboot')).toThrow();
  });
  it('throws for an empty unit', () => {
    expect(() => serviceStatusCommand('')).toThrow();
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
  it('never lets a path reach a double-quoted (interpolating) shell context', () => {
    // The @@header line must not place the raw path inside double quotes,
    // where $(...) or `...` would still be expanded by the remote shell.
    const evil = '$(touch /tmp/pwned)`id`';
    const cmd = certInfoCommand([evil]);
    expect(cmd).not.toContain(`"@@${evil}`);
    expect(cmd).not.toMatch(/echo "@@\$\(/);
    // The whole hostile value must instead appear as one properly
    // single-quote-escaped token, exactly as shellSingle would produce it.
    expect(cmd.split(shellSingle(evil)).length - 1).toBe(2); // once in @@header, once in -in
  });
  it('quotes a path that tries to close the surrounding quoting, so the injected command never runs unquoted', () => {
    const evil = "/tmp/x'; rm -rf / #";
    const cmd = certInfoCommand([evil]);
    // The hostile text must reach the command only inside a correctly
    // escaped single-quoted span -- never as bare, executable shell syntax.
    expect(cmd.split(shellSingle(evil)).length - 1).toBe(2);
    const withoutEscapedSpans = cmd.split(shellSingle(evil)).join('');
    expect(withoutEscapedSpans).not.toMatch(/;\s*rm -rf \//);
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
});

describe('servicesCommand', () => {
  it('lists both units and unit-files under @@ markers', () => {
    const cmd = servicesCommand();
    expect(cmd).toMatch(/@@units/);
    expect(cmd).toMatch(/@@files/);
    expect(cmd).toMatch(/systemctl list-units/);
    expect(cmd).toMatch(/systemctl list-unit-files/);
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
});
