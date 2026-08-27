import * as vscode from 'vscode';
import * as path from 'path';
import createFileHandler from './createFileHandler';
import { getSshClient } from '../core/sshAccess';
import { formatBytes } from '../ui/transferFormat';
import {
  archiveName,
  buildCleanupCommand,
  buildCountCommand,
  buildKillCommand,
  buildStatCommand,
  buildTarCommand,
  buildVerifyCommand,
  isDiagnosticLine,
  parseVerboseChunk,
  resolveExcludes,
  splitRemotePath,
} from './createArchiveCore';

// Ask the server how many entries tar is about to add, so the progress bar
// reports a real percentage rather than spinning indeterminately.
//
// Returns null rather than throwing when the count cannot be established
// (`find` missing, a permission error, a non-numeric answer). A missing
// denominator is not a reason to refuse to archive -- it only costs the
// percentage, and the handler degrades to reporting the running file count.
async function countEntries(ssh: any, parent: string, name: string, excludes: string[]) {
  try {
    const res = await ssh.exec(buildCountCommand(parent, name, excludes));
    const n = parseInt((res.stdout || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Run tar over a live exec channel, counting the members it reports so the
// notification can show real progress.
//
// `execStream` rather than `exec`: exec buffers until the command closes, so a
// ten-minute archive would show nothing at all until it finished, which is
// precisely the experience this feature exists to avoid.
//
// Cancellation kills the remote process by PID over a SECOND channel. Signals
// on this channel do not work -- see buildTarCommand's comment: OpenSSH
// ignores an SSH signal request on a pty-less exec, and closing our end leaves
// tar running server-side. The PID arrives as the first line of stdout.
function runTar(
  ssh: any,
  command: string,
  onFile: (name: string, count: number) => void,
  isCancelled: () => boolean
): Promise<{ code: number; stderr: string; killed: boolean }> {
  return new Promise((resolve, reject) => {
    ssh.execStream(command).then((stream: any) => {
      let carry = '';
      let count = 0;
      // Only the TAIL of stderr is kept. tar -v puts one line per member here,
      // so on a large tree the full text is tens of megabytes -- buffering it
      // to build an error message that will be truncated anyway would hold
      // that in the extension host's heap, the process the editor runs in.
      let errorTail = '';
      let pidText = '';
      let pid: number | null = null;
      let killed = false;
      let done = false;

      const finish = (result: { code: number; stderr: string; killed: boolean }) => {
        if (done) {
          return;
        }
        done = true;
        resolve(result);
      };

      // The PID line, then nothing else -- tar writes the archive to a file,
      // so stdout carries only what the wrapper echoed. Still drained either
      // way: a full channel window would stall the command.
      stream.on('data', (chunk: Buffer) => {
        if (pid !== null) {
          return;
        }
        pidText += chunk.toString('utf8');
        const nl = pidText.indexOf('\n');
        if (nl !== -1) {
          const parsed = parseInt(pidText.slice(0, nl).trim(), 10);
          pid = Number.isFinite(parsed) && parsed > 0 ? parsed : -1;
        }
      });

      const killRemote = () => {
        if (killed || pid === null || pid <= 0) {
          return;
        }
        killed = true;
        // Fire-and-forget on its own channel: the channel tar occupies is
        // precisely the one that will not answer. A failure here is reported
        // by the caller as "could not confirm", never thrown over the cancel.
        ssh.exec(buildKillCommand(pid)).catch(() => undefined);
      };

      // tar's member list and its diagnostics both arrive on stderr.
      stream.stderr.on('data', (chunk: Buffer) => {
        const parsed = parseVerboseChunk(chunk.toString('utf8'), carry);
        carry = parsed.carry;
        parsed.names.forEach(line => {
          if (isDiagnosticLine(line)) {
            errorTail = (errorTail + line + '\n').slice(-4000);
            return;
          }
          count += 1;
          onFile(line, count);
        });

        if (isCancelled()) {
          killRemote();
        }
      });

      stream.on('close', (code: number) =>
        finish({ code: code || 0, stderr: errorTail, killed })
      );
      stream.on('error', (err: Error) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
    }, reject);
  });
}

// Ask gzip whether the archive is actually intact, rather than inferring it
// from an exit code whose meaning differs between GNU tar and bsdtar.
async function archiveIsIntact(ssh: any, parent: string, file: string): Promise<boolean> {
  try {
    const res = await ssh.exec(buildVerifyCommand(parent, file));
    return /\bOK\b/.test(res.stdout || '');
  } catch {
    return false;
  }
}

async function archiveSize(ssh: any, parent: string, file: string): Promise<number> {
  try {
    const res = await ssh.exec(buildStatCommand(parent, file));
    const n = parseInt((res.stdout || '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// Best-effort removal of a partial archive. Never allowed to throw: a cleanup
// failure must not replace the cancel or the error that caused it.
async function cleanup(ssh: any, parent: string, file: string): Promise<void> {
  try {
    await ssh.exec(buildCleanupCommand(parent, file));
  } catch {
    /* the archive stays; saying so is the caller's job, not ours */
  }
}

export const createArchive = createFileHandler({
  name: 'create archive',
  async handle() {
    const remotePath = this.target.remoteFsPath;
    const folderName = path.basename(remotePath) || remotePath;
    const { parent, name } = splitRemotePath(remotePath);
    const excludes = resolveExcludes((this.config as any).archiveExcludes);
    const file = archiveName(folderName, new Date());

    // getSshClient throws a clear "requires an SFTP (SSH) connection" for an
    // FTP profile. There is no client-side fallback worth building here: a
    // download-tar-reupload round trip over FTP would move the whole tree
    // twice across the network to produce a file the server could have made
    // locally in seconds.
    const ssh = await getSshClient(this.fileService, this.config);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Create tar.gz: ${folderName}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Counting files…' });
        const total = await countEntries(ssh, parent, name, excludes);

        if (token.isCancellationRequested) {
          return;
        }

        let lastReport = 0;
        let reported = 0;
        const result = await runTar(
          ssh,
          buildTarCommand(parent, name, file, excludes),
          (entry, count) => {
            // Throttled: tar on a large tree emits thousands of lines a
            // second, and a progress.report per line floods the UI thread
            // with work that renders identically.
            const now = Date.now();
            if (now - lastReport < 120) {
              return;
            }
            lastReport = now;

            const shortName = entry.length > 48 ? `…${entry.slice(-47)}` : entry;
            if (total) {
              const pct = Math.min(99, Math.floor((count / total) * 100));
              progress.report({
                increment: pct - reported,
                message: `${pct}% — ${count.toLocaleString()} of ${total.toLocaleString()} · ${shortName}`,
              });
              reported = pct;
            } else {
              // No denominator: report honest movement rather than a fake
              // percentage. `increment` is deliberately omitted so the bar
              // stays indeterminate instead of implying progress it cannot know.
              progress.report({ message: `${count.toLocaleString()} files · ${shortName}` });
            }
          },
          () => token.isCancellationRequested
        );

        if (token.isCancellationRequested) {
          await cleanup(ssh, parent, file);
          // `killed` says a TERM/KILL was actually dispatched at a real PID.
          // Without it the archive was removed but the remote tar may still be
          // running -- saying "nothing was left behind" then would be a lie,
          // and the user would have no idea their server was still working.
          vscode.window.showInformationMessage(
            result.killed
              ? 'Create tar.gz cancelled — the remote tar was stopped and the partial archive removed.'
              : 'Create tar.gz cancelled and the partial archive removed, but the remote tar could not be confirmed stopped.'
          );
          return;
        }

        // Close the bar honestly. `pct` is capped at 99 while streaming so it
        // never claims completion before tar has closed, and the 120ms
        // throttle drops whatever updates land in the final window -- so
        // without this the notification routinely ends visibly short of full.
        if (total) {
          progress.report({ increment: 100 - reported, message: 'Finishing…' });
        }

        if (result.code !== 0) {
          // GNU tar returns 1 for "some files differ" (a log written to
          // mid-run) and 2 for a fatal error, so on GNU an exit 1 still leaves
          // a usable archive. bsdtar (libarchive -- the default on macOS and
          // the BSDs) does NOT make that distinction and returns 1 for a real
          // failure too, so trusting the code alone would report success on a
          // total failure against a non-Linux server.
          //
          // Ask gzip whether the file is actually intact instead of inferring
          // it from a code whose meaning depends on which tar is installed.
          const intact = result.code === 1 && (await archiveIsIntact(ssh, parent, file));
          if (intact) {
            const bytes = await archiveSize(ssh, parent, file);
            vscode.window.showWarningMessage(
              `${file} — ${formatBytes(bytes)}, but some files changed while being read. ` +
                `The archive is intact and was kept: ${parent}/${file}`
            );
            return;
          }
          await cleanup(ssh, parent, file);
          const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
          throw new Error(`tar failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
        }

        const bytes = await archiveSize(ssh, parent, file);
        const fullPath = `${parent}/${file}`;
        const action = await vscode.window.showInformationMessage(
          `${file} — ${formatBytes(bytes)} · ${fullPath}`,
          'Copy path'
        );
        if (action === 'Copy path') {
          await vscode.env.clipboard.writeText(fullPath);
        }
      }
    );
  },
});
