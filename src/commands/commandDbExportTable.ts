import * as vscode from 'vscode';
import { COMMAND_DB_EXPORT_TABLE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { getDbClient } from '../core/dbConnectionManager';
import { exportTable } from '../modules/dbExport';

export default checkCommand({
  id: COMMAND_DB_EXPORT_TABLE,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target) {
      return;
    }
    let table = target.table;
    if (!table) {
      // Invoked without a table node (e.g. command palette) — let the user pick one.
      let tables: string[];
      try {
        tables = await getDbClient(target.fileService, target.config, target.dbConfig).listTables();
      } catch (err) {
        vscode.window.showErrorMessage(`List tables: ${(err as Error).message}`);
        return;
      }
      table = await vscode.window.showQuickPick(tables, {
        placeHolder: `Export which table from ${target.dbConfig.name}?`,
      });
    }
    if (!table) {
      return;
    }
    await exportTable(target, table);
  },
});
