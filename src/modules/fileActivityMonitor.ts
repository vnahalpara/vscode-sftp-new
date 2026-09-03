import * as vscode from 'vscode';
import logger from '../logger';
import { realpathSync } from 'fs';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  onDidOpenTextDocument,
  onDidSaveTextDocument,
  showConfirmMessage,
  showInformationMessage,
} from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { configEventTarget, pathKey, ConfigEventFolder } from './configPaths';
import { readDepthSetting } from './configDiscovery';
import { createCoalescer } from './reloadCoalescer';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';

let workspaceWatcher: vscode.Disposable;
let configWatcher: vscode.FileSystemWatcher;
// One notice per file per session, as the spec asks: a too-deep file is saved
// as often as any other, and a modal-adjacent toast on every keystroke's save
// would be worse than the file not loading.
const tooDeepNotified = new Set<string>();

// One editor save reaches us twice -- onDidSaveTextDocument AND the watcher's
// onDidChange -- and a `git checkout` can rewrite several configs at once. Two
// overlapping reloads of one file would dispose and recreate its services
// twice and log a collision that never happened, so every trigger for a file
// is collapsed into one reload of it.
const CONFIG_RELOAD_DELAY_MS = 300;
const pendingConfigUris = new Map<string, vscode.Uri>();
const configReloads = createCoalescer<string>(key => {
  const uri = pendingConfigUris.get(key);
  if (!uri) {
    return;
  }
  pendingConfigUris.delete(key);
  handleConfigSave(uri);
}, CONFIG_RELOAD_DELAY_MS);

function scheduleConfigReload(uri: vscode.Uri) {
  const key = pathKey(uri.fsPath);
  // The last Uri wins: same file, so any spelling of it resolves the same.
  pendingConfigUris.set(key, uri);
  configReloads.schedule(key);
}

// A delete beats whatever reload is still pending for that file: loading a
// file that is gone would only fail, and disposing is the answer either way.
function handleConfigRemoved(uri: vscode.Uri) {
  const key = pathKey(uri.fsPath);
  configReloads.cancel(key);
  pendingConfigUris.delete(key);
  handleConfigDelete(uri);
}

function workspaceFolderPaths(): ConfigEventFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  return folders ? folders.map(folder => ({ fsPath: folder.uri.fsPath })) : [];
}

function refreshExplorers() {
  if (app.remoteExplorer) {
    app.remoteExplorer.refresh();
  }
  if (app.dbExplorer) {
    app.dbExplorer.refresh();
  }
}

function noticeTooDeep(configPath: string, actual: number, allowed: number) {
  if (tooDeepNotified.has(pathKey(configPath))) {
    return;
  }
  tooDeepNotified.add(pathKey(configPath));
  showInformationMessage(
    `sftp.json at ${vscode.workspace.asRelativePath(configPath)} is ${actual} levels deep, ` +
      `beyond sftp.configSearchDepth (${allowed}). Raise the setting, then reload the window.`
  );
}

async function handleConfigSave(uri: vscode.Uri) {
  const allowed = readDepthSetting();
  const target = configEventTarget(uri.fsPath, workspaceFolderPaths(), allowed);
  // 'excluded' is silent like 'outside': the startup search skips node_modules
  // and friends, so loading one here would give a service the next reload drops.
  if (target.kind === 'outside' || target.kind === 'excluded') {
    return;
  }
  if (target.kind === 'tooDeep') {
    noticeTooDeep(uri.fsPath, target.depth, allowed);
    return;
  }

  // Only this file's own services. Keying on the workspace folder, as this used
  // to, replaced every sibling project's servers on any nested save.
  const configRootKey = pathKey(target.configRoot);
  findAllFileService(service => pathKey(service.workspace) === configRootKey).forEach(
    disposeFileService
  );

  try {
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config =>
      createFileService(config, target.configRoot, target.workspaceFolder)
    );
  } catch (error) {
    reportError(error, `load config ${uri.fsPath}`);
  } finally {
    refreshExplorers();
  }
}

function handleConfigDelete(uri: vscode.Uri) {
  const allowed = readDepthSetting();
  const target = configEventTarget(uri.fsPath, workspaceFolderPaths(), allowed);
  // Same silence as the save path: nothing was ever loaded from an excluded
  // folder, so there is nothing to dispose.
  if (target.kind === 'outside' || target.kind === 'excluded') {
    return;
  }
  if (target.kind === 'tooDeep') {
    // Nothing was loaded from it, so there is nothing to dispose -- but a
    // deleted file should not keep its notice, in case it comes back.
    tooDeepNotified.delete(pathKey(uri.fsPath));
    return;
  }

  tooDeepNotified.delete(pathKey(uri.fsPath));
  const configRootKey = pathKey(target.configRoot);
  findAllFileService(service => pathKey(service.workspace) === configRootKey).forEach(
    disposeFileService
  );
  refreshExplorers();
}

async function handleFileSave(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.uploadOnSave) {
    const fspath = await realpathSync.native(uri.fsPath);
    uri = vscode.Uri.file(fspath);
    logger.info(`[file-save] ${fspath}`);
    try {
      await uploadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

async function downloadOnOpen(uri: vscode.Uri) {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  if (config.downloadOnOpen) {
    if (config.downloadOnOpen === 'confirm') {
      const isConfirm = await showConfirmMessage('Do you want SFTP to download this file?');
      if (!isConfirm) return;
    }

    const fspath = uri.fsPath;
    logger.info(`[file-open] ${fspath}`);
    try {
      await downloadFile(uri);
    } catch (error) {
      logger.error(error, `download ${fspath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  }
}

function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void;
  onDidSaveSftpConfig: (uri: vscode.Uri) => void;
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }

  workspaceWatcher = onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
    if (!isValidFile(uri) || !isInWorkspace(uri.fsPath)) {
      return;
    }

    // remove staled cache
    if (app.fsCache.has(uri.fsPath)) {
      app.fsCache.del(uri.fsPath);
    }

    if (isConfigFile(uri)) {
      onDidSaveSftpConfig(uri);
      return;
    }

    onDidSaveFile(uri);
  });
}

function init() {
  onDidOpenTextDocument((doc: vscode.TextDocument) => {
    if (!isValidFile(doc.uri) || !isInWorkspace(doc.uri.fsPath)) {
      return;
    }

    downloadOnOpen(doc.uri);
  });

  watchWorkspace({
    onDidSaveFile: handleFileSave,
    onDidSaveSftpConfig: scheduleConfigReload,
  });

  // onDidSaveTextDocument only fires for documents open in the editor, so a
  // config file created, changed or deleted outside the editor — e.g. via the
  // file explorer, a terminal, or git — is missed. A FileSystemWatcher catches
  // those.
  if (configWatcher) {
    configWatcher.dispose();
  }
  configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
  configWatcher.onDidCreate(scheduleConfigReload);
  configWatcher.onDidChange(scheduleConfigReload);
  configWatcher.onDidDelete(handleConfigRemoved);
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (configWatcher) {
    configWatcher.dispose();
  }
  configReloads.dispose();
  pendingConfigUris.clear();
  tooDeepNotified.clear();
}

export default {
  init,
  destory,
};
