import * as vscode from 'vscode';
import { COMMAND_DB_SEARCH } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { resolveTarget } from '../modules/dbSession';
import { DbNode } from '../modules/dbExplorer';
import { getDbClient } from '../core/dbConnectionManager';
import { searchDatabase, SearchHit } from '../core/dbSearch';
import { showResult } from '../modules/dbResults';

export default checkCommand({
  id: COMMAND_DB_SEARCH,
  async handleCommand(node?: DbNode) {
    const target = await resolveTarget(node);
    if (!target) {
      return;
    }
    const term = await vscode.window.showInputBox({
      prompt: `Search "${target.dbConfig.name}" for a string`,
      ignoreFocusOut: true,
    });
    if (!term) {
      return;
    }

    const tableScope = node && node.kind === 'table' ? node.table : undefined;
    const client = getDbClient(target.fileService, target.config, target.dbConfig);
    const hits: SearchHit[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Searching ${target.dbConfig.name}`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          await searchDatabase(
            client,
            term,
            {
              maxPerTable: 50,
              concurrency: 3,
              tableFilter: tableScope ? t => t === tableScope : undefined,
            },
            (done, total) => progress.report({ message: `tables ${done}/${total} — ${hits.length} matches` }),
            newHits => hits.push(...newHits),
            () => token.isCancellationRequested
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Search failed: ${(err as Error).message}`);
        }
      }
    );

    showResult(
      `Search "${term}" in ${target.dbConfig.name}`,
      {
        columns: ['table', 'column', 'value'],
        rows: hits.map(h => [h.table, h.column, h.value]),
        footnote: `${hits.length} matches`,
      }
    );
  },
});
