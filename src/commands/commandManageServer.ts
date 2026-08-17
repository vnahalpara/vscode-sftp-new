import * as vscode from 'vscode';
import { COMMAND_MANAGE_SERVER } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { ensureSession, openInBrowser } from '../modules/serverManager';

async function open(fileService: any, config: any): Promise<void> {
  if (config.protocol && config.protocol !== 'sftp') {
    // FTP has no exec channel, so there is nothing to manage.
    vscode.window.showErrorMessage('Manage Server requires an SFTP (SSH) connection.');
    return;
  }
  try {
    const url = await ensureSession(fileService, config);
    await openInBrowser(url);
  } catch (error) {
    vscode.window.showErrorMessage(`Manage Server: ${(error as Error).message}`);
  }
}

export default checkCommand({
  id: COMMAND_MANAGE_SERVER,

  async handleCommand(exploreItem?: ExplorerRoot) {
    if (exploreItem && exploreItem.explorerContext) {
      const { config, fileService } = exploreItem.explorerContext;
      await open(fileService, config);
      return;
    }

    // Invoked from the command palette: pick among the SFTP connections, the
    // same way "Open SSH in Terminal" does.
    const items = getAllFileService().reduce<
      { label: string; description: string; config: any; fileService: any }[]
    >((result, fileService) => {
      const config = fileService.getConfig();
      if (config.protocol === 'sftp') {
        result.push({
          label: config.name || config.remotePath,
          description: config.host,
          config,
          fileService,
        });
      }
      return result;
    }, []);

    if (items.length <= 0) {
      vscode.window.showInformationMessage('SFTP: no SFTP connection to manage.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a connection…',
    });
    if (!picked) {
      return;
    }
    await open(picked.fileService, picked.config);
  },
});
