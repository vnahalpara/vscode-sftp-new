import * as path from 'path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import { getSshClient } from '../../core/sshAccess';
import { shellSingle } from '../../core/dbExec';
import { resolveClone } from './cloneConfig';
import { detect } from './detect';
import { getAdapter } from './platform';
import { pullCode } from './codePull';
import { pullDatabase, cloneStorageDir } from './dbPull';
import { pullMedia } from './mediaPull';
import { runInTerminal } from './localShell';
import * as localDb from './localDb';
import { loadState, saveState, setStep, stepDone, CloneState } from './cloneState';

function nowIso(): string {
  return new Date().toISOString();
}
function stamp(): string {
  return nowIso().replace(/[:.]/g, '-');
}

function warnUploadOnSave(fileService: any, config: any, localPath: string) {
  // uploadOnSave only acts on files saved INSIDE the workspace. If the clone lives outside
  // it (e.g. ~/Sites/...), editing it can't trigger an upload to live — so don't warn.
  if (!config.uploadOnSave) {
    return;
  }
  const ws = fileService && fileService.workspace;
  if (ws && pathsConflict(ws, localPath)) {
    vscode.window.showWarningMessage(
      `"${config.name || config.host}" has uploadOnSave enabled and the clone lives inside this workspace. ` +
        `Editing the local clone could auto-upload to the LIVE server — use a separate folder/workspace for the clone.`
    );
  }
}

function canon(p: string): string {
  return path.resolve(p).replace(/[\/\\]+$/, '');
}

// Is the codebase actually present locally? (so a stale "code: done" doesn't skip a missing pull)
function localCodePresent(rc: ReturnType<typeof resolveClone>): boolean {
  return ['composer.json', 'bin/magento', 'wp-config.php', '.git'].some(m =>
    fse.existsSync(path.join(rc.localPath, m))
  );
}

// Only pin a real major.minor (e.g. "8.3"); never write "auto"/unknown.
export function shouldPinPhpVersion(phpVersion?: string): boolean {
  return !!phpVersion && /^\d+\.\d+/.test(phpVersion);
}

// Pin the project's PHP version (for phpenv / editors / CLI) once code is on disk,
// unless the project already ships its own .php-version.
function ensurePhpVersionFile(localPath: string, phpVersion?: string): void {
  if (!shouldPinPhpVersion(phpVersion)) {
    return;
  }
  const file = path.join(localPath, '.php-version');
  if (fse.existsSync(file)) {
    return;
  }
  try {
    fse.writeFileSync(file, `${phpVersion}\n`);
  } catch (e) {
    vscode.window.showWarningMessage(`Could not write .php-version: ${(e as Error).message}`);
  }
}

// True if the two paths are the same folder, or one sits inside the other.
export function pathsConflict(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const ca = canon(a).toLowerCase();
  const cb = canon(b).toLowerCase();
  if (ca === cb) {
    return true;
  }
  return (ca + path.sep).indexOf(cb + path.sep) === 0 || (cb + path.sep).indexOf(ca + path.sep) === 0;
}

// Block cloning when the local path overlaps the live-sync context (a footgun with uploadOnSave).
function guardClonePath(fileService: any, rc: ReturnType<typeof resolveClone>): void {
  const contextAbs = fileService && fileService.baseDir;
  if (contextAbs && pathsConflict(contextAbs, rc.localPath)) {
    throw new Error(
      `Clone path conflicts with the live-sync context — they must be different folders.\n` +
        `  context (live sync): ${canon(contextAbs)}\n` +
        `  local clone path:    ${canon(rc.localPath)}\n` +
        `Update "local.path" in sftp.json to a separate folder (e.g. ~/Sites/${rc.name}).`
    );
  }
}

async function getExecCtx(fileService: any, config: any, remotePath: string) {
  const ssh = await getSshClient(fileService, config);
  return { ssh, ctx: { exec: (c: string, i?: string) => ssh.exec(c, i), remotePath } };
}

