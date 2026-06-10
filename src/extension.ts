'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { reportError } from './helper';
import fileActivityMonitor from './modules/fileActivityMonitor';
import * as vpnTunnel from './core/vpnTunnel';
import { tryLoadConfigs } from './modules/config';
import {
  getAllFileService,
  createFileService,
  disposeFileService,
  findAllFileService,
} from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  configs.forEach(config => {
    createFileService(config, dir);
  });
}

async function setup(workspaceFolders: vscode.WorkspaceFolder[]) {
  // Load every workspace folder's config first, isolating failures so one bad
  // folder doesn't prevent the others from initializing.
  await Promise.all(
    workspaceFolders.map(folder =>
      setupWorkspaceFolder(folder.uri.fsPath).catch(error =>
        reportError(error, `setup workspace folder ${folder.uri.fsPath}`)
      )
    )
  );

  // Start watching files only after all services exist. Otherwise a config save
  // firing mid-setup would run handleConfigSave against incomplete state.
  fileActivityMonitor.init();
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  // Writable location for generated VPN tunnel configs (contains private keys).
  vpnTunnel.init(context.globalStoragePath);

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  app.sftpBarItem.show();
  app.state.subscribe(_ => {
    const currentText = app.sftpBarItem.getText();
    // current is showing profile
    if (currentText.startsWith('SFTP')) {
      app.sftpBarItem.reset();
    }
    if (app.remoteExplorer) {
      app.remoteExplorer.refresh();
    }
  });
  // Create the Remote Explorer up front so config events that fire during (or
  // right after) setup can safely refresh it. Its constructor doesn't depend on
  // any FileService existing yet.
  app.remoteExplorer = new RemoteExplorer(context);

  // Initialize/dispose services as workspace folders are added or removed at
  // runtime. Without this, folders opened after activation are ignored and
  // services for removed folders leak in the Trie.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      await Promise.all(
        event.added.map(folder =>
          setupWorkspaceFolder(folder.uri.fsPath).catch(error =>
            reportError(error, `setup workspace folder ${folder.uri.fsPath}`)
          )
        )
      );
      event.removed.forEach(folder => {
        findAllFileService(service => service.workspace === folder.uri.fsPath).forEach(
          disposeFileService
        );
      });
      if (app.remoteExplorer) {
        app.remoteExplorer.refresh();
      }
    })
  );

  try {
    await setup(workspaceFolders);
    app.remoteExplorer.refresh();
  } catch (error) {
    reportError(error);
  }
}

export function deactivate() {
  fileActivityMonitor.destory();
  getAllFileService().forEach(disposeFileService);
  vpnTunnel.disposeAll();
}
