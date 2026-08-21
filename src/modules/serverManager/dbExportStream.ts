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
  write(chunk: Buffer): boolean;
  end(): void;
  // Called with a callback to invoke if the consumer goes away mid-stream --
  // routes.ts wires this to `ctx.req.on('close', fn)`. streamExport uses it
  // to stop reading the SFTP source rather than draining a dump into a
  // socket nobody is listening on, and to make sure the remote temp file
  // still gets removed (Global Constraint 7).
  onAbort(fn: () => void): void;
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
  // while it is running remotely, or once the download is streaming. It is
  // registered synchronously, before any `await`, so an abort that arrives
  // in that first window is never lost: it is recorded here and acted on
  // (destroying the stream, if one exists yet; rejecting, if there is a
  // promise waiting to hear about it) as soon as there is something to act
  // on.
  let aborted = false;
  let activeStream: NodeJS.ReadableStream | null = null;
  let onAborted: (() => void) | null = null;
  sink.onAbort(() => {
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
      throw new Error(dumped.stderr.trim() || `mysqldump failed (exit ${dumped.code})`);
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
      stream.on('data', (chunk: Buffer) => {
        sink.write(chunk);
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
