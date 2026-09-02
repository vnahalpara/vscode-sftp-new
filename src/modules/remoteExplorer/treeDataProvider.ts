import * as vscode from 'vscode';
import {
  upath,
  UResource,
  Resource,
  FileService,
  FileType,
  FileEntry,
  Ignore,
  ServiceConfig,
} from '../../core';
import {
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_REMOTEEXPLORER_EDITINLOCAL,
} from '../../constants';
import { getAllFileService } from '../serviceManager';
import { getExtensionSetting } from '../ext';
import { relativeConfigRootLabel } from '../configPaths';
import { groupByWorkspaceFolder, shouldGroup } from '../explorerGrouping';
import { workspaceFolderRecords } from '../workspaceFolders';
import { sizeDescription } from './sizeDescription';

type Id = number;

const previewDocumentPathPrefix = '/~ ';

const DEFAULT_FILES_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store'];
/**
 * covert the url path for a customed docuemnt title
 *
 *  There is no api to custom title.
 *  So we change url path for custom title.
 *  This is not break anything because we get fspth from uri.query.'
 */
function makePreivewUrl(uri: vscode.Uri) {
  // const query = querystring.parse(uri.query);
  // query.originPath = uri.path;
  // query.originQuery = uri.query;

  return uri.with({
    path: previewDocumentPathPrefix + upath.basename(uri.path),
    // query: querystring.stringify(query),
  });
}

export interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
  size?: number;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
  };
}

// A workspace folder heading. It has no remote resource of its own, which is
// why every place that reaches for `.resource` has to narrow it away first.
export interface ExplorerGroup {
  kind: 'group';
  workspaceFolder: vscode.WorkspaceFolder;
  isDirectory: true;
}

export type ExplorerItem = ExplorerGroup | ExplorerRoot | ExplorerChild;

export function isExplorerGroup(item: ExplorerItem): item is ExplorerGroup {
  return (item as ExplorerGroup).kind === 'group';
}

// One place to name a codicon, so both trees build their icons the same way.
function themeIcon(id: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id);
}

function configRootDescription(root: ExplorerRoot): string | undefined {
  const fileService = root.explorerContext.fileService;
  // `workspace` is the config root; `workspaceFolder` is the folder it sits in.
  const label = relativeConfigRootLabel(fileService.workspaceFolder, fileService.workspace);
  return label === '' ? undefined : label;
}

function dirFirstSort(fileA: ExplorerChild, fileB: ExplorerChild) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}

