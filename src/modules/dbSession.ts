import * as vscode from 'vscode';
import { getAllFileService } from './serviceManager';
import { DatabaseConfig } from '../core/dbClient';
import { DbNode } from './dbExplorer';

export interface DbTarget {
  fileService: any;
  config: any;
  dbConfig: DatabaseConfig;
  table?: string;
}

// Binds an (untitled) .sql document to the database its queries run against.
const bindings = new Map<string, DbTarget>();

export function bindDoc(uri: vscode.Uri, target: DbTarget) {
  bindings.set(uri.toString(), target);
}

export function getBinding(uri: vscode.Uri): DbTarget | undefined {
  return bindings.get(uri.toString());
}

export function targetFromNode(node?: DbNode): DbTarget | undefined {
  if (node && node.dbConfig) {
    return {
      fileService: node.fileService,
      config: node.config,
      dbConfig: node.dbConfig,
      table: node.table,
    };
  }
  return undefined;
}

function eachDatabase(): DbTarget[] {
  const targets: DbTarget[] = [];
  getAllFileService().forEach(fileService => {
    let config: any;
    try {
      config = fileService.getConfig();
    } catch (e) {
      return;
    }
    const dbs = config.database;
    if (!Array.isArray(dbs)) {
      return;
    }
    dbs.forEach((dbConfig: DatabaseConfig) =>
      targets.push({ fileService, config, dbConfig })
    );
  });
  return targets;
}

// Resolve a target: from the clicked tree node, or prompt across all configured databases.
export async function resolveTarget(node?: DbNode): Promise<DbTarget | undefined> {
  const fromNode = targetFromNode(node);
  if (fromNode) {
    return fromNode;
  }

  const targets = eachDatabase();
  if (targets.length === 0) {
    vscode.window.showInformationMessage('No "database" entries found in any sftp.json config.');
    return undefined;
  }
  if (targets.length === 1) {
    return targets[0];
  }

  const picked = await vscode.window.showQuickPick(
    targets.map(t => ({
      label: t.dbConfig.label || t.dbConfig.name,
      description: `${t.config.name || t.config.host}`,
      target: t,
    })),
    { placeHolder: 'Select a database' }
  );
  return picked ? picked.target : undefined;
}
