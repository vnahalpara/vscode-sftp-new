import { COMMAND_CLONE_CREATE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runCreate } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_CREATE,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runCreate(target);
    } catch (e) {
      reportError(e, 'clone: create');
    }
  },
});
