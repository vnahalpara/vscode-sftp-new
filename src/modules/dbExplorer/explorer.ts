import * as vscode from 'vscode';
import { COMMAND_DB_REFRESH } from '../../constants';
import { registerCommand } from '../../host';
import DbTreeDataProvider, { DbNode } from './treeDataProvider';

export default class DbExplorer {
  private _provider: DbTreeDataProvider;
  private _view: vscode.TreeView<DbNode>;

  constructor(context: vscode.ExtensionContext) {
    this._provider = new DbTreeDataProvider();
    this._view = vscode.window.createTreeView('dbExplorer', {
      treeDataProvider: this._provider,
      showCollapseAll: true,
    });
    context.subscriptions.push(this._view);

    registerCommand(context, COMMAND_DB_REFRESH, (node?: DbNode) => this._provider.refresh(node));
  }

  refresh(node?: DbNode) {
    this._provider.refresh(node);
  }
}
