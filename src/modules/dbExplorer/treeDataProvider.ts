import * as vscode from 'vscode';
import { getAllFileService } from '../serviceManager';
import { getDbClient } from '../../core/dbConnectionManager';
import { DatabaseConfig } from '../../core/dbClient';
import { COMMAND_DB_OPEN_TABLE } from '../../constants';
import logger from '../../logger';

export type DbNodeKind = 'connection' | 'database' | 'table' | 'column';

export interface DbNode {
  kind: DbNodeKind;
  label: string;
  description?: string;
  // carried down the tree so any node can reach its connection/database
  fileService?: any;
  config?: any;
  dbConfig?: DatabaseConfig;
  table?: string;
}

function dbConfigsOf(config: any): DatabaseConfig[] {
  const dbs = config.database;
  return Array.isArray(dbs) ? dbs : [];
}

// @types/vscode 1.40 marks the ThemeIcon(id) constructor private; it is public at runtime (VS Code 1.45+).
function themeIcon(id: string): vscode.ThemeIcon {
  return new (vscode.ThemeIcon as any)(id);
}

export default class DbTreeDataProvider implements vscode.TreeDataProvider<DbNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(node?: DbNode) {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(node: DbNode): vscode.TreeItem {
    const collapsible =
      node.kind === 'column'
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.description = node.description;
    item.contextValue = node.kind;
    switch (node.kind) {
      case 'connection':
        item.iconPath = themeIcon('server-environment');
        break;
      case 'database':
        item.iconPath = themeIcon('database');
        break;
      case 'table':
        item.iconPath = themeIcon('list-flat');
        item.command = { command: COMMAND_DB_OPEN_TABLE, title: 'Open Table', arguments: [node] };
        break;
      case 'column':
        item.iconPath = themeIcon('symbol-field');
        break;
    }
    return item;
  }

  async getChildren(node?: DbNode): Promise<DbNode[]> {
    if (!node) {
      return this._connections();
    }
    switch (node.kind) {
      case 'connection':
        return this._databases(node);
      case 'database':
        return this._tables(node);
      case 'table':
        return this._columns(node);
      default:
        return [];
    }
  }

  private _connections(): DbNode[] {
    const nodes: DbNode[] = [];
    getAllFileService().forEach(fileService => {
      let config;
      try {
        config = fileService.getConfig();
      } catch (e) {
        return;
      }
      if (dbConfigsOf(config).length === 0) {
        return;
      }
      nodes.push({
        kind: 'connection',
        label: config.name || config.host,
        description: config.host,
        fileService,
        config,
      });
    });
    return nodes;
  }

  private _databases(node: DbNode): DbNode[] {
    return dbConfigsOf(node.config).map(dbConfig => ({
      kind: 'database' as DbNodeKind,
      label: dbConfig.label || dbConfig.name,
      description: dbConfig.label ? dbConfig.name : undefined,
      fileService: node.fileService,
      config: node.config,
      dbConfig,
    }));
  }

  private async _tables(node: DbNode): Promise<DbNode[]> {
    try {
      const client = getDbClient(node.fileService, node.config, node.dbConfig!);
      const tables = await client.listTables();
      return tables.map(table => ({
        kind: 'table' as DbNodeKind,
        label: table,
        fileService: node.fileService,
        config: node.config,
        dbConfig: node.dbConfig,
        table,
      }));
    } catch (err) {
      logger.error(err, 'db: list tables');
      vscode.window.showErrorMessage(
        `Database "${node.dbConfig!.name}": ${(err as Error).message}`
      );
      return [];
    }
  }

  private async _columns(node: DbNode): Promise<DbNode[]> {
    try {
      const client = getDbClient(node.fileService, node.config, node.dbConfig!);
      const columns = await client.listColumns(node.table!);
      return columns.map(col => ({
        kind: 'column' as DbNodeKind,
        label: col.name,
        description: `${col.type}${col.key === 'PRI' ? ' · PK' : ''}${col.nullable ? '' : ' · NOT NULL'}`,
        fileService: node.fileService,
        config: node.config,
        dbConfig: node.dbConfig,
        table: node.table,
      }));
    } catch (err) {
      logger.error(err, 'db: list columns');
      return [];
    }
  }
}