export default class RemoteTreeData
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.TextDocumentContentProvider {
  private _roots: ExplorerRoot[] | null;
  private _rootsMap: Map<Id, ExplorerRoot> | null;
  private _groups: Map<string, ExplorerGroup> | null;
  private _map: Map<vscode.Uri['query'], ExplorerItem>;

  private _onDidChangeFolder: vscode.EventEmitter<ExplorerItem | undefined> = new vscode.EventEmitter<
    ExplorerItem | undefined
  >();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<ExplorerItem | undefined> = this._onDidChangeFolder.event;
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;

  async refresh(item?: ExplorerItem): Promise<any> {
    // refresh root
    if (!item) {
      // clear cache
      this._roots = null;
      this._rootsMap = null;
      this._groups = null;

      // undefined means "the whole tree changed" to VS Code -- the caches
      // were just cleared, so that is exactly the message. The emitter is typed
      // to allow it rather than cast around it.
      this._onDidChangeFolder.fire(undefined);
      return;
    }

    // A group owns no resource; firing it is enough to have VS Code re-ask for
    // its children.
    if (isExplorerGroup(item)) {
      this._onDidChangeFolder.fire(item);
      return;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children.forEach(child => {
        if (!isExplorerGroup(child) && !child.isDirectory) {
          this._onDidChangeFile.fire(makePreivewUrl(child.resource.uri));
        }
      });
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(makePreivewUrl(item.resource.uri));
    }
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    if (isExplorerGroup(item)) {
      return {
        label: item.workspaceFolder.name,
        iconPath: themeIcon('root-folder'),
        contextValue: 'workspaceGroup',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      };
    }

    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel;
    if (isRoot) {
      customLabel = (item as ExplorerRoot).explorerContext.fileService.name;
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }
    return {
      label: customLabel,
      resourceUri: item.resource.uri,
      // A root says WHERE its config lives -- empty for a root-level one.
      // sizeDescription has always returned undefined for a root, so there is
      // nothing of it to keep here.
      description: isRoot
        ? configRootDescription(item as ExplorerRoot)
        : sizeDescription(
            { isDirectory: item.isDirectory, isRoot, size: (item as ExplorerChild).size },
            getExtensionSetting().showSizeInRemoteExplorer
          ),
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: isRoot ? 'root' : item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getTopLevel();
    }

    if (isExplorerGroup(item)) {
      const folderPath = item.workspaceFolder.uri.fsPath;
      return this._getRoots().filter(
        root => root.explorerContext.fileService.workspaceFolder === folderPath
      );
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resource.uri}.`);
    }
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const fileEntries = await remotefs.list(item.resource.fsPath);

    const filesExcludeList: string[] =
      config.remoteExplorer && config.remoteExplorer.filesExclude
        ? config.remoteExplorer.filesExclude.concat(DEFAULT_FILES_EXCLUDE)
        : DEFAULT_FILES_EXCLUDE;

    const ignore = new Ignore(filesExcludeList);
    function filterFile(file: FileEntry) {
      const relativePath = upath.relative(config.remotePath, file.fspath);
      return !ignore.ignores(relativePath);
    }

    // Annotated, so the cached-item branch is checked against ExplorerChild
    // rather than widening the array to ExplorerItem and pushing a group into
    // dirFirstSort's parameter type. Nothing a remote listing produces is a
    // group.
    const children: ExplorerChild[] = fileEntries.filter(filterFile).map(file => {
      const isDirectory = file.type === FileType.Directory;
      const newResource = UResource.updateResource(item.resource, {
        remotePath: file.fspath,
      });
      const mapItem = this._map.get(newResource.uri.query);
      if (mapItem) {
        // keep the size current across refreshes (the cache persists items)
        (mapItem as ExplorerChild).size = file.size;
        return mapItem as ExplorerChild;
      } else {
        const newItem = {
          resource: UResource.updateResource(item.resource, {
            remotePath: file.fspath,
          }),
          isDirectory,
          size: file.size,
        };
        this._map.set(newItem.resource.uri.query, newItem);
        return newItem;
      }
    });

    return children.sort(dirFirstSort);
  }

  async getParent(item: ExplorerItem): Promise<ExplorerItem | undefined> {
    if (isExplorerGroup(item)) {
      return undefined;
    }

    if ((item as ExplorerRoot).explorerContext !== undefined) {
      const records = workspaceFolderRecords();
      if (!shouldGroup(records)) {
        return undefined;
      }
      const folderPath = (item as ExplorerRoot).explorerContext.fileService.workspaceFolder;
      const owner = records.filter(record => record.fsPath === folderPath)[0];
      return owner ? this._groupFor(owner.workspaceFolder) : undefined;
    }

    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${resourceUri}.`);
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }

  findRoot(uri: vscode.Uri): ExplorerRoot | null | undefined {
    if (!this._rootsMap) {
      return null;
    }

    const rootId = UResource.makeResource(uri).remoteId;
    return this._rootsMap.get(rootId);
  }

  // The raw bytes of a remote resource. Split out of provideTextDocumentContent
  // so a BINARY consumer -- the PDF viewer -- can read a `remote:` URI without
  // going through a text decode that would mangle it. Same root lookup, same
  // remote filesystem, same read; only the final toString() is the text
  // provider's own concern.
  async readBytes(uri: vscode.Uri): Promise<Uint8Array> {
    const root = this.findRoot(uri);
    if (!root) {
      throw new Error(`Can't find remote for resource ${uri}.`);
    }
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const content = await remotefs.readFile(UResource.makeResource(uri).fsPath);
    // The remote filesystem's readFile is typed string | Buffer. A binary
    // consumer needs bytes either way; a string here would be a text
    // transport's doing, and re-encoding it is the only honest conversion.
    return typeof content === 'string' ? Buffer.from(content) : content;
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<string> {
    return (await this.readBytes(uri)).toString();
  }

  showItem(item: ExplorerItem): void {
    if (isExplorerGroup(item) || item.isDirectory) {
      return;
    }

    // `vscode.open`, not showTextDocument. showTextDocument goes straight to
    // the TEXT editor and never consults the custom-editor associations, so
    // a remote PDF opened this way rendered as binary garbage and a remote
    // README bypassed the Markdown viewer. `vscode.open` resolves the editor
    // the same way a click in the file explorer does -- custom editors
    // included -- and falls through to the text editor for everything else,
    // which is exactly what showTextDocument did.
    vscode.commands.executeCommand('vscode.open', makePreivewUrl(item.resource.uri));
  }

  private _getTopLevel(): ExplorerItem[] {
    const roots = this._getRoots();
    const records = workspaceFolderRecords();
    if (!shouldGroup(records)) {
      return roots;
    }

    return groupByWorkspaceFolder(
      roots,
      root => root.explorerContext.fileService.workspaceFolder,
      records
    ).map(group => this._groupFor(group.folder.workspaceFolder));
  }

  // Cached because VS Code identifies tree nodes by object identity: getParent
  // has to hand back the same group object getChildren produced, or reveal and
  // targeted refresh miss it.
  private _groupFor(folder: vscode.WorkspaceFolder): ExplorerGroup {
    if (!this._groups) {
      this._groups = new Map();
    }
    const key = folder.uri.fsPath;
    const existing = this._groups.get(key);
    if (existing) {
      return existing;
    }
    const group: ExplorerGroup = {
      kind: 'group',
      workspaceFolder: folder,
      isDirectory: true,
    };
    this._groups.set(key, group);
    return group;
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    this._map = new Map();
    getAllFileService().forEach(fileService => {
      const config = fileService.getConfig();
      const id = fileService.id;
      const item = {
        resource: UResource.makeResource({
          remote: {
            host: config.host,
            port: config.port,
          },
          fsPath: config.remotePath,
          remoteId: id,
        }),
        isDirectory: true,
        explorerContext: {
          fileService,
          config,
          id,
        },
      };
      this._roots!.push(item);
      this._rootsMap!.set(id, item);
      this._map.set(item.resource.uri.query, item);
    });
    this._roots.sort((a,b) => a.explorerContext.config.remoteExplorer.order - b.explorerContext.config.remoteExplorer.order || a.explorerContext.fileService.name.localeCompare(b.explorerContext.fileService.name));
    return this._roots;
  }
}
