import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface LocalDb {
  host: string;
  username: string;
  password: string;
  name: string;
}

export interface ResolvedClone {
  key: string; // identity within the workspace state file
  name: string;
  workspace: string;
  remotePath: string;
  provisioner: 'native' | 'localwp';
  platform: 'auto' | 'magento2' | 'wordpress';
  hostname: string;
  localPath: string;
  phpVersion: string;
  ssl?: { certPath: string; keyPath: string };
  // null = not configured (use platform default); [] = explicitly skip media
  mediaPaths: string[] | null;
  mediaProxy: boolean;
  codeMethod: 'auto' | 'git' | 'rsync';
  dbExcludes: string[];
  localDb: LocalDb;
  magento: { envOverrides: { [k: string]: any } };
  // the live database config (first sftp.json `database` entry) used for the dump
  liveDb?: { host?: string; port?: number; username: string; password: string; name: string };
}

export function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function sanitizeDbName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

export function resolveClone(fileService: any, config: any): ResolvedClone {
  const local = config.local || {};
  const settings = vscode.workspace.getConfiguration('sftp.clone');
  const name = config.name || config.host;
  const key = config.context || config.remotePath || name;

  const domainSuffix = settings.get<string>('domainSuffix', '.local.com');
  const sitesRoot = expandHome(settings.get<string>('sitesRoot', '~/Sites'));
  const globalSsl = settings.get<{ certPath?: string; keyPath?: string }>('ssl', {}) || {};
  const globalDb = settings.get<{ host?: string; username?: string; password?: string }>('localDb', {}) || {};

  const ssl = local.ssl || globalSsl;
  const hasSsl = ssl && ssl.certPath && ssl.keyPath;

  const ld = local.database || {};
  const localDb: LocalDb = {
    host: ld.host || globalDb.host || '127.0.0.1',
    username: ld.username || globalDb.username || 'root',
    password: ld.password !== undefined ? ld.password : globalDb.password !== undefined ? globalDb.password : 'root',
    name: ld.name || sanitizeDbName(name),
  };

  const liveDb = Array.isArray(config.database) && config.database.length ? config.database[0] : undefined;

  return {
    key,
    name,
    workspace: fileService.workspace,
    remotePath: config.remotePath,
    provisioner: local.provisioner || 'native',
    platform: local.platform || 'auto',
    hostname: local.hostname || `${name}${domainSuffix}`,
    localPath: expandHome(local.path || path.join(sitesRoot, name)),
    phpVersion: local.phpVersion || 'auto',
    ssl: hasSsl ? { certPath: expandHome(ssl.certPath), keyPath: expandHome(ssl.keyPath) } : undefined,
    mediaPaths: Array.isArray(local.mediaPaths) ? local.mediaPaths : null,
    mediaProxy: local.mediaProxy !== false,
    codeMethod: local.codeMethod || 'auto',
    dbExcludes: Array.isArray(local.dbExcludes) ? local.dbExcludes : [],
    localDb,
    magento: { envOverrides: (local.magento && local.magento.envOverrides) || {} },
    liveDb,
  };
}

// Default media paths per platform when the user didn't specify any.
export function defaultMediaPaths(platform: string): string[] {
  if (platform === 'magento2') {
    return ['pub/media'];
  }
  if (platform === 'wordpress') {
    return ['wp-content/uploads'];
  }
  return [];
}
