import { COMMAND_RECONNECT } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService } from '../modules/serviceManager';
import { showInformationMessage, showErrorMessage } from '../host';
import app from '../app';
import logger from '../logger';

export default checkCommand({
  id: COMMAND_RECONNECT,

  async handleCommand() {
    const pending = getAllFileService()
      .map(service => {
        try {
          return service.reconnect();
        } catch (error) {
          logger.error(error, 'reconnect');
          return null;
        }
      })
      .filter(Boolean) as Promise<any>[];

    if (pending.length === 0) {
      showInformationMessage('SFTP: no active connection to reconnect.');
      return;
    }

    app.sftpBarItem.showMsg('reconnecting...');
    try {
      await Promise.all(pending);
      app.sftpBarItem.showMsg('reconnected', 2000 * 2);
    } catch (error) {
      app.sftpBarItem.reset();
      showErrorMessage(`SFTP reconnect failed: ${(error as Error).message}`);
    }
  },
});
