import * as vscode from 'vscode';
import * as path from 'path';
import createFileHandler from './createFileHandler';
import { getSshClient } from '../core/sshAccess';
import { shellSingle } from '../core/dbExec';
import { formatBytes } from '../ui/transferFormat';
import { parseDu, walkSize } from './getSizeCore';

// Fast path: ask the server for the total via `du -sb`. Returns null when there
// is no SSH exec channel (FTP) or `du` produced no numeric output (missing /
// non-GNU du), signalling the caller to fall back to a client-side walk.
async function tryDuSize(fileService: any, config: any, remotePath: string): Promise<number | null> {
  if (config.protocol && config.protocol !== 'sftp') {
    return null;
  }
  try {
    const ssh = await getSshClient(fileService, config);
    const res = await ssh.exec(`du -sb ${shellSingle(remotePath)} 2>/dev/null`);
    const out = (res.stdout || '').trim();
    // Trust du's number even on a non-zero exit (partial permission errors
    // still print a valid total); only fall back when there's no number at all.
    if (/^\d+/.test(out)) {
      return parseDu(out);
    }
    return null;
  } catch {
    return null;
  }
}

export const getSize = createFileHandler({
  name: 'get size',
  async handle() {
    const remotePath = this.target.remoteFsPath;
    const name = path.basename(remotePath) || remotePath;
    const fileService = this.fileService;
    const config = this.config;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Get Size: ${name}`,
        cancellable: true,
      },
      async (progress, token) => {
        let bytes = await tryDuSize(fileService, config, remotePath);

        if (bytes == null) {
          const remoteFs = await fileService.getRemoteFileSystem(config);
          let last = 0;
          bytes = await walkSize(remoteFs, remotePath, {
            isCancelled: () => token.isCancellationRequested,
            onProgress: (seen, total) => {
              const now = Date.now();
              if (now - last > 300) {
                last = now;
                progress.report({
                  message: `Scanning… ${seen} items, ${formatBytes(total)} so far`,
                });
              }
            },
          });
        }

        if (token.isCancellationRequested) {
          return;
        }

        vscode.window.showInformationMessage(
          `${name} — ${formatBytes(bytes)} (${bytes.toLocaleString()} bytes)`
        );
      }
    );
  },
});
