import * as vscode from 'vscode';
import { COMMAND_DB_NEW_QUERY } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget, bindDoc } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';

export default checkCommand({
  id: COMMAND_DB_NEW_QUERY,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: `-- ${target.dbConfig.name} (${target.config.name || target.config.host})\n-- Cmd/Ctrl+Enter to run\n\n`,
    });
    bindDoc(doc.uri, target);
    await vscode.window.showTextDocument(doc);
    vscode.window.setStatusBarMessage(`SQL bound to ${target.dbConfig.name}`, 3000);
  },
});
