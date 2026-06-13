import * as os from 'os';
import * as path from 'path';
import * as fse from 'fs-extra';
import { run, which, runInTerminal, shellSingle } from '../localShell';
import { magentoVhost, phpFpmPool } from './templates';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  fix?: string;
  // 'warn' checks surface a heads-up but never block provisioning; default is a hard requirement.
  level?: 'error' | 'warn';
}

export function siteSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export async function brewPrefix(): Promise<string> {
  const r = await run('brew --prefix');
  return r.stdout.trim() || '/opt/homebrew';
}

// Verify the local stack is ready; missing items get a `fix` command the user can run.
export async function doctor(rc: any, phpVersion: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const hasBrew = await which('brew');
  checks.push({ name: 'Homebrew', ok: hasBrew, fix: 'Install from https://brew.sh' });
  if (!hasBrew) {
    return checks;
  }
  checks.push({ name: 'nginx', ok: await which('nginx'), fix: 'brew install nginx' });
  checks.push({ name: 'mysql', ok: await which('mysql'), fix: 'brew install mysql && brew services start mysql' });

  const phpFormula = `php@${phpVersion}`;
  const phpInstalled =
    (await run(`brew list --formula 2>/dev/null | grep -qx ${shellSingle(phpFormula)} && echo yes || true`)).stdout.indexOf('yes') !== -1;
  checks.push({ name: phpFormula, ok: phpInstalled, fix: `brew install ${phpFormula}` });

  if (rc.ssl) {
    const sslOk = fse.existsSync(rc.ssl.certPath) && fse.existsSync(rc.ssl.keyPath);
    checks.push({ name: 'SSL cert', ok: sslOk, fix: 'Set sftp.clone.ssl.certPath/keyPath to an existing *.local.com cert' });
  }
  await pushSearchEngineCheck(checks, rc);
  return checks;
}

// Magento search engine reachability: reads the store's configured engine/host/port from the
// cloned DB and pings it. Warn-only — a remote/down engine shouldn't block provisioning, but the
// user gets a clear heads-up (so category/search pages aren't mysteriously broken).
async function pushSearchEngineCheck(checks: DoctorCheck[], rc: any): Promise<void> {
  try {
    const db = rc.localDb;
    const dbq = async (sql: string) =>
      (await run(
        `MYSQL_PWD=${shellSingle(db.password)} mysql --user=${shellSingle(db.username)} --host=${shellSingle(db.host)} ` +
          `-N -e ${shellSingle(sql)} ${shellSingle(db.name)} 2>/dev/null`
      )).stdout.trim();

    const engine = await dbq(`SELECT value FROM core_config_data WHERE path='catalog/search/engine' LIMIT 1`);
    if (!engine || engine === 'mysql') {
      return; // not a clone with an external search engine (or DB not imported yet)
    }
    const key = engine.indexOf('opensearch') === 0 ? 'opensearch' : engine; // opensearch | elasticsearch7 | elasticsearch8
    const host = (await dbq(`SELECT value FROM core_config_data WHERE path='catalog/search/${key}_server_hostname' LIMIT 1`)) || 'localhost';
    const port = (await dbq(`SELECT value FROM core_config_data WHERE path='catalog/search/${key}_server_port' LIMIT 1`)) || '9200';
    const reachable =
      (await run(
        `(curl -sk -o /dev/null --max-time 4 http://${host}:${port} || curl -sk -o /dev/null --max-time 4 https://${host}:${port}) && echo ok || true`
      )).stdout.indexOf('ok') !== -1;
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    checks.push({
      name: `search ${engine} @ ${host}:${port}`,
      ok: reachable,
      level: 'warn',
      fix: isLocal
        ? 'brew install opensearch && brew services start opensearch'
        : `live search host "${host}" isn't reachable locally — point catalog/search/${key}_server_hostname at localhost (or a local engine) and reindex`,
    });
  } catch (e) {
    // best-effort; never block provisioning on the search probe
  }
}

export interface ProvisionResult {
  message: string;
  vhostPath: string;
  poolPath: string;
  socket: string;
  hostsTerminal: boolean;
}

// Write the php-fpm pool + nginx vhost (user-owned brew prefix, no sudo), validate nginx config,
// restart php-fpm; the privileged steps (/etc/hosts + nginx on :443) run in a visible terminal.
export async function provision(rc: any, phpVersion: string): Promise<ProvisionResult> {
  const prefix = await brewPrefix();
  const owner = os.userInfo().username;
  const slug = siteSlug(rc.name);

  const siteDir = path.join(os.homedir(), '.sftp-clone', slug);
  fse.ensureDirSync(siteDir);
  const socket = path.join(siteDir, 'php-fpm.sock');

  // php-fpm pool
  const poolDir = path.join(prefix, 'etc', 'php', phpVersion, 'php-fpm.d');
  fse.ensureDirSync(poolDir);
  const poolPath = path.join(poolDir, `${slug}.conf`);
  fse.writeFileSync(poolPath, phpFpmPool({ name: slug, socket, owner }));

  // nginx vhost
  const serversDir = path.join(prefix, 'etc', 'nginx', 'servers');
  fse.ensureDirSync(serversDir);
  const vhostPath = path.join(serversDir, `${slug}.conf`);
  fse.writeFileSync(
    vhostPath,
    magentoVhost({
      hostname: rc.hostname,
      magentoRoot: rc.localPath,
      fpmSocket: socket,
      mageMode: 'developer',
      ssl: rc.ssl,
    })
  );

  // make sure nginx.conf includes servers/*
  const nginxConf = path.join(prefix, 'etc', 'nginx', 'nginx.conf');
  let includesServers = true;
  try {
    includesServers = /include\s+servers\/\*/.test(fse.readFileSync(nginxConf, 'utf8'));
  } catch (e) {
    includesServers = false;
  }

  // validate config
  const test = await run('nginx -t 2>&1');
  if (test.code !== 0) {
    throw new Error(`nginx config test failed:\n${test.stdout.trim()}`);
  }

  // restart php-fpm + nginx (both run as user-level brew LaunchAgents on macOS — no root needed)
  await run(`brew services restart ${shellSingle('php@' + phpVersion)}`);
  await run('brew services restart nginx');

  // privileged: only the /etc/hosts entry needs root -> one visible terminal command (sudo password)
  const hostsLine = `127.0.0.1 ${rc.hostname}`;
  const hasHost = (await run(`grep -qF ${shellSingle(rc.hostname)} /etc/hosts && echo yes || true`)).stdout.indexOf('yes') !== -1;
  if (!hasHost) {
    runInTerminal(`provision ${rc.name}`, `echo ${shellSingle(hostsLine)} | sudo tee -a /etc/hosts`);
  }

  const notes: string[] = [];
  if (!includesServers) {
    notes.push(`add "include servers/*;" to the http{} block of ${nginxConf}`);
  }
  return {
    message:
      `Wrote vhost + php-fpm pool and restarted php-fpm + nginx.` +
      (hasHost
        ? ` Ready.`
        : ` Finish in the opened terminal: enter your password to add the /etc/hosts entry.`) +
      (notes.length ? ` Note: ${notes.join('; ')}.` : ''),
    vhostPath,
    poolPath,
    socket,
    hostsTerminal: !hasHost,
  };
}
