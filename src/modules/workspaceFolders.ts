import * as vscode from 'vscode';
import { GroupingFolder } from './explorerGrouping';

// The one place a vscode.WorkspaceFolder becomes a grouping record. The folder
// itself rides along so a tree can hand it back out as a node without either
// tree provider learning how grouping works.
export interface WorkspaceFolderRecord extends GroupingFolder {
  workspaceFolder: vscode.WorkspaceFolder;
}

export function workspaceFolderRecords(): WorkspaceFolderRecord[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return [];
  }
  return folders.map(folder => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
    workspaceFolder: folder,
  }));
}
