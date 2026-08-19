// Bridges a remote `tail -F`/`journalctl -f` process to the browser over the
// `/ws/logs` WebSocket. This is deliberately the read-only twin of
// terminal.ts's bridgeTerminal -- same teardown shape, same backpressure
// scheme, same close-reason truncation (imported, not reimplemented) -- with
// one addition terminal.ts never needed: an authorization decision. The
// upgrade itself (wsServer.ts's checkUpgrade) only proves the caller holds a
// valid session token; it says nothing about which files or units that
// caller may follow. That decision is made here, once, before anything is
// opened on the remote host.
//
// THE AUTHORIZATION MODEL, and the one thing a caller of bridgeLogFollow must
// get right:
//
//   `tail -F <path>` with a caller-chosen path is arbitrary privileged file
//   read. A path may be followed ONLY if it is in the CALLING SESSION's own
//   allowlist -- the one `GET /api/logs` seeds for that session, intersected
//   against isLogFilePath (routes.ts). `deps.isPathAllowed` is how that
//   session-scoped answer reaches this module: it must be a closure over one
//   specific session/token, never a global "is this path known to anyone"
//   predicate, or session A's discovery would authorize session B's read.
//
//   isLogFilePath is re-checked here regardless of what isPathAllowed says.
//   The allowlist is the authority, but a second lexical check costs nothing
//   and this codebase's standing convention (see ops/command.ts's
//   isLogFilePath/isConfigFilePath doc comments) is belt-and-braces: check
//   again at the point a privileged read actually happens, not only where it
//   was first discovered.
//
//   journald units go through the existing isSafeUnitName (ops/command.ts).
//   There is no allowlist for units -- validating the unit name IS the whole
//   gate, same as journalCommand/journalFollowCommand already require for a
//   one-shot read.
import { sudoHint } from './activity';
import {
  followCommand,
  isLogFilePath,
  isSafeUnitName,
  journalFollowCommand,
} from './ops/command';
import {
  BridgeStream,
  CLOSE_INTERNAL_ERROR,
  CLOSE_NORMAL,
  forwardOutput,
  releaseStream,
  truncateReason,
  WsLike,
} from './wsBridge';

export type LogTarget = { kind: 'file'; path: string } | { kind: 'unit'; unit: string };

// The structural subset of a raw ssh2 exec channel this bridge drives -- an
// interface rather than an import of ssh2's own type, for the same reason
// terminal.ts's ShellStream is one: tests hand this a plain EventEmitter-
// shaped fake instead of a live SSH channel. It is exactly wsBridge.ts's
// BridgeStream (release + flow control + the three events) and nothing more:
// this bridge is read-only, so unlike ShellStream there is no
// write()/setWindow() here.
export interface LogStream extends BridgeStream {
  // ssh2 delivers a channel's stderr on a SEPARATE readable hanging off the
  // channel, not interleaved into 'data'. Optional only because the type is
  // structural and a test fake may not need one; every real channel
  // (sshClient.ts's execStream hands back the raw ssh2 ClientChannel) has it.
  // Leaving it unread is not neutral -- see attachStderr below.
  stderr?: LogStderr;
}

