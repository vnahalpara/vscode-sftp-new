import { LocalDb } from '../cloneConfig';

// Serialize a JS value to PHP array syntax (Magento env.php style: 'key' => value).
export function phpExport(value: any, indent: number): string {
  const pad = '    '.repeat(indent);
  const padIn = '    '.repeat(indent + 1);
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const arrItems = value.map(v => `${padIn}${phpExport(v, indent + 1)}`).join(',\n');
    return `[\n${arrItems}\n${pad}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return '[]';
  }
  const objItems = keys
    .map(k => {
      const keyStr = /^\d+$/.test(k) ? k : `'${k.replace(/'/g, '\\\'')}'`;
      return `${padIn}${keyStr} => ${phpExport(value[k], indent + 1)}`;
    })
    .join(',\n');
  return `[\n${objItems}\n${pad}]`;
}

function deepMerge(base: any, over: any): any {
  if (!over || typeof over !== 'object' || Array.isArray(over)) {
    return over === undefined ? base : over;
  }
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = k in out ? deepMerge(out[k], over[k]) : over[k];
  }
  return out;
}

export interface EnvPhpOptions {
  preserved: { [key: string]: any };
  localDb: LocalDb;
  hostname: string;
  scheme: 'http' | 'https';
  envOverrides: { [key: string]: any };
}

// Build a localized Magento app/etc/env.php: preserved live values (crypt.key, table_prefix, …)
// + local DB + system.default overrides (base URLs, cookie, 2FA off, per-project envOverrides).
// system.default values take precedence over core_config_data, so a fresh DB import is localized
// without any post-import SQL.
export function buildEnvPhp(opts: EnvPhpOptions): string {
  const p = opts.preserved || {};
  const pv = (key: string) => p[key];
  const baseUrl = `${opts.scheme}://${opts.hostname}/`;

  const systemDefault = deepMerge(
    {
      web: {
        unsecure: { base_url: baseUrl },
        secure: {
          base_url: baseUrl,
          use_in_frontend: '1',
          use_in_adminhtml: '1',
        },
        cookie: { cookie_domain: opts.hostname },
      },
      payment: { checkmo: { active: '1' } },
      twofactorauth: { general: { enable: '0' } },
    },
    opts.envOverrides || {}
  );

  const env: any = {
    backend: { frontName: pv('backend.frontName') || 'admin' },
    crypt: { key: pv('crypt.key') || '' },
    db: {
      table_prefix: pv('db.table_prefix') !== undefined ? pv('db.table_prefix') : '',
      connection: {
        default: {
          host: opts.localDb.host,
          dbname: opts.localDb.name,
          username: opts.localDb.username,
          password: opts.localDb.password,
          active: '1',
        },
      },
    },
    resource: { default_setup: { connection: 'default' } },
    'x-frame-options': 'SAMEORIGIN',
    MAGE_MODE: 'developer',
    session: { save: 'files' },
    lock: { provider: 'db' },
    directories: { document_root_is_pub: true },
    install: { date: pv('install.date') || '' },
    system: { default: systemDefault },
  };
  if (pv('downloadable_domains') !== undefined) {
    env.downloadable_domains = pv('downloadable_domains');
  }

  return `<?php\nreturn ${phpExport(env, 0)};\n`;
}
