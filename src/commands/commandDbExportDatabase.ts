import { COMMAND_DB_EXPORT_DATABASE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { exportDatabase } from '../modules/dbExport';

export default checkCommand({
  id: COMMAND_DB_EXPORT_DATABASE,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target) {
      return;
    }
    await exportDatabase(target);
  },
});
