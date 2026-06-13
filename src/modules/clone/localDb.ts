import * as path from 'path';
import * as fse from 'fs-extra';
import { run, shellSingle } from './localShell';
import { LocalDb } from './cloneConfig';

function mysqlBase(db: LocalDb): string {
  return [
    `MYSQL_PWD=${shellSingle(db.password)}`,
    'mysql',
    `--user=${shellSingle(db.username)}`,
    `--host=${shellSingle(db.host)}`,
  ].join(' ');
}

function dumpBase(db: LocalDb): string {
  return [
    `MYSQL_PWD=${shellSingle(db.password)}`,
    'mysqldump',
    `--user=${shellSingle(db.username)}`,
    `--host=${shellSingle(db.host)}`,
    '--no-tablespaces',
    '--single-transaction',
  ].join(' ');
}

export async function ping(db: LocalDb): Promise<boolean> {
  const r = await run(`${mysqlBase(db)} -N -e ${shellSingle('SELECT 1')}`);
  return r.code === 0;
}

export async function dbExists(db: LocalDb): Promise<boolean> {
  const r = await run(`${mysqlBase(db)} -N -e ${shellSingle(`SHOW DATABASES LIKE '${db.name}'`)}`);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export async function createDatabase(db: LocalDb): Promise<void> {
  const r = await run(`${mysqlBase(db)} -e ${shellSingle('CREATE DATABASE IF NOT EXISTS `' + db.name + '`')}`);
  if (r.code !== 0) {
    throw new Error(`Could not create local database "${db.name}": ${r.stderr.trim()}`);
  }
}

export async function importGz(db: LocalDb, gzPath: string): Promise<void> {
  const r = await run(`gunzip -c ${shellSingle(gzPath)} | ${mysqlBase(db)} ${shellSingle(db.name)}`);
  if (r.code !== 0) {
    throw new Error(`Local import failed: ${r.stderr.trim()}`);
  }
}

// Snapshot the existing local DB before an import. Returns the snapshot path, or null if no DB yet.
export async function snapshot(db: LocalDb, dir: string, now: string): Promise<string | null> {
  if (!(await dbExists(db))) {
    return null;
  }
  fse.ensureDirSync(dir);
  const out = path.join(dir, `${now.replace(/[:.]/g, '-')}.sql.gz`);
  const r = await run(`${dumpBase(db)} ${shellSingle(db.name)} | gzip > ${shellSingle(out)}`);
  if (r.code !== 0) {
    try {
      fse.removeSync(out);
    } catch (e) {
      /* ignore */
    }
    throw new Error(`Local DB snapshot failed: ${r.stderr.trim()}`);
  }
  return out;
}

export async function restore(db: LocalDb, gzPath: string): Promise<void> {
  await createDatabase(db);
  await importGz(db, gzPath);
}
