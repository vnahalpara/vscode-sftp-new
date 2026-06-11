import { COMMAND_DB_OPEN_TABLE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { targetFromNode } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { openTableBrowser } from '../modules/dbDataBrowser';

export default checkCommand({
  id: COMMAND_DB_OPEN_TABLE,
  async handleCommand(node?: DbNode) {
    const target = targetFromNode(node);
    if (!target || !node || !node.table) {
      return;
    }
    await openTableBrowser(target, node.table);
  },
});
