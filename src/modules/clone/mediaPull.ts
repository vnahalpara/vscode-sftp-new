import * as path from 'path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import { SSHClient } from '../../core/remote-client';
import { shellSingle } from '../../core/dbExec';
import { downloadRemoteFile } from './download';
import { remoteTmpDir, remoteTmpFile } from './remoteTmp';
import { fmtBytes } from './noData';
import { run } from './localShell';
import { cloneStorageDir } from './dbPull';
import { ResolvedClone } from './cloneConfig';

interface Progress {
  report(v: { message?: string }): void;
}

// Size-first: prompt per media folder, then tar→download→extract on "Download now".
export async function pullMedia(
  ssh: SSHClient,
  fileService: any,
  config: any,
  rc: ResolvedClone,
  mediaPath: string,
  sizeBytes: number,
  progress: Progress,
  now: string
): Promise<'downloaded' | 'skipped'> {
  const choice = await vscode.window.showQuickPick(
    [`Download now (${fmtBytes(sizeBytes)})`, 'Skip for now'],
    { placeHolder: `${mediaPath} is ${fmtBytes(sizeBytes)}. How to proceed?` }
  );
  if (!choice || choice.indexOf('Skip') === 0) {
    return 'skipped';
  }

  const remoteDir = `${rc.remotePath}/${mediaPath}`;
  const id = `${rc.name}-media-${now}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const remoteTmp = remoteTmpFile(rc.remotePath, `${id}.tar.gz`);
  const localDir = path.join(rc.localPath, mediaPath);

  try {
    progress.report({ message: `Archiving ${mediaPath} on the server…` });
    const tar = await ssh.exec(
      `mkdir -p ${shellSingle(remoteTmpDir(rc.remotePath))} && tar czf ${shellSingle(remoteTmp)} -C ${shellSingle(remoteDir)} .`
    );
    if (tar.code !== 0) {
      throw new Error(`tar failed: ${tar.stderr.trim() || 'exit ' + tar.code}`);
    }

    const localTar = path.join(cloneStorageDir(), 'tmp', `${id}.tar.gz`);
    fse.ensureDirSync(path.dirname(localTar));
    progress.report({ message: `Downloading ${mediaPath}…` });
    await downloadRemoteFile(fileService, config, remoteTmp, localTar, b =>
      progress.report({ message: `Downloading ${mediaPath}… ${fmtBytes(b)}` })
    );

    progress.report({ message: `Extracting ${mediaPath}…` });
    fse.ensureDirSync(localDir);
    const ex = await run(`tar xzf ${shellSingle(localTar)} -C ${shellSingle(localDir)}`);
    if (ex.code !== 0) {
      throw new Error(`extract failed: ${ex.stderr.trim()}`);
    }
    try {
      fse.removeSync(localTar);
    } catch (e) {
      /* ignore */
    }
    return 'downloaded';
  } finally {
    try {
      await ssh.exec(`rm -f ${shellSingle(remoteTmp)}`);
    } catch (e) {
      /* ignore */
    }
  }
}
