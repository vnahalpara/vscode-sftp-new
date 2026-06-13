import * as os from 'os';
import * as path from 'path';
import { buildMysqldumpCommand } from '../../../core/dbExec';
import { globToRegExp, resolveNoDataTables, fmtBytes } from '../noData';
import { extractPreserved } from '../platform/magentoAdapter';
import { parseDu, parsePhpVersion } from '../detect';
import { expandHome, defaultMediaPaths } from '../cloneConfig';
import { authedGitUrl } from '../codePull';
import { pathsConflict, shouldPinPhpVersion } from '../cloneOrchestrator';
import { phpExport, buildEnvPhp } from '../platform/magentoEnv';
import { magentoVhost, phpFpmPool } from '../provision/templates';

describe('buildMysqldumpCommand', () => {
  const db = { username: 'u', password: 'p', name: 'shop', host: 'localhost' };

  it('dumps the whole DB (with routines) when nothing is structure-only', () => {
    expect(buildMysqldumpCommand(db, [])).toBe(
      `MYSQL_PWD='p' mysqldump --user='u' --host='localhost' --single-transaction --quick --no-tablespaces --default-character-set=utf8mb4 --routines 'shop'`
    );
  });

  it('two-pass: structure-only tables then everything else ignoring them', () => {
    const cmd = buildMysqldumpCommand(db, ['a_log', 'b_session']);
    expect(cmd).toContain(`--no-data 'shop' 'a_log' 'b_session'`);
    expect(cmd).toContain(`--ignore-table='shop.a_log'`);
    expect(cmd).toContain(`--ignore-table='shop.b_session'`);
  });
});