export async function runCreate(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  guardClonePath(fileService, rc);
  warnUploadOnSave(fileService, config, rc.localPath);
  const { ssh, ctx } = await getExecCtx(fileService, config, rc.remotePath);
  let state = loadState(rc.workspace, rc.key);
  const save = () => saveState(rc.workspace, rc.key, state, nowIso());

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Clone ${rc.name}`, cancellable: true },
    async (progress, token) => {
      // DETECT (always; cheap)
      progress.report({ message: 'Detecting platform & sizes…' });
      const det = await detect(ctx, rc.mediaPaths);
      state = {
        ...state,
        platform: det.platform === 'unknown' ? state.platform : det.platform,
        phpVersion: det.phpVersion,
        hasMysqldump: det.hasMysqldump,
        gitRemote: det.gitRemote,
        sizes: det.sizes,
        preservedEnv: det.preservedEnv,
        hostname: rc.hostname,
        localPath: rc.localPath,
        localDatabase: rc.localDb.name,
      };
      state = setStep(state, 'detect', 'done', nowIso());
      save();

      if (!det.hasMysqldump) {
        throw new Error('mysqldump is not installed on the server — cannot dump the database.');
      }
      if (det.platform !== 'magento2') {
        vscode.window.showWarningMessage(
          `Detected platform "${det.platform}". Phase 1 targets Magento; pulling generically (no platform-specific excludes).`
        );
      }
      const adapter = getAdapter(det.platform);

      // CODE
      if (token.isCancellationRequested) {
        return;
      }
      if (!stepDone(state, 'code') || !localCodePresent(rc)) {
        try {
          const how = await pullCode(ssh, fileService, config, rc, det.gitRemote, progress, stamp());
          state = setStep(state, 'code', 'done', nowIso(), how === 'git' ? 'git clone' : 'archive');
        } catch (e) {
          state = setStep(state, 'code', 'error', nowIso(), (e as Error).message);
          save();
          throw e;
        }
        save();
      }

      // Pin PHP version for the project once code is on disk (skips if it already has one).
      ensurePhpVersionFile(rc.localPath, det.phpVersion);

      // DB
      if (token.isCancellationRequested) {
        return;
      }
      if (!stepDone(state, 'db')) {
        const res = await runDbInto(state, fileService, config, rc, adapter, ssh, progress);
        state = res;
        save();
      }

      // MEDIA (per folder)
      for (const mp of det.mediaPaths) {
        if (token.isCancellationRequested) {
          return;
        }
        const key = `media:${mp}`;
        if (stepDone(state, key)) {
          continue;
        }
        try {
          const r = await pullMedia(ssh, fileService, config, rc, mp, det.sizes[mp] || 0, progress, stamp());
          state = setStep(state, key, r === 'downloaded' ? 'done' : 'pending', nowIso(), r);
        } catch (e) {
          state = setStep(state, key, 'error', nowIso(), (e as Error).message);
        }
        save();
      }
    }
  );

  vscode.window.showInformationMessage(
    `Clone backbone done for ${rc.name}: code/db/media pulled to ${rc.localPath}. (Serving/localize is Phase 2.)`
  );
}

async function runDbInto(state: CloneState, fileService, config, rc, adapter, ssh, progress): Promise<CloneState> {
  try {
    const res = await pullDatabase(ssh, fileService, config, rc, adapter, progress, stamp());
    return setStep(
      state,
      'db',
      'done',
      nowIso(),
      `${res.noDataCount} structure-only${res.snapshot ? `; snapshot ${path.basename(res.snapshot)}` : ''}`
    );
  } catch (e) {
    const s = setStep(state, 'db', 'error', nowIso(), (e as Error).message);
    saveState(rc.workspace, rc.key, s, nowIso());
    throw e;
  }
}

export async function runResyncDatabase(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  guardClonePath(fileService, rc);
  const { ssh, ctx } = await getExecCtx(fileService, config, rc.remotePath);
  let state = loadState(rc.workspace, rc.key);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Resync DB ${rc.name}`, cancellable: false },
    async progress => {
      progress.report({ message: 'Detecting platform…' });
      const det = await detect(ctx, rc.mediaPaths);
      const adapter = getAdapter(det.platform);
      state = await runDbInto(state, fileService, config, rc, adapter, ssh, progress);
      saveState(rc.workspace, rc.key, state, nowIso());
    }
  );
  vscode.window.showInformationMessage(`Database resynced into ${rc.localDb.name}.`);
}

