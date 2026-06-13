import * as os from 'os';
import * as path from 'path';
import * as fse from 'fs-extra';
import { run, which, runInTerminal, shellSingle } from '../localShell';
import { magentoVhost, phpFpmPool } from './templates';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  fix?: string;
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
  return checks;
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

  // restart php-fpm (user-level: listens on a unix socket)
  await run(`brew services restart ${shellSingle('php@' + phpVersion)}`);

  // privileged: /etc/hosts entry + nginx on :443 needs root -> one visible terminal command
  const hostsLine = `127.0.0.1 ${rc.hostname}`;
  const hasHost = (await run(`grep -qF ${shellSingle(rc.hostname)} /etc/hosts && echo yes || true`)).stdout.indexOf('yes') !== -1;
  const parts: string[] = [];
  if (!hasHost) {
    parts.push(`echo ${shellSingle(hostsLine)} | sudo tee -a /etc/hosts`);
  }
  parts.push('sudo brew services restart nginx');
  runInTerminal(`provision ${rc.name}`, parts.join(' && '));

  const notes: string[] = [];
  if (!includesServers) {
    notes.push(`add "include servers/*;" to the http{} block of ${nginxConf}`);
  }
  return {
    message:
      `Wrote vhost + php-fpm pool and restarted php-fpm. Finish in the opened terminal ` +
      `(enter your password for /etc/hosts + nginx restart).` +
      (notes.length ? ` Note: ${notes.join('; ')}.` : ''),
    vhostPath,
    poolPath,
    socket,
    hostsTerminal: !hasHost,
  };
}
