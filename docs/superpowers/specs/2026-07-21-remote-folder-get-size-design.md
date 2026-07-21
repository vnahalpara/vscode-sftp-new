# "Get Size" for remote folders

**Date:** 2026-07-21
**Status:** Approved design, pending implementation

## Goal

Add a right-click **Get Size** command on Remote Explorer folders (and the
connection root) that computes and displays the folder's total recursive size
in B / KB / MB / GB. Size only — no file/folder counts.

## Why size needs work (and how we keep it fast)

SFTP has no "directory size" call; a client must `readdir` every subdirectory
and sum file sizes — slow on large trees (a Magento `vendor/` is 60k+ files).
The fast path avoids the client walk entirely by asking the server:

- **Fast path (SFTP/SSH):** run `du -sb <path>` server-side via the existing
  `getSshClient()` exec channel. The server computes the total locally and
  returns it in one round-trip — seconds even for huge trees. `du -sb` =
  apparent size in bytes, which matches summing `stat.size`.
- **Fallback (FTP, or `du` unavailable / non-GNU / empty output):** a
  client-side recursive `list()` walk that sums `entry.size`.

Both size and any count would require the same full traversal, so "Get Size"
does exactly one operation and reports only size (per the requirement).

## Command wiring

Follows the existing filename-convention registration (no manual list).

- `src/constants.ts`: `export const COMMAND_GET_SIZE = 'sftp.getSize';`
- `src/commands/fileCommandGetSize.ts`:
  ```ts
  export default checkFileCommand({
    id: COMMAND_GET_SIZE,
    getFileTarget: uriFromExplorerContextOrEditorContext,
    handleFile: getSize,
  });
  ```
  The `fileCommand*` filename makes `initCommands.ts` auto-register it.
- `package.json` → `contributes.commands`:
  `{ "command": "sftp.getSize", "title": "Get Size", "category": "SFTP" }`
- `package.json` → `contributes.menus` → `view/item/context` (remote-explorer
  block): `{ "command": "sftp.getSize", "group": "7_modification",
  "when": "view == remoteExplorer && viewItem != file" }` — folders + root,
  never files.

## Handler: `getSize(ctx: FileHandlerContext)`

New handler `src/fileHandlers/getSize.ts`, exported from
`src/fileHandlers/index.ts` (mirrors `downloadFolder`). Built with
`createFileHandler` so it receives `this.target`, `this.fileService`,
`this.config`.

Flow, wrapped in a cancellable progress notification:

```ts
await vscode.window.withProgress(
  { location: vscode.ProgressLocation.Notification,
    title: `Get Size: ${basename}`, cancellable: true },
  async (progress, token) => {
    const remotePath = this.target.remoteFsPath;
    let bytes = await tryDuSize(this.fileService, this.config, remotePath); // fast path, null on failure
    if (bytes == null) {
      bytes = await walkSize(this.fileService, this.config, remotePath, progress, token);
    }
    if (token.isCancellationRequested) return;
    vscode.window.showInformationMessage(`${basename} — ${formatBytes(bytes)} (${bytes.toLocaleString()} bytes)`);
  }
);
```

### Fast path: `tryDuSize(fileService, config, remotePath): Promise<number | null>`

- If `config.protocol` is not `sftp`, return `null` (no exec channel).
- `const ssh = await getSshClient(fileService, config);`
- `const res = await ssh.exec(\`du -sb ${shellSingle(remotePath)}\`);`
- If `res.code === 0`, parse leading integer from `res.stdout` via `parseDu`
  and return it. Otherwise (non-GNU `du`, permission errors, empty) return
  `null` to trigger the fallback.
- Wrap in try/catch → return `null` on any exec error.

`parseDu(out: string): number` — `const m = /^(\d+)/.exec(out.trim()); return m ? parseInt(m[1],10) : 0;`
Defined locally in `getSize.ts` (tiny; avoids coupling fileHandlers → clone
module). Returns 0 for unparseable output, which the caller treats as "use
fallback" only when `code !== 0`; a genuine `0`-byte folder still reports 0 via
the walk.

### Fallback: `walkSize(fileService, config, path, progress, token): Promise<number>`

- `const remoteFs = await fileService.getRemoteFileSystem(config);`
- Sequential depth-first recursion (one `remoteFs.list(dir)` round-trip at a
  time — safe, never floods the connection):
  ```
  async function walk(dir): Promise<number> {
    if (token.isCancellationRequested) return 0;
    let entries;
    try { entries = await remoteFs.list(dir); }
    catch { return 0; }               // permission-denied subdir → skip, continue
    let total = 0;
    for (const e of entries) {
      if (token.isCancellationRequested) break;
      total += e.size || 0;           // symlink/file contribute their own entry size
      seen += 1;
      if (e.type === FileType.Directory) total += await walk(e.fspath);
      throttledReport();              // progress.report every ~300ms
    }
    return total;
  }
  ```
- Only recurse into `FileType.Directory` — never into `SymbolicLink`, avoiding
  symlink loops.
- Throttle `progress.report({ message: \`Scanning… ${seen} items, ${formatBytes(total)} so far\` })`
  to ~300ms.

## Reuse (no new dependencies)

- `getSshClient` — `src/core/sshAccess.ts`
- `shellSingle` — `src/core/dbExec.ts` (shell single-quoting)
- `formatBytes` — `src/ui/transferFormat.ts`
- `FileType`, `FileHandlerContext`, `createFileHandler`,
  `uriFromExplorerContextOrEditorContext` — existing.

## Testing

- **Unit** (`getSize-test.ts`):
  - `parseDu`: `'123456\t/path\n'` → `123456`; `''` → `0`;
    `'du: illegal option -- b'` (non-numeric) → `0`.
  - `walkSize` against `memfs` + `localFs` (same harness as
    `transfer-test.ts`): a tree with known byte sizes sums correctly; a
    directory symlink is not followed; a nested tree totals all files.
    (Structure `walkSize` to accept an injected `remoteFs` + a no-op
    progress/token so it runs without `vscode`.)
- **Manual (F5):** right-click a folder → Get Size shows the total; verify on a
  large folder the `du` path returns quickly; on an FTP connection the walk
  path runs with progress; Cancel stops it; a file row has no Get Size option.

## Edge cases

- Non-GNU/BSD `du` (no `-b`) → non-zero exit → fallback walk.
- FTP connection → `getSshClient` throws → caught → fallback walk.
- Permission-denied subdirectory during walk → that subtree contributes 0,
  walk continues (partial total; acceptable).
- Empty folder → `0 B`.
- User cancels → no result dialog.

## Non-goals

- No file/folder counts (explicitly dropped).
- No caching of computed sizes.
- No column/inline display in the tree (this is an on-demand command).

## Version / packaging

Bump `package.json` to the next version and rebuild the installable `.vsix`
via `vsce package` (as with prior features).
