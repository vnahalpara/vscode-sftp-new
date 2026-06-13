import { COMMAND_CLONE_PROVISION } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runProvision } from '../modules/clone/provisionFlow';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_PROVISION,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runProvision(target);
    } catch (e) {
      reportError(e, 'clone: provision');
    }
  },
});
