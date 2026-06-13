import { COMMAND_CLONE_RESTORE_SNAPSHOT } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runRestoreSnapshot } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_RESTORE_SNAPSHOT,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runRestoreSnapshot(target);
    } catch (e) {
      reportError(e, 'clone: restore snapshot');
    }
  },
});
