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
import { configEventTarget, ConfigEventFolder } from './configPaths';
import { readDepthSetting } from './configDiscovery';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';

let workspaceWatcher: vscode.Disposable;
let configWatcher: vscode.FileSystemWatcher;
// One notice per file per session, as the spec asks: a too-deep file is saved
// as often as any other, and a modal-adjacent toast on every keystroke's save
// would be worse than the file not loading.
const tooDeepNotified = new Set<string>();

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
  if (tooDeepNotified.has(configPath)) {
    return;
  }
  tooDeepNotified.add(configPath);
  showInformationMessage(
    `sftp.json at ${vscode.workspace.asRelativePath(configPath)} is ${actual} levels deep, ` +
      `beyond sftp.configSearchDepth (${allowed}). Raise the setting to load it.`
  );
}

async function handleConfigSave(uri: vscode.Uri) {
  const allowed = readDepthSetting();
  const target = configEventTarget(uri.fsPath, workspaceFolderPaths(), allowed);
  if (target.kind === 'outside') {
    return;
  }
  if (target.kind === 'tooDeep') {
    noticeTooDeep(uri.fsPath, target.depth, allowed);
    return;
  }

  // Only this file's own services. Keying on the workspace folder, as this used
  // to, replaced every sibling project's servers on any nested save.
  findAllFileService(service => service.workspace === target.configRoot).forEach(
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
  if (target.kind === 'outside') {
    return;
  }
  if (target.kind === 'tooDeep') {
    // Nothing was loaded from it, so there is nothing to dispose -- but a
    // deleted file should not keep its notice, in case it comes back.
    tooDeepNotified.delete(uri.fsPath);
    return;
  }

  tooDeepNotified.delete(uri.fsPath);
  findAllFileService(service => service.workspace === target.configRoot).forEach(
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
    onDidSaveSftpConfig: handleConfigSave,
  });

  // onDidSaveTextDocument only fires for documents open in the editor, so a
  // config file created (or deleted) outside the editor — e.g. via the file
  // explorer, a terminal, or git — is missed. A FileSystemWatcher catches those.
  if (configWatcher) {
    configWatcher.dispose();
  }
  configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
  configWatcher.onDidCreate(handleConfigSave);
  configWatcher.onDidDelete(handleConfigDelete);
}

function destory() {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }
  if (configWatcher) {
    configWatcher.dispose();
  }
  tooDeepNotified.clear();
}

export default {
  init,
  destory,
};
