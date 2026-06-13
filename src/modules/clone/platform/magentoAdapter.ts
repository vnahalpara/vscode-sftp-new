import * as path from 'path';
import * as fse from 'fs-extra';
import { PlatformAdapter, DetectContext } from '../types';
import { shellSingle } from '../../../core/dbExec';
import { buildEnvPhp, searchIndexPrefix } from './magentoEnv';

// Tables whose data is regenerated/disposable — dumped structure-only (DATA skipped).
// Glob patterns (`*` = any) matched in TypeScript against the live table list.
const NO_DATA_PATTERNS = [
  '*_log',
  'report_event',
  'report_viewed_*',
  'report_compared_*',
  'catalog_compare_item',
  'customer_visitor',
  'customer_log',
  '*_session',
  'session',
  'admin_system_messages',
  'adminnotification_inbox',
  'magento_operation',
  '*_idx',
  '*_index_tmp',
  'search_query',
];

// env.php values that MUST survive a fresh import (encryption key, prefixes, etc.).
function extractPreserved(env: any): { [key: string]: any } {
  const out: { [key: string]: any } = {};
  if (!env || typeof env !== 'object') {
    return out;
  }
  const set = (key: string, value: any) => {
    if (value !== undefined) {
      out[key] = value;
    }
  };
  set('crypt.key', env.crypt && env.crypt.key);
  set('db.table_prefix', env.db && env.db.table_prefix);
  set('backend.frontName', env.backend && env.backend.frontName);
  set('downloadable_domains', env.downloadable_domains);
  set('install.date', env.install && env.install.date);
  return out;
}

export const magentoAdapter: PlatformAdapter = {
  id: 'magento2',

  noDataPatterns() {
    return NO_DATA_PATTERNS.slice();
  },

  async detectExtra(ctx: DetectContext) {
    // Use the server's own PHP to serialize env.php to JSON (reliable; no PHP parsing in TS).
    const cmd = `cd ${shellSingle(ctx.remotePath)} && php -r '$c=@include "app/etc/env.php"; echo is_array($c)?json_encode($c):"";' 2>/dev/null`;
    const r = await ctx.exec(cmd);
    let env: any = {};
    try {
      env = JSON.parse((r.stdout || '').trim() || '{}');
    } catch (e) {
      env = {};
    }
    return { preservedEnv: extractPreserved(env) };
  },

  async localize(rc: any, preserved: { [key: string]: any }) {
    const scheme: 'http' | 'https' = rc.ssl ? 'https' : 'http';
    const indexPrefix = searchIndexPrefix(rc.name);
    const contents = buildEnvPhp({
      preserved: preserved || {},
      localDb: rc.localDb,
      hostname: rc.hostname,
      scheme,
      envOverrides: (rc.magento && rc.magento.envOverrides) || {},
      indexPrefix,
    });
    const envPath = path.join(rc.localPath, 'app', 'etc', 'env.php');
    fse.ensureDirSync(path.dirname(envPath));
    fse.writeFileSync(envPath, contents, 'utf8');
    return { message: `env.php written → ${scheme}://${rc.hostname}/ (db ${rc.localDb.name}, search index "${indexPrefix}")` };
  },
};

export { extractPreserved };
