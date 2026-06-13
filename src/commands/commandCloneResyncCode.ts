import { COMMAND_CLONE_RESYNC_CODE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runResyncCode } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_RESYNC_CODE,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runResyncCode(target);
    } catch (e) {
      reportError(e, 'clone: resync code');
    }
  },
});
