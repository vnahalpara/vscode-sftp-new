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
): Promise<{ code: number; stderr: string; killConfirmed: Promise<boolean> | null }> {
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
      let killPromise: Promise<boolean> | null = null;
      let done = false;

      const finish = (result: {
        code: number;
        stderr: string;
        killConfirmed: Promise<boolean> | null;
      }) => {
        if (done) {
          return;
        }
        done = true;
        resolve(result);
      };

      // Scan stdout for the first line that is ONLY digits, rather than
      // assuming the PID is line 1.
      //
      // A non-interactive login shell can print before our `echo` ever runs --
      // a `.bashrc`/`.profile` that echoes, a `cd` writing the new directory
      // (CDPATH is set), a wrapper banner. Taking the first line blindly
      // parses that as the PID, fails, and permanently disables cancel for the
      // run. Scanning for a digits-only line survives anything printed ahead
      // of it.
      //
      // Capped so a server that streams unexpected output to stdout cannot
      // grow this buffer without bound; past the cap we give up on the PID
      // (cancel then reports honestly that it could not confirm a stop)
      // rather than holding the text forever.
      const PID_SCAN_LIMIT = 8192;
      stream.on('data', (chunk: Buffer) => {
        if (pid !== null) {
          // Still draining: a full channel window stalls the command.
          return;
        }
        pidText += chunk.toString('utf8');
        const lines = pidText.split('\n');
        // The last element is a partial line unless the text ended in \n;
        // leave it for the next chunk rather than parsing half a number.
        const complete = lines.slice(0, -1);
        for (const line of complete) {
          if (/^\d+$/.test(line.trim())) {
            pid = parseInt(line.trim(), 10);
            return;
          }
        }
        if (pidText.length > PID_SCAN_LIMIT) {
          pid = -1;
        }
      });

      const killRemote = () => {
        if (killPromise || pid === null || pid <= 0) {
          return;
        }
        // Runs on its OWN channel: the channel tar occupies is precisely the
        // one that will not answer. The promise is kept rather than discarded
        // so the caller can tell the user whether the remote tar was actually
        // stopped, instead of asserting it merely because a kill was sent.
        killPromise = ssh
          .exec(buildKillCommand(pid))
          .then((res: any) => (res && res.code === 0) || false)
          .catch(() => false);
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
        finish({ code: code || 0, stderr: errorTail, killConfirmed: killPromise })
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
          // Await the kill's own exit status rather than asserting a stop
          // because a kill was DISPATCHED. If the second channel failed, or no
          // PID was ever seen, the remote tar may still be running -- and a
          // user told "stopped" would have no reason to go and look. The
          // honest message is the one that admits the uncertainty.
          const stopped = result.killConfirmed ? await result.killConfirmed : false;
          vscode.window.showInformationMessage(
            stopped
              ? 'Create tar.gz cancelled — the remote tar was stopped and the partial archive removed.'
              : 'Create tar.gz cancelled and the partial archive removed, but the remote tar could not be confirmed stopped. It may still be running on the server.'
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
