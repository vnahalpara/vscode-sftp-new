import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_CONFIG_HERE, CONFIG_PATH } from '../constants';
import { newConfig } from '../modules/config';
import { showOpenDialog, showWarningMessage } from '../host';
import { configDepth } from '../modules/configPaths';
import { readDepthSetting } from '../modules/configDiscovery';
import { checkCommand } from './abstract/createCommand';

// The palette has no folder to work with. An open-folder dialog, not a pick
// from the workspace folders: the point of this command is a folder INSIDE a
// workspace folder, and a workspace-folder pick is what `sftp.config` already
// does.
async function pickFolder(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  const resources = await showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: folders && folders.length > 0 ? folders[0].uri : undefined,
    openLabel: 'Create Config Here',
  });

  return resources && resources.length > 0 ? resources[0] : undefined;
}

export default checkCommand({
  id: COMMAND_CONFIG_HERE,

  async handleCommand(uri?: vscode.Uri) {
    const folderUri = uri instanceof vscode.Uri ? uri : await pickFolder();
    if (!folderUri) {
      return;
    }

    const folderPath = folderUri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
    if (workspaceFolder) {
      const allowed = readDepthSetting();
      const depth = configDepth(
        workspaceFolder.uri.fsPath,
        path.join(folderPath, CONFIG_PATH)
      );
      // Warn, then create anyway: the file is what the user asked for, and a
      // setting they can raise is a better answer than a refusal.
      if (depth > allowed) {
        await showWarningMessage(
          `This folder is ${depth} levels deep; sftp.configSearchDepth is ${allowed}, ` +
            'so the file will not be loaded until you raise the setting.'
        );
      }
    }

    return newConfig(folderPath);
  },
});
