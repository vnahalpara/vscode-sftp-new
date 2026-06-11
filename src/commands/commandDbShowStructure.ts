import * as vscode from 'vscode';
import { COMMAND_DB_SHOW_STRUCTURE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { getDbClient } from '../core/dbConnectionManager';
import { showResult } from '../modules/dbResults';

export default checkCommand({
  id: COMMAND_DB_SHOW_STRUCTURE,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target || !target.table) {
      return;
    }
    const client = getDbClient(target.fileService, target.config, target.dbConfig);
    try {
      const cols = await client.listColumns(target.table);
      showResult(`${target.table} structure`, {
        columns: ['name', 'type', 'nullable', 'key'],
        rows: cols.map(c => [c.name, c.type, c.nullable ? 'YES' : 'NO', c.key]),
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Structure failed: ${(err as Error).message}`);
    }
  },
});
