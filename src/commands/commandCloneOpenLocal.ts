import * as vscode from 'vscode';
import { COMMAND_CLONE_OPEN_LOCAL } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveCloneTarget } from '../modules/clone/cloneSession';
import { localUrl } from '../modules/clone/cloneOrchestrator';

export default checkCommand({
  id: COMMAND_CLONE_OPEN_LOCAL,
  async handleCommand() {
    const target = await resolveCloneTarget();
    if (!target) {
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(localUrl(target)));
  },
});
