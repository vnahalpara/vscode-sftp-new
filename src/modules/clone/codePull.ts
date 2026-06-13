import * as path from 'path';
import * as fse from 'fs-extra';
import { SSHClient } from '../../core/remote-client';
import { shellSingle } from '../../core/dbExec';
import { downloadRemoteFile } from './download';
import { remoteTmpDir, remoteTmpFile, TMP_DIRNAME } from './remoteTmp';
import { fmtBytes } from './noData';
import { run, runInTerminal } from './localShell';
import { cloneStorageDir } from './dbPull';
import { ResolvedClone } from './cloneConfig';

interface Progress {
  report(v: { message?: string }): void;
}

// Embed credentials into an https git URL (for the sftp.json `git` block's token).
export function authedGitUrl(remote: string, user?: string, pass?: string): string {
  if (user && pass && /^https?:\/\//.test(remote)) {
    return remote.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
  }
  return remote;
}

// Clone into `dest`. If `dest` already has files (e.g. media pulled first), clone to a temp dir
// then merge in (git refuses a non-empty target).
async function gitCloneInto(url: string, branch: string | undefined, dest: string) {
  const branchArg = branch ? `-b ${shellSingle(branch)} ` : '';
  const empty = !fse.existsSync(dest) || fse.readdirSync(dest).length === 0;
  if (empty) {
    return run(`git clone ${branchArg}${shellSingle(url)} ${shellSingle(dest)}`);
  }
  const tmp = `${dest}.gitclone-tmp`;
  await run(`rm -rf ${shellSingle(tmp)}`);
  const cloned = await run(`git clone ${branchArg}${shellSingle(url)} ${shellSingle(tmp)}`);
  if (cloned.code !== 0) {
    await run(`rm -rf ${shellSingle(tmp)}`);
    return cloned;
  }
  // merge cloned tree (incl. .git) into the existing dest, then remove temp
  return run(`cp -a ${shellSingle(tmp)}/. ${shellSingle(dest)}/ && rm -rf ${shellSingle(tmp)}`);
}

// Pull the codebase. Prefers `git clone` (run visibly in the terminal for auth) when a remote
// exists; otherwise tar→download→extract from the server.
export async function pullCode(
  ssh: SSHClient,
  fileService: any,
  config: any,
  rc: ResolvedClone,
  gitRemote: string | null,
  progress: Progress,
  now: string
): Promise<'git' | 'archive'> {
  fse.ensureDirSync(path.dirname(rc.localPath));
  // Prefer the sftp.json `git` block (repo + token), else the server-detected remote.
  const gitCfg = (config && config.git) || {};
  const repoUrl = gitCfg.remote || gitRemote;
  const useGit = rc.codeMethod === 'git' || (rc.codeMethod === 'auto' && !!repoUrl);

  if (useGit && repoUrl) {
    const url = authedGitUrl(repoUrl, gitCfg.username, gitCfg.password);
    if (gitCfg.username && gitCfg.password) {
      // Non-interactive (token in URL): clone synchronously so later steps don't race the dir.
      progress.report({ message: 'Cloning code from git…' });
      const r = await gitCloneInto(url, gitCfg.branch, rc.localPath);
      if (r.code !== 0) {
        throw new Error(`git clone failed: ${(r.stderr || r.stdout || '').trim() || 'exit ' + r.code}`);
      }
      return 'git';
    }
    // No embedded creds: run in a visible terminal (may prompt); cannot be awaited.
    const branchArg = gitCfg.branch ? `-b ${shellSingle(gitCfg.branch)} ` : '';
    runInTerminal(`clone ${rc.name}`, `git clone ${branchArg}${shellSingle(url)} ${shellSingle(rc.localPath)}`);
    return 'git';
  }

  const id = `${rc.name}-code-${now}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const remoteTmp = remoteTmpFile(rc.remotePath, `${id}.tar.gz`);
  try {
    progress.report({ message: 'Archiving code on the server…' });
    const tar = await ssh.exec(
      `mkdir -p ${shellSingle(remoteTmpDir(rc.remotePath))} && ` +
        `tar czf ${shellSingle(remoteTmp)} --exclude=${shellSingle('./' + TMP_DIRNAME)} -C ${shellSingle(rc.remotePath)} .`
    );
    if (tar.code !== 0) {
      throw new Error(`tar failed: ${tar.stderr.trim() || 'exit ' + tar.code}`);
    }

    const localTar = path.join(cloneStorageDir(), 'tmp', `${id}.tar.gz`);
    fse.ensureDirSync(path.dirname(localTar));
    progress.report({ message: 'Downloading code…' });
    await downloadRemoteFile(fileService, config, remoteTmp, localTar, b =>
      progress.report({ message: `Downloading code… ${fmtBytes(b)}` })
    );

    progress.report({ message: 'Extracting code…' });
    fse.ensureDirSync(rc.localPath);
    const ex = await run(`tar xzf ${shellSingle(localTar)} -C ${shellSingle(rc.localPath)}`);
    if (ex.code !== 0) {
      throw new Error(`extract failed: ${ex.stderr.trim()}`);
    }
    try {
      fse.removeSync(localTar);
    } catch (e) {
      /* ignore */
    }
    return 'archive';
  } finally {
    try {
      await ssh.exec(`rm -f ${shellSingle(remoteTmp)}`);
    } catch (e) {
      /* ignore */
    }
  }
}
