import { DatabaseConfig } from '../../core/dbClient';
import { buildMysqldumpCommand, buildTableDumpCommand, shellSingle } from '../../core/dbExec';

// What streamExport needs to talk to the remote host -- deliberately NOT
// "an SSHClient and a RemoteFileSystem", so this module (and its tests) never
// have to construct either. index.ts supplies the real implementation from
// getSshClient/getRemoteFs, exactly as src/modules/dbExport.ts (the VS
// Code-side export this mirrors) does for its own dumpAndDownload.
export interface ExportDeps {
  exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  get(remoteFile: string): Promise<NodeJS.ReadableStream>;
  // config.remotePath. The dump is staged INSIDE it (not in /tmp) because a
  // chrooted SFTP subsystem -- Cloudways-style jails -- cannot read outside
  // it back over the same connection that just wrote it there.
  remotePath: string;
  randomName(): string;
}

export interface ExportTarget {
  dbConfig: DatabaseConfig;
  // null for a whole-database dump; a specific table for a single-table one.
  table: string | null;
}

// The sink streamExport writes into. Modelled on the response object rather
// than on Node's http.ServerResponse directly so this module never imports
// `http` -- routes.ts adapts ctx.res/ctx.req to this shape.
export interface ExportSink {
  // Returns exactly what http.ServerResponse#write does: false once the
  // response's internal buffer is full, meaning the caller must stop
  // pushing until the matching onDrain fires.
  write(chunk: Buffer): boolean;
  end(): void;
  // Called with a callback to invoke if the consumer goes away mid-stream --
  // routes.ts wires this to `ctx.req.on('close', fn)`. streamExport uses it
  // to stop reading the SFTP source rather than draining a dump into a
  // socket nobody is listening on, and to make sure the remote temp file
  // still gets removed (Global Constraint 7).
  //
  // NOTE: in modern Node, 'close' also fires on a normal, successful finish
  // -- not abort-only. streamExport's use of this is idempotent (see the
  // `settled` guard below) so a late, harmless firing after a clean
  // completion does not re-run the abort path.
  onAbort(fn: () => void): void;
  // Called with a callback to invoke once the consumer has drained its
  // buffer and is ready for more -- routes.ts wires this to
  // ctx.res.on('drain', fn). streamExport resumes the paused SFTP source
  // from here; see the backpressure comment on the 'data' handler below.
  onDrain(fn: () => void): void;
}