describe('noData matching', () => {
  it('globToRegExp handles * and literal segments', () => {
    expect(globToRegExp('*_log').test('sales_log')).toBe(true);
    expect(globToRegExp('*_log').test('logger')).toBe(false);
    expect(globToRegExp('session').test('session')).toBe(true);
    expect(globToRegExp('session').test('my_session')).toBe(false);
  });

  it('resolveNoDataTables matches patterns + adds explicit excludes, sorted/deduped', () => {
    expect(
      resolveNoDataTables(
        ['sales_log', 'customer_entity', 'quote', 'x_session', 'search_query'],
        ['*_log', '*_session', 'search_query'],
        ['custom_t']
      )
    ).toEqual(['custom_t', 'sales_log', 'search_query', 'x_session']);
  });

  it('fmtBytes formats sizes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('magento env.php preserved layer', () => {
  it('keeps exactly the resync-critical keys', () => {
    expect(
      extractPreserved({
        crypt: { key: 'abc' },
        db: { table_prefix: 'mg_', host: 'x' },
        backend: { frontName: 'admin_x' },
        downloadable_domains: ['a.com'],
        install: { date: 'Wed, 01 Jan 2020' },
        other: 'ignored',
      })
    ).toEqual({
      'crypt.key': 'abc',
      'db.table_prefix': 'mg_',
      'backend.frontName': 'admin_x',
      downloadable_domains: ['a.com'],
      'install.date': 'Wed, 01 Jan 2020',
    });
  });

  it('ignores non-array / missing env', () => {
    expect(extractPreserved(null)).toEqual({});
    expect(extractPreserved({ crypt: {} })).toEqual({});
  });
});

describe('detect parsers', () => {
  it('parseDu reads leading byte count', () => {
    expect(parseDu('19327352832\t/var/www')).toBe(19327352832);
    expect(parseDu('')).toBe(0);
  });
  it('parsePhpVersion reads major.minor', () => {
    expect(parsePhpVersion('PHP 8.2.15 (cli) (built: ...)')).toBe('8.2');
    expect(parsePhpVersion('garbage')).toBeUndefined();
  });
});

describe('clone config helpers', () => {
  it('expandHome expands ~ only', () => {
    expect(expandHome('~/Sites')).toBe(path.join(os.homedir(), 'Sites'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
  it('defaultMediaPaths by platform', () => {
    expect(defaultMediaPaths('magento2')).toEqual(['pub/media']);
    expect(defaultMediaPaths('wordpress')).toEqual(['wp-content/uploads']);
    expect(defaultMediaPaths('unknown')).toEqual([]);
  });
});

describe('authedGitUrl', () => {
  it('embeds credentials into an https url', () => {
    expect(authedGitUrl('https://gitlab.com/g/r.git', 'user', 'tok-en')).toBe(
      'https://user:tok-en@gitlab.com/g/r.git'
    );
  });
  it('leaves the url unchanged without creds or for non-http', () => {
    expect(authedGitUrl('https://gitlab.com/g/r.git')).toBe('https://gitlab.com/g/r.git');
    expect(authedGitUrl('git@gitlab.com:g/r.git', 'u', 'p')).toBe('git@gitlab.com:g/r.git');
  });
});

describe('pathsConflict (clone path vs live-sync context)', () => {
  it('flags identical paths (case/trailing-slash insensitive)', () => {
    expect(pathsConflict('/a/b', '/a/b')).toBe(true);
    expect(pathsConflict('/A/b/', '/a/b')).toBe(true);
  });
  it('flags nesting either way', () => {
    expect(pathsConflict('/a', '/a/b')).toBe(true);
    expect(pathsConflict('/a/b/c', '/a/b')).toBe(true);
  });
  it('allows separate folders', () => {
    expect(pathsConflict('/a/b', '/a/c')).toBe(false);
    expect(pathsConflict('/Users/me/Sites/x', '/repo/.vscode/project/x')).toBe(false);
  });
});

describe('shouldPinPhpVersion (.php-version)', () => {
  it('pins concrete major.minor versions only', () => {
    expect(shouldPinPhpVersion('8.3')).toBe(true);
    expect(shouldPinPhpVersion('8.3.10')).toBe(true);
    expect(shouldPinPhpVersion('auto')).toBe(false);
    expect(shouldPinPhpVersion('')).toBe(false);
    expect(shouldPinPhpVersion(undefined)).toBe(false);
  });
});

describe('magento env.php generation', () => {
  it('phpExport: strings/ints/bools/empty', () => {
    expect(phpExport(`a'b`, 0)).toBe(`'a\\'b'`);
    expect(phpExport(5, 0)).toBe('5');
    expect(phpExport(true, 0)).toBe('true');
    expect(phpExport([], 0)).toBe('[]');
    expect(phpExport(null, 0)).toBe('null');
  });

  it('buildEnvPhp localizes URLs + keeps preserved values + merges envOverrides', () => {
    const out = buildEnvPhp({
      preserved: { 'crypt.key': 'KEY', 'backend.frontName': 'kewadmin', 'install.date': 'D', 'db.table_prefix': '' },
      localDb: { host: '127.0.0.1', username: 'root', password: 'root', name: 'kdb' },
      hostname: 'k.local.com',
      scheme: 'https',
      envOverrides: { pixel_open: { cloudflare_turnstile: { enabled: '0' } } },
    });
    expect(out.indexOf('<?php\nreturn [')).toBe(0);
    expect(out).toContain(`'key' => 'KEY'`);
    expect(out).toContain(`'frontName' => 'kewadmin'`);
    expect(out).toContain(`'base_url' => 'https://k.local.com/'`);
    expect(out).toContain(`'cookie_domain' => 'k.local.com'`);
    expect(out).toContain(`'dbname' => 'kdb'`);
    expect(out).toContain(`'enable' => '0'`); // 2FA off
    expect(out).toContain(`'cloudflare_turnstile'`); // envOverrides merged into system.default
    expect(out.trim().endsWith('];')).toBe(true);
  });
});

describe('provision templates', () => {
  it('magentoVhost: ssl block + http redirect + socket + roots', () => {
    const v = magentoVhost({
      hostname: 'k.local.com',
      magentoRoot: '/U/Sites/k',
      fpmSocket: '/U/.sftp-clone/k/php-fpm.sock',
      mageMode: 'developer',
      ssl: { certPath: '/c.pem', keyPath: '/k.pem' },
    });
    expect(v).toContain('listen 443 ssl');
    expect(v).toContain('ssl_certificate /c.pem');
    expect(v).toContain('server_name k.local.com');
    expect(v).toContain('set $MAGE_ROOT /U/Sites/k');
    expect(v).toContain('root $MAGE_ROOT/pub');
    expect(v).toContain('unix:/U/.sftp-clone/k/php-fpm.sock');
    expect(v).toContain('return 301 https://$host$request_uri');
  });

  it('magentoVhost: http-only when no ssl', () => {
    const v = magentoVhost({ hostname: 'k.local.com', magentoRoot: '/r', fpmSocket: '/s.sock', mageMode: 'developer' });
    expect(v).toContain('listen 80;');
    expect(v.indexOf('listen 443')).toBe(-1);
  });

  it('phpFpmPool: socket + magento limits', () => {
    const p = phpFpmPool({ name: 'k', socket: '/s.sock', owner: 'me' });
    expect(p).toContain('[k]');
    expect(p).toContain('listen = /s.sock');
    expect(p).toContain('listen.owner = me');
    expect(p).toContain('memory_limit] = 2048M');
  });
});
