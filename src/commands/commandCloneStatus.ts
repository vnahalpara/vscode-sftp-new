import { COMMAND_CLONE_STATUS } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { showCloneStatus } from '../modules/clone/statusPanel';

export default checkCommand({
  id: COMMAND_CLONE_STATUS,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    showCloneStatus(target);
  },
});