export async function runResyncMedia(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  guardClonePath(fileService, rc);
  const { ssh, ctx } = await getExecCtx(fileService, config, rc.remotePath);
  let state = loadState(rc.workspace, rc.key);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Resync media ${rc.name}`, cancellable: true },
    async (progress, token) => {
      const det = await detect(ctx, rc.mediaPaths);
      for (const mp of det.mediaPaths) {
        if (token.isCancellationRequested) {
          return;
        }
        const r = await pullMedia(ssh, fileService, config, rc, mp, det.sizes[mp] || 0, progress, stamp());
        state = setStep(state, `media:${mp}`, r === 'downloaded' ? 'done' : 'pending', nowIso(), r);
        saveState(rc.workspace, rc.key, state, nowIso());
      }
    }
  );
}

export async function runResyncCode(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  guardClonePath(fileService, rc);
  if (fse.existsSync(path.join(rc.localPath, '.git'))) {
    runInTerminal(`pull ${rc.name}`, `git -C ${shellSingle(rc.localPath)} pull`);
    return;
  }
  const { ssh } = await getExecCtx(fileService, config, rc.remotePath);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Resync code ${rc.name}` },
    async progress => {
      // respect the configured method: git config -> clone/merge, else server archive
      await pullCode(ssh, fileService, config, rc, null, progress, stamp());
    }
  );
}

function snapshotDirFor(rc: ReturnType<typeof resolveClone>): string {
  return path.join(cloneStorageDir(), 'snapshots', rc.key.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

export async function runRestoreSnapshot(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  const dir = snapshotDirFor(rc);
  const files = fse.existsSync(dir)
    ? fse.readdirSync(dir).filter((f: string) => f.endsWith('.sql.gz')).sort().reverse()
    : [];
  if (!files.length) {
    vscode.window.showInformationMessage('No local DB snapshots for this site yet.');
    return;
  }
  const pick = await vscode.window.showQuickPick(files, {
    placeHolder: `Restore which snapshot into ${rc.localDb.name}? (overwrites the local DB)`,
  });
  if (!pick) {
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Overwrite local database "${rc.localDb.name}" with ${pick}?`,
    { modal: true },
    'Restore'
  );
  if (ok !== 'Restore') {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Restoring snapshot…' },
    async () => {
      await localDb.restore(rc.localDb, path.join(dir, pick));
    }
  );
  vscode.window.showInformationMessage('Snapshot restored into the local database.');
}

// Phase 2: write app/etc/env.php (localized) from the preserved layer + local config.
export async function runLocalize(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);
  guardClonePath(fileService, rc);
  const state = loadState(rc.workspace, rc.key);
  const adapter = getAdapter(state.platform || 'magento2');
  if (!adapter || !adapter.localize) {
    vscode.window.showWarningMessage(`Localize is not supported for platform "${state.platform || 'unknown'}".`);
    return;
  }
  let preserved = state.preservedEnv;
  if (!preserved || Object.keys(preserved).length === 0) {
    const { ctx } = await getExecCtx(fileService, config, rc.remotePath);
    preserved = (await detect(ctx, rc.mediaPaths)).preservedEnv;
  }
  const res = await adapter.localize(rc, preserved || {});
  saveState(rc.workspace, rc.key, setStep(state, 'localize', 'done', nowIso(), res.message), nowIso());
  vscode.window.showInformationMessage(`Localized ${rc.name}: ${res.message}`);
}

export function loadCloneState(target: { fileService: any; config: any }): { rc: ReturnType<typeof resolveClone>; state: CloneState } {
  const rc = resolveClone(target.fileService, target.config);
  return { rc, state: loadState(rc.workspace, rc.key) };
}

export function localUrl(target: { fileService: any; config: any }): string {
  const rc = resolveClone(target.fileService, target.config);
  return rc.ssl ? `https://${rc.hostname}` : `http://${rc.hostname}`;
}
