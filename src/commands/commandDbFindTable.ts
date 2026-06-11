import * as vscode from 'vscode';
import { COMMAND_DB_FIND_TABLE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { getDbClient } from '../core/dbConnectionManager';
import { openTableBrowser } from '../modules/dbDataBrowser';

export default checkCommand({
  id: COMMAND_DB_FIND_TABLE,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target) {
      return;
    }
    const client = getDbClient(target.fileService, target.config, target.dbConfig);

    let tables: string[];
    try {
      tables = await client.listTables();
    } catch (err) {
      vscode.window.showErrorMessage(`Database "${target.dbConfig.name}": ${(err as Error).message}`);
      return;
    }
    if (tables.length === 0) {
      vscode.window.showInformationMessage(`No tables in ${target.dbConfig.name}.`);
      return;
    }

    // Native live-filter list (type to filter, Enter to open) — phpMyAdmin-style.
    const picked = await vscode.window.showQuickPick(tables, {
      placeHolder: `Filter ${tables.length} tables in ${target.dbConfig.name}…`,
      matchOnDetail: true,
    });
    if (picked) {
      await openTableBrowser(target, picked);
    }
  },
});
