import { COMMAND_CLONE_RESYNC_DB } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runResyncDatabase } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_RESYNC_DB,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runResyncDatabase(target);
    } catch (e) {
      reportError(e, 'clone: resync database');
    }
  },
});
