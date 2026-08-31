// Per-token concurrency accounting for anything that holds an SSH channel
// open for a session.
//
// This started life inside logFollow.ts as `createFollowLimit`, capping
// simultaneous `tail -F`/`journalctl -f` follows. It was always a generic
// per-token counter, and leaving it named for one consumer is what let the
// Terminal go uncapped for three releases while follows were bounded: the
// budget it protects is shared, so the primitive that protects it should not
// be named after a single claimant.
//
// WHAT IT PROTECTS. OpenSSH's default `MaxSessions` is 10 channels per
// connection, and every consumer on a profile shares one pooled connection.
// Exceeding it does not fail politely in the tab that did it -- it fails
// every SUBSEQUENT file transfer, `systemctl status` and metrics sample on
// that profile with "administratively prohibited", which reads as the server
// having broken rather than as this extension having opened one channel too
// many.
//
// THE BUDGET, as of the version that added the Terminal cap:
//
//   1  SFTP (the transfer connection itself)
//   1  the metrics sampler's long-lived channel
//   4  log follows            (MAX_CONCURRENT_FOLLOWS, logFollow.ts)
//   2  terminals              (MAX_CONCURRENT_TERMINALS, below)
//   2  database exec          (MAX_CONCURRENT_DB_EXEC, core/dbExecLimit.ts)
//      -- and only on the mysql-CLI fallback transport; a forwarded-TCP
//         connection uses direct-tcpip, which does NOT count against
//         MaxSessions at all.
//   +  one-shot privileged commands (systemctl, nginx -t, openssl), which
//      are transient and effectively one at a time.
//
// The worst case is therefore tight by construction rather than by accident.
// It is reached only by a session simultaneously running four follows, two
// shells, and two DB queries over a host that disables TCP forwarding -- and
// in that state it is the transient privileged command that is refused, with
// its own per-action error, rather than the long-lived channels collapsing.
export interface ChannelLimit {
  // A release function, or null when `token` is already at the cap.
  acquire(token: string): (() => void) | null;
  // Slots currently held by `token`. For tests and diagnostics only.
  active(token: string): number;
}

// A free function rather than a class so a caller can hold one instance per
// KIND of channel: the caps are independent budgets, not one shared pool, and
// a single counter would let four follows starve the terminal.
//
// Self-pruning: a token back at zero is deleted, so nothing has to remember
// to clear this on session disposal. That matters because these instances are
// module-level and outlive any one http.Server the manager binds.
export function createChannelLimit(max: number): ChannelLimit {
  const counts = new Map<string, number>();

  return {
    acquire(token: string): (() => void) | null {
      const held = counts.get(token) || 0;
      if (held >= max) {
        return null;
      }
      counts.set(token, held + 1);
      // Idempotent: teardown is one-shot today, but a double release would
      // otherwise hand this session a free slot it is not entitled to,
      // which is precisely how a cap stops being one.
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (counts.get(token) || 1) - 1;
        if (remaining <= 0) {
          counts.delete(token);
        } else {
          counts.set(token, remaining);
        }
      };
    },
    active(token: string): number {
      return counts.get(token) || 0;
    },
  };
}

// Two, not one: a second shell alongside something long-running (a build, a
// tail, an interactive mysql) is the ordinary case, and refusing it would be
// the cap making the feature worse rather than safer.
//
// Two, not four: unlike a follow, a terminal cannot MULTIPLY on its own. A
// follow can be re-opened by a client reconnect loop outrunning the close
// round trips; a shell is opened by a person clicking a tab. The cap exists
// for the accumulating case (tabs left open across a long session), not for a
// runaway one, so it can afford to be tighter.
export const MAX_CONCURRENT_TERMINALS = 2;