export interface LogStderr {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface LogFollowDeps {
  // True when `path` is in the CALLING SESSION's own allowlist. Must be a
  // closure over one specific token/session -- see the module comment above.
  isPathAllowed(path: string): boolean;
  // The account privileged commands actually run as, and the host they run
  // on -- exactly what routes.ts passes to sudoHint via OpsDeps.user/host.
  // Only used to phrase a failure (see closeReason below): a sudo hint that
  // names the wrong account tells the operator to grant sudo to the wrong
  // user, so this must be session.profile.privilegedAs, never the session
  // username, since followCommand/journalFollowCommand run over the
  // privileged lane.
  user: string;
  host: string;
  // Reserves one of this session's concurrent-follow slots, returning the
  // function that gives it back -- or null when the session is already at
  // its cap, in which case this bridge refuses the open rather than queueing
  // it. Required, not optional: an unwired cap is no cap, and the failure it
  // prevents (see createFollowLimit) is silent until every SFTP transfer on
  // the profile starts failing.
  acquire(): (() => void) | null;
  // Opens `cmd` (already built by followCommand/journalFollowCommand, and
  // therefore already carrying its own `sudo -n`) as a raw, long-running
  // exec channel over the PRIVILEGED lane. Callers wire this to
  // session.privilegedTransport.execStream -- never the unprivileged
  // transport, and never a shell/PTY (there is no interactivity here, only a
  // single foreground process to read from).
  execStream(cmd: string): Promise<LogStream>;
}

// How many /ws/logs follows one session may hold open at once.
//
// Every follow holds an ssh2 exec channel for as long as the socket lives,
// and those channels ride the SAME pooled SSH connection as SFTP, the
// monitor sampler, the Terminal tab and every privileged one-shot command:
// with no root_user/root_password on the profile, privilegedConfig() returns
// a value-identical copy of the config, which hashes to the same pool key
// (index.ts's privilegedConnectionIsSeparate answers exactly this). OpenSSH's
// default MaxSessions is 10 channels per connection, and the failure past
// that is not confined to this tab -- it is every subsequent file transfer,
// `systemctl status` and metrics sample on the profile failing with
// "administratively prohibited".
//
// Teardown is correct on every path, but nothing bounded SIMULTANEOUS
// follows: a Logs tab following several files at once, or a client
// reconnect loop outrunning the close-frame round trips, reaches ten open
// channels without anything having leaked. `tail -F` makes that far more
// reachable than the single Terminal tab ever was.
//
// Four leaves six channels of headroom for everything else on the
// connection (SFTP, the sampler's long-lived channel, a terminal, and the
// one-shot privileged commands the other tabs issue) -- deliberately well
// under 10 rather than close to it, because this bridge is the only
// consumer here that can multiply.
export const MAX_CONCURRENT_FOLLOWS = 4;

export interface FollowLimit {
  // A release function, or null when `token` is already at the cap.
  acquire(token: string): (() => void) | null;
  // Slots currently held by `token`. For tests and diagnostics only.
  active(token: string): number;
}

// Per-token concurrency accounting for /ws/logs. Deliberately a free
// function over a private map rather than state on ManagedSession: the
// counter must fall back to zero on its own as sockets close (which is what
// makes it self-pruning -- a token at zero is deleted, so this map is
// bounded by "sessions currently following", not "tokens ever seen"), and
// nothing outside this bridge has any business adjusting it.
export function createFollowLimit(max: number = MAX_CONCURRENT_FOLLOWS): FollowLimit {
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

// How much stderr is kept for diagnosis. Only the first ~123 BYTES can ever
// reach the client (a close frame's whole reason budget), but sudoHint has
// to pattern-match over more than that, and the interesting line is not
// always the first one -- `sudo -n` writes its own failure after whatever
// the shell already said. A couple of KB is far more than any of these
// commands produces and is bounded, which matters because this is remote
// output arriving on a channel that has no other reader.
const MAX_STDERR_CHARS = 2048;

// Consume the channel's stderr. This is not merely nice diagnostics:
//
//   1. The single most common real failure of this feature -- no NOPASSWD
//      sudoers rule -- produces NOTHING on stdout. `sudo -n tail ...` writes
//      "sudo: a password is required" to stderr and exits, so the bridge
//      sees only a spontaneous channel close and, without this, reports a
//      generic "log stream closed" while the precise, fixable diagnosis sits
//      unread on the channel. Same for a file rotated away between discovery
//      and follow ("tail: cannot open ... No such file or directory").
//   2. An UNREAD stderr shares the ssh2 channel's flow-control window with
//      'data'. Never reading it puts those bytes outside the backpressure
//      scheme entirely -- ssh2 buffers them in this process, and the window
//      they occupy is window the log output does not get.
//
// Failures to attach are swallowed: a channel that is already dead cannot
// tell us anything, and it must not take the follow down with it.
function attachStderr(stream: LogStream, append: (text: string) => void): void {
  const stderr = stream.stderr;
  if (!stderr) {
    return;
  }
  try {
    stderr.on('data', chunk => append(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    // A readable that emits 'error' with no listener throws out of the event
    // loop -- an extension host crash. Same reasoning as releaseStream's.
    stderr.on('error', () => undefined);
  } catch (error) {
    // Nothing to do; the follow itself is unaffected.
  }
}

// Builds the command for `target`, having already proved it authorized to
// run. Returns null (having already torn the socket down with a reason) for
// anything that fails validation, so the caller can simply bail out on a
// null return.
function buildCommand(deps: LogFollowDeps, target: LogTarget, refuse: (reason: string) => void): string | null {
  if (target.kind === 'file') {
    // isLogFilePath first: a path that is not even shaped like something
    // under /var/log has no business being asked about the allowlist at
    // all, and this ordering matches routes.ts's own "re-check regardless"
    // discipline without implying isPathAllowed is trusted to have done it.
    if (!isLogFilePath(target.path) || !deps.isPathAllowed(target.path)) {
      refuse('That file was not returned by a log discovery scan for this session.');
      return null;
    }
    try {
      return followCommand(target.path);
    } catch (error) {
      refuse((error as Error).message);
      return null;
    }
  }

  if (!isSafeUnitName(target.unit)) {
    refuse('Unsafe unit name.');
    return null;
  }
  try {
    return journalFollowCommand(target.unit);
  } catch (error) {
    refuse((error as Error).message);
    return null;
  }
}

export function bridgeLogFollow(deps: LogFollowDeps, socket: WsLike, target: LogTarget): void {
  let stream: LogStream | null = null;
  let releaseSlot: (() => void) | null = null;
  let torndown = false;
  let stderrText = '';

  // What actually killed the follow, in the client's own close frame.
  // Without this, the commonest real failure -- `sudo -n` refusing for want
  // of a NOPASSWD rule -- reaches the user as the generic `fallback`, while
  // the fixable diagnosis stays on an unread stderr. sudoHint is the SAME
  // mapping routes.ts uses for the HTTP surface (activity.ts), not a second
  // one that could disagree with it about what a sudo failure looks like or
  // what to advise; raw stderr is the fallback when it is not a sudo
  // failure (a rotated-away file, a missing journalctl). teardown() applies
  // truncateReason, so a hint longer than a close frame's 123-byte budget is
  // cut there rather than throwing -- the first 123 bytes still name the
  // account and the problem.
  function closeReason(fallback: string): string {
    const text = stderrText.trim();
    if (!text) {
      return fallback;
    }
    return sudoHint(text, deps.user, deps.host) || text;
  }

  // Both directions end here, guarded by `torndown` so it does not matter
  // which side notices first (socket close vs. channel close/error) --
  // exactly terminal.ts's teardown() shape, because it is solving the exact
  // same problem: this runs against the user's production server, and a
  // leaked follow process is a real, ongoing cost to them.
  function teardown(code?: number, reason?: string): void {
    if (torndown) {
      return;
    }
    torndown = true;
    if (stream) {
      releaseStream(stream);
    }
    // Give the concurrency slot back on EVERY teardown path, and before the
    // socket close below can throw: a slot that outlives its channel would
    // ratchet the session's cap down to zero over a few reconnects, which
    // looks exactly like the exhaustion this cap exists to prevent.
    if (releaseSlot) {
      try {
        releaseSlot();
      } catch (error) {
        // Nothing to do; the accounting is best-effort by design.
      }
      releaseSlot = null;
    }
    try {
      socket.close(code || CLOSE_NORMAL, reason === undefined ? undefined : truncateReason(reason));
    } catch (error) {
      // close() is not safely retryable -- see terminal.ts's identical
      // comment. terminate() is the one thing that still works.
      try {
        socket.terminate();
      } catch (terminateError) {
        // Already gone is exactly what we wanted.
      }
    }
  }

  // Attached before anything below can throw, same reasoning as
  // terminal.ts: a socket-level failure is not a clean exit, so it is 1011,
  // not the 1000 a plain `socket.on('close', () => teardown())` would imply
  // for every close including this one.
  socket.on('close', () => teardown());
  socket.on('error', () => teardown(CLOSE_INTERNAL_ERROR, 'socket error'));

  // The authorization decision. This is a refusal, not a fault -- but this
  // bridge only has one way to report anything to the client (a WebSocket
  // close), and terminal.ts's own convention is a strict two-code scheme
  // (1000 clean stop, 1011 any failure to fulfil the request). A path this
  // caller may not read is exactly that: the request cannot be fulfilled.
  // Reusing 1011 here rather than inventing a third code keeps the client's
  // close-code handling identical for both bridges.
  const command = buildCommand(deps, target, reason => teardown(CLOSE_INTERNAL_ERROR, reason));
  if (command === null) {
    return;
  }

  // Claimed AFTER validation (a refused request must not spend a slot) and
  // BEFORE the channel is opened (the whole point is not to open the
  // eleventh channel on a connection that allows ten). Refused outright
  // rather than queued: a queued follow is a socket sitting silently open
  // with nothing arriving on it, which is indistinguishable to the user
  // from a broken tab, and the queue itself is one more unbounded thing.
  releaseSlot = deps.acquire();
  if (!releaseSlot) {
    // The number itself is deliberately not in the message: the cap lives in
    // the FollowLimit the caller supplied (see createFollowLimit), and a
    // hard-coded figure here would be wrong for any other cap.
    teardown(CLOSE_INTERNAL_ERROR, 'Too many log follows are already open for this session. Close one and retry.');
    return;
  }

  // .then(...).catch(...), NOT .then(onFulfilled, onRejected): with the
  // two-argument form the rejection handler is attached to the ORIGINAL
  // promise, so anything the fulfillment handler below throws (a channel
  // that died the instant it was handed back, taking one of the on() calls
  // with it) becomes an unhandled rejection -- a socket left open with no
  // teardown, and a process-level warning nobody sees. Chained, that throw
  // lands in the same catch, which tears the follow down properly.
  deps
    .execStream(command)
    .then(openedStream => {
      // The socket went away while the channel was still opening -- there is
      // no reader left on the other end, so do not leave `tail -F`/
      // `journalctl -f` running with nobody attached to it.
      if (torndown) {
        releaseStream(openedStream);
        return;
      }

      stream = openedStream;

      // Attached BEFORE anything below that can throw, same reasoning as
      // terminal.ts: a stream adopted with listeners attached only
      // afterward would be released with no 'error' listener on it if
      // something here throws first.
      //
      // Output forwarding and backpressure are wsBridge.ts's forwardOutput,
      // the identical copy terminal.ts drives -- a log file written faster
      // than a backgrounded browser tab can read it is the same shape of
      // hazard as a flooding shell, not a different one, so it gets the same
      // code rather than a second implementation of it.
      forwardOutput(openedStream, socket, () => torndown);
      // Sliced on every append rather than "stop appending once over the
      // limit": a single ssh2 chunk can be tens of KB, so the looser form
      // would keep MAX_STDERR_CHARS plus one whole chunk, which is not the
      // bound this constant claims.
      attachStderr(openedStream, text => {
        if (stderrText.length < MAX_STDERR_CHARS) {
          stderrText = (stderrText + text).slice(0, MAX_STDERR_CHARS);
        }
      });
      // Unlike an interactive shell, `tail -F`/`journalctl -f` have no
      // `exit` a user types -- the ONLY ways this channel ever closes are
      // this bridge tearing it down (already 1000, via teardown() above,
      // before this listener even fires again) or the connection under it
      // dying. Either way a spontaneous 'close' here means the follow ended
      // without this bridge asking for it, which is the same shape as
      // terminal.ts's channel-error path, not its "user typed exit" path --
      // but terminal.ts's own two-code scheme has no code for "ended
      // unexpectedly but not exactly an error", so this reuses 1011, same as
      // 'error' below, rather than the misleading "session ended cleanly"
      // 1000 a literal copy of terminal.ts's `stream.on('close', ... 1000)`
      // would send.
      openedStream.on('close', () => teardown(CLOSE_INTERNAL_ERROR, closeReason('log stream closed')));
      openedStream.on('error', () => teardown(CLOSE_INTERNAL_ERROR, closeReason('log channel error')));
    })
    .catch(error => {
      // Usually the channel failing to open, in which case no stream was
      // ever assigned and teardown() only needs to close the socket -- but
      // it must still close it, with a reason, rather than leaving an
      // authenticated socket open with nothing ever driving it. This also
      // catches a throw from the handler above, where a stream HAS been
      // adopted; teardown() releases it either way.
      teardown(CLOSE_INTERNAL_ERROR, (error && error.message) || 'failed to open log stream');
    });
}
