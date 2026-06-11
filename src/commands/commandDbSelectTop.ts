import * as vscode from 'vscode';
import { COMMAND_DB_SELECT_TOP } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { getDbClient } from '../core/dbConnectionManager';
import { quoteId } from '../core/dbSearch';
import { showResult } from '../modules/dbResults';

export default checkCommand({
  id: COMMAND_DB_SELECT_TOP,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target || !target.table) {
      return;
    }
    const client = getDbClient(target.fileService, target.config, target.dbConfig);
    try {
      const res = await client.query(`SELECT * FROM ${quoteId(target.table)} LIMIT 100`);
      showResult(`${target.table} (top 100)`, { columns: res.columns, rows: res.rows }, res.durationMs);
    } catch (err) {
      vscode.window.showErrorMessage(`Select failed: ${(err as Error).message}`);
    }
  },
});
