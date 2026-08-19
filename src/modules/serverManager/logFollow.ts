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
export interface LogStream extends BridgeStream {}

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
      // Output forwarding and backpressure are wsBridge.ts's forwardOutput,
      // the identical copy terminal.ts drives -- a log file written faster
      // than a backgrounded browser tab can read it is the same shape of
      // hazard as a flooding shell, not a different one, so it gets the same
      // code rather than a second implementation of it.
      forwardOutput(openedStream, socket, () => torndown);
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
