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
import {
  followCommand,
  isLogFilePath,
  isSafeUnitName,
  journalFollowCommand,
} from './ops/command';
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_NORMAL,
  SEND_HIGH_WATER,
  SEND_LOW_WATER,
  truncateReason,
  WsLike,
} from './terminal';

export type LogTarget = { kind: 'file'; path: string } | { kind: 'unit'; unit: string };

// The structural subset of a raw ssh2 exec channel this bridge drives -- an
// interface rather than an import of ssh2's own type, for the same reason
// terminal.ts's ShellStream is one: tests hand this a plain EventEmitter-
// shaped fake instead of a live SSH channel. Deliberately narrower than
// ShellStream: this bridge is read-only (nothing is ever written back to
// `tail`/`journalctl`'s stdin), so there is no write()/setWindow() here.
export interface LogStream {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  // Sends CHANNEL_EOF only -- NOT enough on its own. See releaseStream below,
  // and terminal.ts's own releaseStream comment: this is the exact same ssh2
  // allowHalfOpen hazard, on the exact same pooled connection.
  end(): void;
  // Sends CHANNEL_CLOSE and actually gives the channel back.
  close(): void;
  // Flow control, same reasoning as ShellStream's: pausing stops the SSH
  // window reopening, which is what makes the REMOTE `tail`/`journalctl`
  // actually stop producing rather than just moving the backlog into this
  // process's heap.
  pause(): void;
  resume(): void;
}

export interface LogFollowDeps {
  // True when `path` is in the CALLING SESSION's own allowlist. Must be a
  // closure over one specific token/session -- see the module comment above.
  isPathAllowed(path: string): boolean;
  // Opens `cmd` (already built by followCommand/journalFollowCommand, and
  // therefore already carrying its own `sudo -n`) as a raw, long-running
  // exec channel over the PRIVILEGED lane. Callers wire this to
  // session.privilegedTransport.execStream -- never the unprivileged
  // transport, and never a shell/PTY (there is no interactivity here, only a
  // single foreground process to read from).
  execStream(cmd: string): Promise<LogStream>;
}

// Give the remote channel back. Exactly the same hazard, and exactly the
// same fix, as terminal.ts's releaseStream: ssh2 builds this exec channel
// with allowHalfOpen true, so end() alone sends CHANNEL_EOF and deliberately
// skips CHANNEL_CLOSE, leaving `tail -F`/`journalctl -f` running on the
// remote host and the channel slot allocated on the connection this feature
// shares with SFTP and the Terminal tab. A `tail -F` is if anything a WORSE
// leak than the interactive shell terminal.ts guards against: it has no
// `exit` a user can type, and no idle timeout of its own -- once it is
// leaked, it runs until sshd's MaxSessions budget is exhausted or the
// process on the far end is killed by hand.
//
// The two calls are caught independently on purpose, same as
// terminal.ts's: a throw from end() (an already-dead channel) must not skip
// close().
function releaseStream(stream: LogStream): void {
  try {
    stream.on('error', () => undefined);
  } catch (error) {
    // Nothing to do; the calls below are still worth attempting.
  }
  try {
    stream.end();
  } catch (error) {
    // Already gone is exactly what we wanted.
  }
  try {
    stream.close();
  } catch (error) {
    // Already gone is exactly what we wanted.
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
  let torndown = false;

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

  deps.execStream(command).then(
    openedStream => {
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
      // Output is forwarded with backpressure, identical mechanism to
      // terminal.ts's: pausing the ssh2 channel stops it re-opening its SSH
      // window, which is what actually makes the REMOTE `tail`/`journalctl`
      // stop producing rather than just moving the backlog into this
      // process's heap. A busy log is exactly the scenario terminal.ts's own
      // comment calls out (`cat /dev/urandom`) -- a log file being written
      // faster than a backgrounded browser tab can read it is the same
      // shape of hazard, not a different one, so it gets the same fix
      // rather than a new "drop with a marker" scheme.
      let paused = false;
      openedStream.on('data', chunk => {
        // Teardown already closed this channel; further in-flight data has
        // nowhere useful to go -- see terminal.ts's identical guard.
        if (torndown) {
          return;
        }
        try {
          socket.send(chunk, () => {
            if (paused && !torndown && socket.bufferedAmount <= SEND_LOW_WATER) {
              paused = false;
              try {
                openedStream.resume();
              } catch (error) {
                // A dead channel cannot be resumed, and does not need to be.
              }
            }
          });
        } catch (error) {
          // The socket closed a moment before this chunk arrived; teardown()
          // below (via the stream's own close/error) reaps the rest.
        }
        if (!paused && socket.bufferedAmount > SEND_HIGH_WATER) {
          paused = true;
          try {
            openedStream.pause();
          } catch (error) {
            // Nothing to fall back to: without pause() this is an unbounded
            // buffer, but a throw here means the channel is already gone.
          }
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
      openedStream.on('close', () => teardown(CLOSE_INTERNAL_ERROR, 'log stream closed'));
      openedStream.on('error', () => teardown(CLOSE_INTERNAL_ERROR, 'log channel error'));
    },
    error => {
      // No stream was ever assigned, so teardown() only needs to close the
      // socket -- but it must still close it, with a reason, rather than
      // leaving an authenticated socket open with nothing ever driving it.
      teardown(CLOSE_INTERNAL_ERROR, (error && error.message) || 'failed to open log stream');
    }
  );
}
