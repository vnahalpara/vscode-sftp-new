import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { getSshClient, getRemoteFs } from '../core/sshAccess';
import { buildMysqldumpCommand, buildTableDumpCommand, shellSingle } from '../core/dbExec';
import { DbTarget } from './dbSession';

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
}

// Stage the dump INSIDE remotePath so a (often chrooted) SFTP subsystem can read it back —
// the same approach the clone uses for Cloudways-style jails.
function remoteTmp(remotePath: string, name: string): { dir: string; file: string } {
  const dir = `${remotePath}/.sftp-db-export-tmp`;
  return { dir, file: `${dir}/${name}` };
}

function streamToFile(stream: NodeJS.ReadableStream, localPath: string, keepGzip: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(localPath);
    out.on('error', reject);
    out.on('finish', () => resolve());
    stream.on('error', reject);
    if (keepGzip) {
      stream.pipe(out);
    } else {
      const gunzip = zlib.createGunzip();
      gunzip.on('error', reject);
      stream.pipe(gunzip).pipe(out);
    }
  });
}

// Run mysqldump on the server, gzip it, download via SFTP, and save locally (gunzipped unless the
// chosen filename ends in .gz). The remote temp file is always cleaned up.
async function dumpAndDownload(target: DbTarget, dumpCmd: string, defaultName: string, title: string): Promise<void> {
  const { fileService, config, dbConfig } = target;
  const remotePath = config.remotePath;
  if (!remotePath) {
    vscode.window.showErrorMessage('Export needs a "remotePath" in the sftp.json config.');
    return;
  }

  const uri = await vscode.window.showSaveDialog({
    saveLabel: 'Export',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
    filters: { 'SQL dump (gzip)': ['sql.gz'], 'SQL dump': ['sql'] },
  });
  if (!uri) {
    return;
  }
  const localPath = uri.fsPath;
  const keepGzip = /\.gz$/i.test(localPath);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      async progress => {
        const ssh = await getSshClient(fileService, config);
        const { dir, file } = remoteTmp(remotePath, `${safe(dbConfig.name)}-${Date.now()}.sql.gz`);
        try {
          progress.report({ message: 'Dumping on the server…' });
          const res = await ssh.exec(`mkdir -p ${shellSingle(dir)} && ${dumpCmd} | gzip > ${shellSingle(file)}`);
          if (res.code !== 0) {
            throw new Error(res.stderr.trim() || `mysqldump failed (exit ${res.code})`);
          }
          progress.report({ message: 'Downloading…' });
          const remoteFs = await getRemoteFs(fileService, config);
          const stream = await remoteFs.get(file);
          await streamToFile(stream, localPath, keepGzip);
        } finally {
          try {
            await ssh.exec(`rm -f ${shellSingle(file)}; rmdir ${shellSingle(dir)} 2>/dev/null || true`);
          } catch (e) {
            /* best-effort cleanup */
          }
        }
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Export failed: ${(err as Error).message}`);
    return;
  }

  const action = await vscode.window.showInformationMessage(`Exported to ${localPath}`, 'Reveal');
  if (action === 'Reveal') {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(localPath));
  }
}

export async function exportDatabase(target: DbTarget): Promise<void> {
  const cmd = buildMysqldumpCommand(target.dbConfig, []);
  await dumpAndDownload(
    target,
    cmd,
    `${safe(target.dbConfig.name)}-${stamp()}.sql.gz`,
    `Export database ${target.dbConfig.name}`
  );
}

export async function exportTable(target: DbTarget, table: string): Promise<void> {
  if (!table) {
    return;
  }
  const cmd = buildTableDumpCommand(target.dbConfig, table);
  await dumpAndDownload(
    target,
    cmd,
    `${safe(target.dbConfig.name)}.${safe(table)}-${stamp()}.sql.gz`,
    `Export table ${table}`
  );
}
