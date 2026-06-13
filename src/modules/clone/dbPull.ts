import * as path from 'path';
import * as fse from 'fs-extra';
import app from '../../app';
import { SSHClient } from '../../core/remote-client';
import { getDbClient } from '../../core/dbConnectionManager';
import { buildMysqldumpCommand, shellSingle } from '../../core/dbExec';
import { downloadRemoteFile } from './download';
import { remoteTmpDir, remoteTmpFile } from './remoteTmp';
import { resolveNoDataTables, fmtBytes } from './noData';
import * as localDb from './localDb';
import { PlatformAdapter } from './types';
import { ResolvedClone } from './cloneConfig';

interface Progress {
  report(v: { message?: string }): void;
}

export function cloneStorageDir(): string {
  return path.join(app.context.globalStoragePath, 'clone');
}
function snapshotDir(rc: ResolvedClone): string {
  return path.join(cloneStorageDir(), 'snapshots', rc.key.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

export async function pullDatabase(
  ssh: SSHClient,
  fileService: any,
  config: any,
  rc: ResolvedClone,
  adapter: PlatformAdapter | undefined,
  progress: Progress,
  now: string
): Promise<{ snapshot: string | null; noDataCount: number }> {
  const liveDb = rc.liveDb;
  if (!liveDb) {
    throw new Error('No `database` entry in sftp.json for this connection — add the live DB credentials.');
  }
  if (!(await localDb.ping(rc.localDb))) {
    throw new Error(
      `Local MySQL is not reachable at ${rc.localDb.host} as ${rc.localDb.username}. ` +
        `Start it (e.g. "brew services start mysql") or fix the sftp.clone.localDb setting.`
    );
  }

  // Resolve structure-only tables from the live table list (no SQL LIKE escaping needed).
  const client = getDbClient(fileService, config, liveDb);
  const allTables = await client.listTables();
  const noData = adapter ? resolveNoDataTables(allTables, adapter.noDataPatterns(), rc.dbExcludes) : rc.dbExcludes;

  const id = `${rc.name}-${now}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const remoteTmp = remoteTmpFile(rc.remotePath, `${id}.sql.gz`);
  const dumpCmd = buildMysqldumpCommand(liveDb, noData);

  try {
    progress.report({ message: `Dumping database on the server (${allTables.length} tables, ${noData.length} structure-only)…` });
    const dump = await ssh.exec(`mkdir -p ${shellSingle(remoteTmpDir(rc.remotePath))} && ${dumpCmd} | gzip > ${shellSingle(remoteTmp)}`);
    if (dump.code !== 0) {
      throw new Error(`mysqldump failed: ${dump.stderr.trim() || 'exit ' + dump.code}`);
    }

    const localGz = path.join(cloneStorageDir(), 'tmp', `${id}.sql.gz`);
    fse.ensureDirSync(path.dirname(localGz));
    progress.report({ message: 'Downloading dump…' });
    await downloadRemoteFile(fileService, config, remoteTmp, localGz, b =>
      progress.report({ message: `Downloading dump… ${fmtBytes(b)}` })
    );

    progress.report({ message: 'Snapshotting local database…' });
    const snap = await localDb.snapshot(rc.localDb, snapshotDir(rc), now);

    progress.report({ message: `Importing into ${rc.localDb.name}…` });
    await localDb.createDatabase(rc.localDb);
    await localDb.importGz(rc.localDb, localGz);

    try {
      fse.removeSync(localGz);
    } catch (e) {
      /* ignore */
    }
    return { snapshot: snap, noDataCount: noData.length };
  } finally {
    // always remove the remote temp archive (pull-only safety)
    try {
      await ssh.exec(`rm -f ${shellSingle(remoteTmp)}`);
    } catch (e) {
      /* ignore */
    }
  }
}
