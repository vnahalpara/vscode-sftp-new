import * as vscode from 'vscode';
import * as path from 'path';
import * as fse from 'fs-extra';
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

    // A keybinding can hand this command a file. A path that cannot be stat'ed
    // (most likely: it does not exist) is left alone, so reporting it stays
    // `newConfig`'s job, exactly as before.
    let isFolder = true;
    try {
      isFolder = (await fse.stat(folderPath)).isDirectory();
    } catch (error) {
      // Unreadable or missing: fall through and let `newConfig` deal with it.
    }
    if (!isFolder) {
      vscode.window.showInformationMessage('Select a folder to create an sftp.json in.');
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
    if (workspaceFolder) {
      const allowed = readDepthSetting();
      const depth = configDepth(
        workspaceFolder.uri.fsPath,
        path.join(folderPath, CONFIG_PATH)
      );
      // Warn, then create anyway: the file is what the user asked for, and a
      // setting they can raise is a better answer than a refusal. Not awaited:
      // a warning with no action items has no dismiss timer, so awaiting it
      // would hold the file back until the user closed the notification.
      if (depth > allowed) {
        showWarningMessage(
          `This folder is ${depth} levels deep; sftp.configSearchDepth is ${allowed}, ` +
            'so the file will not be loaded until you raise the setting.'
        );
      }
    }

    return newConfig(folderPath);
  },
});
