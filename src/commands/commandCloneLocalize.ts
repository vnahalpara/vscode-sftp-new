import { COMMAND_CLONE_LOCALIZE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runLocalize } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_LOCALIZE,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runLocalize(target);
    } catch (e) {
      reportError(e, 'clone: localize');
    }
  },
});