function safe(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

// The filename lands in a Content-Disposition header, so it must never carry
// a quote or a newline -- either could forge a second header. `safe` strips
// everything outside [A-Za-z0-9_.-], which rules that out along with any
// path separator.
export function exportFilename(dbName: string, table: string | null, stamp: string): string {
  const base = table ? `${safe(dbName)}.${safe(table)}` : safe(dbName);
  return `${base}-${safe(stamp)}.sql.gz`;
}

// Stage the dump INSIDE remotePath -- see ExportDeps.remotePath above.
function remoteTmp(remotePath: string, name: string): { dir: string; file: string } {
  const dir = `${remotePath}/.sftp-db-export-tmp`;
  return { dir, file: `${dir}/${name}.sql.gz` };
}

// Last line of defense for Global Constraint 1. dumpCmd (buildMysqldumpCommand/
// buildTableDumpCommand, dbExec.ts) embeds MYSQL_PWD='<password>' literally, and
// the error below is built from stderr ONLY specifically so that command
// string can never become part of it. But stderr is remote output this
// process does not control: if the target server's ~/.bashrc sets `set -x`,
// bash traces every command it runs (non-interactive ssh execution still
// sources it) onto stderr -- including this one, with the real password
// substituted in. That traced line would otherwise flow straight into the
// activity log, GET /api/activity, and the output channel. We know the exact
// password value here, so scrub every occurrence of it out before the text
// becomes an Error -- an empty password is a valid, intentionally-accepted
// config (see normaliseDatabases in dbAccess.ts) and is deliberately left
// alone rather than redacting every character of the string.
function redactPassword(text: string, password: string): string {
  if (!password) {
    return text;
  }
  return text.split(password).join('[redacted]');
}

// Pipe the SFTP download straight into the sink, unmodified: the gzip goes
// through as-is (the browser saves a .sql.gz), unlike the VS Code path,
// which optionally gunzips into a chosen local file.
//
// Cleanup runs in a `finally`, on every path out of the try -- success,
// a failed mysqldump, a failed download, and (the case the VS Code path
// never had to handle) the browser abandoning the download mid-stream.
export async function streamExport(deps: ExportDeps, target: ExportTarget, sink: ExportSink): Promise<void> {
  const { dbConfig, table } = target;
  const dumpCmd = table ? buildTableDumpCommand(dbConfig, table) : buildMysqldumpCommand(dbConfig, []);
  const { dir, file } = remoteTmp(deps.remotePath, deps.randomName());
  const cancelledError = () => new Error('The download was cancelled.');

  // aborted/activeStream/onAborted are shared with the onAbort callback
  // below, which can fire at any point -- before the dump has even started,
  // while it is running remotely, once the download is streaming, or paused
  // mid-stream waiting on backpressure. It is registered synchronously,
  // before any `await`, so an abort that arrives in that first window is
  // never lost: it is recorded here and acted on (destroying the stream, if
  // one exists yet; rejecting, if there is a promise waiting to hear about
  // it) as soon as there is something to act on. Destroying the stream
  // works the same way whether it is flowing or paused, so an abort that
  // lands while backpressure has it paused is not a special case.
  //
  // `settled` guards against the NOTE on ExportSink.onAbort above: it is set
  // once (in the `finally` below) as soon as the export is done, so a late
  // 'close' firing after a normal finish is a no-op rather than
  // re-destroying an already-finished stream or rejecting a promise nobody
  // is waiting on any more.
  let aborted = false;
  let settled = false;
  let activeStream: NodeJS.ReadableStream | null = null;
  let onAborted: (() => void) | null = null;
  sink.onAbort(() => {
    if (settled) {
      return;
    }
    aborted = true;
    if (activeStream && typeof (activeStream as any).destroy === 'function') {
      (activeStream as any).destroy();
    }
    if (onAborted) {
      onAborted();
    }
  });

  try {
    const dumped = await deps.exec(`mkdir -p ${shellSingle(dir)} && ${dumpCmd} | gzip > ${shellSingle(file)}`);
    if (dumped.code !== 0) {
      // Built from stderr ONLY -- dumpCmd embeds MYSQL_PWD='<password>' and
      // must never become part of an error message (Global Constraint 1).
      // redactPassword is the belt to that braces -- see its doc comment.
      const stderr = redactPassword(dumped.stderr.trim(), dbConfig.password);
      throw new Error(stderr || `mysqldump failed (exit ${dumped.code})`);
    }
    if (aborted) {
      throw cancelledError();
    }

    const stream = await deps.get(file);
    activeStream = stream;
    if (aborted) {
      if (typeof (stream as any).destroy === 'function') {
        (stream as any).destroy();
      }
      throw cancelledError();
    }

    await new Promise<void>((resolve, reject) => {
      onAborted = () => reject(cancelledError());

      // Backpressure. `stream` is in flowing mode (it has a 'data'
      // listener below), so without this it delivers bytes from SFTP as
      // fast as the remote host sends them regardless of whether the HTTP
      // client is reading -- silently reinstating the whole-dump-in-memory
      // buffering this streaming design exists to avoid, inside the process
      // the user's whole editor runs in. sink.write returning false means
      // the response's own buffer is full; pause the source until onDrain
      // says the consumer has caught up.
      sink.onDrain(() => {
        stream.resume();
      });

      stream.on('data', (chunk: Buffer) => {
        if (!sink.write(chunk)) {
          stream.pause();
        }
      });
      stream.on('end', () => {
        sink.end();
        resolve();
      });
      stream.on('error', (error: Error) => {
        reject(error);
      });
    });
  } finally {
    settled = true;
    onAborted = null;
    // Wrapped in its own try/catch so a cleanup failure never replaces the
    // real error (or masks a clean success).
    try {
      await deps.exec(`rm -f ${shellSingle(file)}; rmdir ${shellSingle(dir)} 2>/dev/null || true`);
    } catch (error) {
      /* best-effort cleanup */
    }
  }
}
