// Shared concurrency cap for SSH EXEC channels opened by database
// operations. Mirrors logFollow.ts's createFollowLimit on purpose -- same
// shape (acquire() hands back a release function, or null once the cap is
// reached) and the same "refuse outright, never queue" policy: a queued DB
// request is a client sitting there with nothing happening, indistinguishable
// from a hang.
//
// WHY THIS EXISTS, and why it is applied to only PART of the DB feature:
// the mysql-CLI fallback transport (Cloudways: `AllowTcpForwarding no`) runs
// every query as `ssh.exec(...)` (DbClient._execQuery, dbClient.ts), and a
// mysqldump-based export shells out the same way for the ENTIRE duration of
// the dump (dbExportStream.ts, via the exec closure index.ts wires into
// ExportDeps) -- both open a real SSH "exec" channel, which counts against
// OpenSSH's MaxSessions (default 10) on the connection also shared by SFTP
// transfers, the metrics sampler, the privileged lane, the Terminal tab, and
// up to 4 log follows (logFollow.ts's own cap, reserved specifically to
// protect this same budget). The forwarded-TCP transport, by contrast, opens
// a `direct-tcpip` channel, which MaxSessions does NOT count -- so that path
// (the other branch of DbClient._runOnce) is never routed through this
// limiter, and must not be.
//
// Capped at 2: log follows alone already reserve 4 of the 10-channel budget,
// and an export holds its slot for MINUTES, not milliseconds. Two concurrent
// DB exec operations covers a real session (browsing a table while an export
// runs, or two quick queries back to back) while still leaving headroom for
// SFTP, the sampler, the privileged lane and the Terminal on top of the 4
// already reserved for log follows.
//
// Shared across every DbClient AND every export in the process, rather than
// one counter per DbClient instance: DbClient instances are pooled per
// (connection, database) (dbConnectionManager.ts), so a profile with two
// `database[]` entries already spends from the SAME SSH connection's budget
// through two different DbClient objects -- a per-instance counter would
// under-count. A single process-wide counter is a deliberately conservative
// simplification: it also caps unrelated profiles/connections against each
// other's exec channels, which is strictly safer than not capping them at
// all, never wrong-direction.
export const MAX_CONCURRENT_DB_EXEC = 2;

export interface DbExecLimit {
  // Carried on the object (rather than left only as a closed-over local) so
  // a caller building a refusal message -- dbExecLimitMessage below -- names
  // the limit THIS instance actually enforces, not the module's default
  // constant. That matters for tests, which construct smaller instances to
  // exercise the cap without waiting on MAX_CONCURRENT_DB_EXEC.
  readonly max: number;
  // A release function, or null when the cap is already reached.
  acquire(): (() => void) | null;
}

export function createDbExecLimit(max: number = MAX_CONCURRENT_DB_EXEC): DbExecLimit {
  let active = 0;
  return {
    max,
    acquire(): (() => void) | null {
      if (active >= max) {
        return null;
      }
      active++;
      // Idempotent, same reasoning as createFollowLimit's release: a double
      // release would hand back a slot nobody is entitled to, which is
      // precisely how a cap stops being one.
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        active--;
      };
    },
  };
}

// The process-wide default every real caller shares (DbClient's exec
// transport and the export route's dump/cleanup exec calls). Tests construct
// their own via createDbExecLimit(...) so cap behaviour can be exercised in
// isolation without cross-test interference.
export const dbExecLimit: DbExecLimit = createDbExecLimit();

// The number itself is deliberately IN the message -- unlike logFollow's
// refusal, which omits it because the cap there is threaded in by the
// caller. This message is also used directly by the export wiring in
// index.ts, which has no FollowLimit-shaped object of its own to defer to.
export function dbExecLimitMessage(max: number = MAX_CONCURRENT_DB_EXEC): string {
  return `Too many database operations are already running on this connection (limit ${max}). Wait for one to finish and try again.`;
}
