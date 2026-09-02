'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { reportError } from './helper';
import fileActivityMonitor from './modules/fileActivityMonitor';
import * as vpnTunnel from './core/vpnTunnel';
import * as serverManager from './modules/serverManager';
import { readConfigsFromFile } from './modules/config';
import { configRootOf } from './modules/configPaths';
import { discoverConfigFiles, readDepthSetting } from './modules/configDiscovery';
import {
  getAllFileService,
  createFileService,
  disposeFileService,
  findAllFileService,
} from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';
import DbExplorer from './modules/dbExplorer';
import * as dbConnectionManager from './core/dbConnectionManager';
import { MarkdownViewerProvider } from './modules/markdown/viewer';
import { PdfViewerProvider } from './modules/pdf/viewer';
import { CsvEditorProvider } from './modules/csv/editor';

async function setupWorkspaceFolder(folder: vscode.WorkspaceFolder) {
  const folderPath = folder.uri.fsPath;
  const configFiles = await discoverConfigFiles(
    { name: folder.name, fsPath: folderPath },
    readDepthSetting()
  );

  // One try/catch per file: a nested project with a broken sftp.json must cost
  // the user that project, not every other project in the folder.
  for (const configFile of configFiles) {
    try {
      const configs = await readConfigsFromFile(configFile);
      const configRoot = configRootOf(configFile);
      configs.forEach(config => createFileService(config, configRoot, folderPath));
    } catch (error) {
      reportError(error, `load config ${configFile}`);
    }
  }
}

async function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  // Load every workspace folder's config first, isolating failures so one bad
  // folder doesn't prevent the others from initializing.
  await Promise.all(
    workspaceFolders.map(folder =>
      setupWorkspaceFolder(folder).catch(error =>
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
  app.context = context;
  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  // Writable location for generated VPN tunnel configs (contains private keys).
  // "sftp.vpn.*" is read once here rather than on every acquire()/release(),
  // matching how sftp.printDebugLog/sftp.debug are documented: change it, then
  // reload window.
  const vpnSettings = vscode.workspace.getConfiguration('sftp.vpn');
  vpnTunnel.init(context.globalStoragePath, {
    portRange: vpnSettings.get<string>('portRange'),
    keepAlive: vpnSettings.get<boolean>('keepAlive', true),
  });
  serverManager.init(context.extensionPath);

  // Registered here, ABOVE the workspace-folder early return below, on
  // purpose. Everything after that return is SFTP machinery that needs an
  // sftp.json to mean anything; the Markdown viewer needs only an .md file.
  // Registering it after the return would make it silently absent in every
  // workspace without a profile, and the customEditors contribution in
  // package.json would then point at a viewType nothing ever provided.
  context.subscriptions.push(MarkdownViewerProvider.register(context));
  // Same placement, same reason. The PDF viewer's only tie to the SFTP
  // machinery is reading a `remote:` URI, and that is resolved LAZILY through
  // app.remoteExplorer at read time: the explorer is constructed further down,
  // only in a workspace that has a profile, but a `remote:` URI can only ever
  // come from that explorer -- so by the time one is opened, it exists. The
  // guard is for the honest error, not for a case that can actually occur.
  context.subscriptions.push(
    PdfViewerProvider.register(context, {
      readRemote: async uri => {
        if (!app.remoteExplorer) {
          throw new Error('The Remote Explorer is not open, so this remote file cannot be read.');
        }
        return app.remoteExplorer.readBytes(uri);
      },
    })
  );
  // Same placement, same reason as the two viewers above: a .csv file needs
  // no sftp.json, so registering after the workspace-folder return would make
  // the grid silently absent in every workspace without a profile while
  // package.json still claimed the viewType.
  context.subscriptions.push(CsvEditorProvider.register(context));

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
  app.dbExplorer = new DbExplorer(context);

  // Initialize/dispose services as workspace folders are added or removed at
  // runtime. Without this, folders opened after activation are ignored and
  // services for removed folders leak in the Trie.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      await Promise.all(
        event.added.map(folder =>
          setupWorkspaceFolder(folder).catch(error =>
            reportError(error, `setup workspace folder ${folder.uri.fsPath}`)
          )
        )
      );
      event.removed.forEach(folder => {
        // workspaceFolder, not workspace: a nested service's `workspace` is its
        // own config root, so keying on it would leave every nested service of
        // a removed folder behind in the Trie.
        findAllFileService(
          service => service.workspaceFolder === folder.uri.fsPath
        ).forEach(disposeFileService);
      });
      if (app.remoteExplorer) {
        app.remoteExplorer.refresh();
      }
      if (app.dbExplorer) {
        app.dbExplorer.refresh();
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
  // serverManager BEFORE dbConnectionManager: an export in flight in the
  // Database tab reaches its cleanup in a `finally` (dbExportStream.ts)
  // whether it finishes, fails, or is aborted -- and that cleanup runs an
  // exec over the connection dbConnectionManager pools. Tearing the pool
  // down first has the cleanup exec reach an already-dying connection, which
  // fails and is swallowed by its own best-effort catch, leaving the remote
  // temp file behind. Disposing serverManager first lets any in-flight
  // request settle (including that cleanup) before the pool underneath it
  // goes away.
  serverManager.disposeAll();
  dbConnectionManager.disposeAll();
}
