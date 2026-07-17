# File size in the SFTP remote explorer

**Date:** 2026-07-17
**Status:** Approved design, pending implementation

## Goal

Show each file's size (B / KB / MB / GB) on the right side of its row in the
SFTP remote explorer tree, using VS Code's dimmed `description` text. Folders
show no size. Controlled by a setting that defaults on.

## Performance (the key question)

**Zero extra network cost.** The SFTP directory listing uses ssh2 `readdir`
(`sftpFileSystem.ts:319`), which returns every entry's `size` in the **same
single round-trip** that fetches names. The tree provider already receives each
`FileEntry.size` in `getChildren` (`treeDataProvider.ts:144`) and currently
discards it. Displaying size is a purely in-memory change — no per-file
`stat()`, no added requests. Formatting cost is one number per **visible** row
(VS Code virtualizes the tree).

## Display

- File row: `description` = humanized size, e.g. `412 B`, `1.2 KB`, `24.6 MB`.
- Folder row: unchanged (no size — a listing only gives the directory-entry
  size, not recursive contents).
- Root (service) row: unchanged.
- 0-byte file: `0 B`.
- Symlink: its own entry size (whatever `readdir` reports).

Units are byte-based, uppercase (`B`/`KB`/`MB`/`GB`/`TB`), reusing
`formatBytes()` from `src/ui/transferFormat.ts` so sizes match the transfer
status bar exactly.

## Setting

`sftp.showSizeInRemoteExplorer` (boolean, **default `true`**), added to
`package.json` → `contributes.configuration.properties`. Read in `getTreeItem`
via the existing `getExtensionSetting()` helper (already used on the adjacent
line for `downloadWhenOpenInRemoteExplorer`). When `false`, no `description` is
set and the tree looks exactly as it does today.

## Components & changes

All changes are local/in-memory in `src/modules/remoteExplorer/treeDataProvider.ts`
plus one new tiny helper and the `package.json` contribution.

1. **`ExplorerChild.size`** — add `size?: number` to the interface
   (`treeDataProvider.ts:43-46`). `ExplorerRoot extends ExplorerChild`, so roots
   inherit the optional field (left unset).

2. **`getChildren` keeps + refreshes size** (`treeDataProvider.ts:157-178`) —
   when creating a new item, set `size: file.size`. When returning a cached
   `mapItem`, update `mapItem.size = file.size` so a tree refresh reflects the
   server's current size (the `_map` cache persists items across refreshes).

3. **`sizeDescription` pure helper** — new file
   `src/modules/remoteExplorer/sizeDescription.ts`:
   ```ts
   export function sizeDescription(
     opts: { isDirectory: boolean; isRoot: boolean; size?: number },
     enabled: boolean
   ): string | undefined
   ```
   Returns `formatBytes(size)` only when `enabled && !isRoot && !isDirectory &&
   typeof size === 'number'`; otherwise `undefined`. Kept separate from
   `treeDataProvider.ts` so it is unit-testable without importing `vscode`.

4. **`getTreeItem` sets description** (`treeDataProvider.ts:116-130`) — add
   `description: sizeDescription({ isDirectory: item.isDirectory, isRoot,
   size: (item as ExplorerChild).size }, getExtensionSetting().showSizeInRemoteExplorer)`.

## Testing

- **Unit** (`sizeDescription-test.ts`): file with size → `formatBytes` output;
  folder → `undefined`; root → `undefined`; `enabled === false` → `undefined`;
  `size === 0` → `'0 B'`; `size` undefined → `undefined`.
- **Manual (F5)**: open a remote folder — files show sizes, folders don't;
  toggle `sftp.showSizeInRemoteExplorer` off → sizes disappear; refresh after a
  file changes size → updated value shown.

## Non-goals

- No recursive/aggregate folder sizes (would require expensive walking).
- No column alignment control (VS Code renders `description` its own way).
- No change to sorting (still dir-first, then path).

## Version / packaging

Bump `package.json` version to **1.20.1** and rebuild the installable
`vaibhav-sftp-plus-1.20.1.vsix` via `vsce package`.
