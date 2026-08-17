import * as vscode from 'vscode';
import { COMMAND_OPEN_MONITORING } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { openMonitor } from '../modules/monitor';

export default checkCommand({
  id: COMMAND_OPEN_MONITORING,

  async handleCommand(exploreItem?: ExplorerRoot) {
    if (exploreItem && exploreItem.explorerContext) {
      const { config, fileService } = exploreItem.explorerContext;
      if (config.protocol && config.protocol !== 'sftp') {
        // FTP has no exec channel, so there is no way to read /proc at all.
        vscode.window.showErrorMessage('Monitoring requires an SFTP (SSH) connection.');
        return;
      }
      await openMonitor(fileService, config);
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
      vscode.window.showInformationMessage('SFTP: no SFTP connection to monitor.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a connection…',
    });
    if (!picked) {
      return;
    }
    await openMonitor(picked.fileService, picked.config);
  },
});
