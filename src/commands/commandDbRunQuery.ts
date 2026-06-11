import * as vscode from 'vscode';
import { COMMAND_DB_RUN_QUERY } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getBinding, resolveTarget, bindDoc } from '../modules/dbSession';
import { getDbClient } from '../core/dbConnectionManager';
import { showResult } from '../modules/dbResults';
import { splitStatements, applyDefaultLimit, hasWhere } from '../core/dbSql';

export default checkCommand({
  id: COMMAND_DB_RUN_QUERY,
  async handleCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let target = getBinding(editor.document.uri);
    if (!target) {
      target = await resolveTarget(undefined);
      if (!target) {
        return;
      }
      bindDoc(editor.document.uri, target);
    }

    const selection = editor.selection;
    const text = !selection.isEmpty ? editor.document.getText(selection) : editor.document.getText();
    const statements = splitStatements(text);
    if (statements.length === 0) {
      return;
    }

    const client = getDbClient(target.fileService, target.config, target.dbConfig);
    const limit = vscode.workspace.getConfiguration('sftp.db').get<number>('defaultLimit', 500);

    let lastResult;
    let lastSql = '';
    for (const raw of statements) {
      if (/^\s*(update|delete)\b/i.test(raw) && !hasWhere(raw)) {
        const verb = raw.trim().split(/\s+/)[0].toUpperCase();
        const ok = await vscode.window.showWarningMessage(
          `Run ${verb} without a WHERE clause? This affects every row.`,
          { modal: true },
          'Run'
        );
        if (ok !== 'Run') {
          return;
        }
      }
      const sql = applyDefaultLimit(raw, limit);
      lastSql = sql;
      try {
        lastResult = await client.query(sql);
      } catch (err) {
        vscode.window.showErrorMessage(`Query failed: ${(err as Error).message}`);
        return;
      }
    }

    if (!lastResult) {
      return;
    }
    if (lastResult.columns.length) {
      showResult(lastSql.slice(0, 60), { columns: lastResult.columns, rows: lastResult.rows }, lastResult.durationMs);
    } else {
      vscode.window.showInformationMessage(
        `OK — ${lastResult.affectedRows} row(s) affected (${lastResult.durationMs} ms)`
      );
    }
  },
});
