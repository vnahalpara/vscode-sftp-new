# Nested sftp.json discovery — design

Date: 2026-09-03. Ships as 1.33.0.

## Goal

A workspace folder can contain many projects, each with its own `.vscode/sftp.json`. The
extension must find every such file (to a bounded depth), load each one with its own folder as
the root, keep them in sync as files are saved, created and deleted, and show them in the SFTP
Explorer and Databases views grouped by workspace folder.

## Decisions made with the user

| Question | Decision |
| --- | --- |
| Tree layout | Grouped: one node per VS Code workspace folder, servers inside. With a single workspace folder there is no group node. |
| Creating nested configs | New Explorer right-click command **SFTP: Create Config Here** on any folder. |
| Depth | Setting `sftp.configSearchDepth`, default 4; 0 = root only (today's behaviour). |

## Today

`setupWorkspaceFolder(dir)` reads only `<dir>/.vscode/sftp.json` and calls
`createFileService(config, workspace = dir)`. The prefix tree in `serviceManager` is keyed by
each service's `baseDir` (`context` resolved against `workspace`), and `getFileService(uri)` finds
the longest prefix — so nested roots already work for lookups once services exist. The watcher in
`fileActivityMonitor` already listens on `**/.vscode/sftp.json`, but its handlers resolve the file
to its VS Code **workspace folder** and dispose every service of that folder, so a nested save
replaces the parent's servers and resolves paths against the wrong folder. Activation is
`workspaceContains:.vscode/sftp.json` (root only).

## Vocabulary

- **Workspace folder**: a VS Code workspace folder (`vscode.workspace.workspaceFolders`).
- **Config file**: a `.vscode/sftp.json` anywhere under a workspace folder.
- **Config root**: the folder that holds the config file's `.vscode` directory.
- **Depth** of a config file: the number of directories between its workspace folder and its
  config root. The root-level file is depth 0; `DevServer/stathmosgroup-online/.vscode/sftp.json`
  is depth 1.

## Discovery (`src/modules/configDiscovery.ts`, pure where possible)

- `discoverConfigFiles(folder: WorkspaceFolder, depth: number): Promise<string[]>`:
  1. The root-level path `<folder>/.vscode/sftp.json` is checked directly with `pathExists`
     (unchanged behaviour, independent of search settings).
  2. When `depth > 0`: `vscode.workspace.findFiles(new RelativePattern(folder, '**/.vscode/sftp.json'), EXCLUDE_GLOB, MAX_RESULTS)`
     with `EXCLUDE_GLOB = '**/{node_modules,vendor,.git,dist,build,.cache,bower_components}/**'`
     and `MAX_RESULTS = 500`. Results are filtered with the pure `configDepth(folderPath,
     configPath)` to `<= depth`, de-duplicated against the root-level path, and sorted by path.
- Pure helpers, unit-tested: `configRootOf(configPath)` (= dirname of dirname),
  `configDepth(folderPath, configPath)` (-1 when not under the folder), `isConfigPath(fsPath)`
  (basename `sftp.json` inside a `.vscode` directory), `readDepthSetting()` clamps to 0..10.
- Every discovered file is loaded in its own `try`/`catch`; an error reports the file's path and
  does not stop the others. A log line records how many config files each folder yielded.

## Loading semantics

- `createFileService(config, configRoot, workspaceFolderPath)`: the existing `workspace`
  argument becomes the **config root**, so `context`, `privateKeyPath` and `ignoreFile` resolve
  relative to it exactly as a root-level config does. `FileService` gains
  `workspaceFolder: string` (the containing workspace folder's `fsPath`), set at creation and used
  only for grouping and for disposal when a workspace folder is removed.
- All existing consumers of `getAllFileService()` keep working: a nested config is just another
  service. Sorting inside a group stays `remoteExplorer.order`, then name.
- Two services with the same `baseDir` still collide (the README already says contexts must
  differ). The collision is now logged with both config file paths; the later one wins as today.
- `defaultProfile` handling is unchanged.

## Watching (`src/modules/fileActivityMonitor.ts`)

- The watcher glob stays `**/.vscode/sftp.json`. Save, create and delete handlers key on the
  file's **config root** (`configRootOf(uri.fsPath)`), not on its workspace folder:
  - dispose only the services whose `workspace === configRoot`;
  - on save/create, reload from that file and create its services with that root;
  - refresh both explorers.
- A file whose depth is greater than the setting is ignored by the handlers, with one
  information message per session per file: "sftp.json at <relative path> is <n> levels deep,
  beyond sftp.configSearchDepth (<d>). Raise the setting to load it."
- A file outside every workspace folder is ignored as today.
- Removing a workspace folder disposes every service whose `workspaceFolder` equals the removed
  folder's path (nested ones included). Adding a folder runs discovery on it.
- Changing `sftp.configSearchDepth` takes effect on the next reload window (documented), like
  the other `sftp.*` settings.

## Activation

`activationEvents`: replace `workspaceContains:.vscode/sftp.json` with
`workspaceContains:**/.vscode/sftp.json` (VS Code runs a bounded file search for glob patterns).

## Trees

### SFTP Explorer (`src/modules/remoteExplorer/treeDataProvider.ts`)

- New item kind `ExplorerGroup { kind: 'group'; workspaceFolder: vscode.WorkspaceFolder; isDirectory: true }`.
  Roots and children are unchanged. The `ExplorerItem` union gains the group.
- `getChildren(undefined)`: when there are 2+ workspace folders, return one group per workspace
  folder that has at least one service (folders with none are omitted), in workspace-folder
  order; otherwise return the roots as today. `getChildren(group)` returns that folder's roots.
  `getParent(root)` returns its group when grouping is active.
- `getTreeItem(group)`: label = folder name, icon `ThemeIcon('root-folder')`, `contextValue =
  'workspaceGroup'`, `collapsibleState = Expanded`. No commands on a group; the view's Refresh
  with a group selected refreshes the whole tree.
- A root's `description` becomes the config root relative to its workspace folder (empty for a
  root-level config), joined with the existing size description when that setting is on.
- `findRoot`, `_rootsMap`, `_map`, `readBytes`, `showItem` are unchanged.
- The pure grouping function `groupByWorkspaceFolder(services, folders)` lives in
  `src/modules/explorerGrouping.ts` and is unit-tested; both trees use it.

### Databases (`src/modules/dbExplorer/treeDataProvider.ts`)

- `DbNodeKind` gains `'workspace'`; same grouping rule and the same function; the workspace
  node has icon `root-folder`, `contextValue = 'workspace'`, expanded; children are the folder's
  connections. Existing menus are unaffected (their when-clauses name other kinds).

## Command: SFTP: Create Config Here

- `sftp.config.here`, title "Create Config Here", category "SFTP", `explorer/context` when
  `explorerResourceIsFolder`, argument the folder `Uri`. Runs `newConfig(folderPath)` (creates
  the template or opens the existing file). Before creating, if `configDepth` for that folder is
  greater than the setting, show a warning: "This folder is <n> levels deep; sftp.configSearchDepth
  is <d>, so the file will not be loaded until you raise the setting." and still create it.
- The existing `sftp.config` command is unchanged.

## Setting

`sftp.configSearchDepth`: integer, default 4, minimum 0, maximum 10. Description: "How many
folder levels below each workspace folder to search for .vscode/sftp.json. 0 searches only the
workspace folder itself. Reload the window after changing."

## Error handling

- A config file that fails to parse or validate reports its own path; others still load.
- Discovery failures (search error, permission) are logged and the root-level file is still
  loaded.
- The depth notice is shown at most once per file per session.

## Testing

- Jest: `configDiscovery` pure helpers (`configRootOf`, `configDepth` including Windows-style
  paths and paths outside the folder, `isConfigPath`, exclude glob constant, depth clamping);
  `explorerGrouping` (2+ folders → groups, empty folders omitted, order preserved, single folder →
  flat; a service whose root is the folder itself vs nested); the watcher's pure decision
  (`configEventTarget(uri, folders, depth)` → `{ configRoot, workspaceFolder } | 'tooDeep' |
  'outside'`); the description text for a root.
- `npm run compile` green.
- Manual smoke (user): a workspace with `hostkicker` and `DevServer`; the tab shows two groups;
  DevServer's 14 sites appear; save a nested `sftp.json` and only that site reloads; delete one
  and it disappears; upload from a file inside a nested site goes to that site's server; Create
  Config Here on a new folder.

## Out of scope

Grouping preference setting; per-folder collapse memory; multi-character depth rules per
folder; changing the `sftp.config` picker; hot-reload of the depth setting.

## Docs

README: a "Nested sftp.json files" subsection under the config documentation (discovery, depth
setting, config-root rule for relative paths, the grouped tab, Create Config Here). CHANGELOG
`## 1.33.0`. Version 1.33.0.
