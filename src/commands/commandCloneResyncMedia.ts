import { COMMAND_CLONE_RESYNC_MEDIA } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { runResyncMedia } from '../modules/clone/cloneOrchestrator';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_CLONE_RESYNC_MEDIA,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    try {
      await runResyncMedia(target);
    } catch (e) {
      reportError(e, 'clone: resync media');
    }
  },
});
