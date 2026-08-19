// Bridges an interactive ssh2 shell channel to the browser over the
// `/ws/terminal` WebSocket. Everything here is plumbing: bytes go one way,
// keystrokes go the other, and a single JSON control frame (resize) is
// carved out of the input stream. All of the security decisions (is this
// caller allowed to open a socket at all) already happened in wsServer.ts's
// checkUpgrade before bridgeTerminal is ever called.
//
// THE WIRE PROTOCOL, and the one rule a client must not get wrong:
//
//   server -> client   Always terminal output, always raw bytes. Never
//                      parsed, never interpreted, never control.
//
//   client -> server   BINARY frames are terminal input, byte for byte,
//                      always. TEXT frames are control, currently only
//                      {"type":"resize","cols":N,"rows":N}.
//
// So a client MUST send every keystroke and every paste as a BINARY frame,
// and reserve text frames for control messages. This is not a stylistic
// preference. Data and control share one channel in the client->server
// direction, and a text frame is disambiguated only by whether it parses as
// a control message -- so a user who pastes
// `{"type":"resize","cols":80,"rows":24}` into a shell over a TEXT frame
// silently resizes their PTY and never sees the characters arrive, and one
// who pastes `{"type":"resize"}` watches it vanish with no feedback at all.
// Sending input as binary makes that impossible by construction: the
// !isBinary check below means binary input is never even offered to the
// control parser.
//
// Everything this bridge shares with logFollow.ts -- the socket type, the
// close codes, the close-reason truncation, the watermarks, releaseStream
// and the output-forwarding loop -- lives in wsBridge.ts. It is shared as
// CODE, not as a pattern to copy: see that module's header.
import {
  BridgeStream,
  CLOSE_INTERNAL_ERROR,
  CLOSE_NORMAL,
  forwardOutput,
  releaseStream,
  truncateReason,
  WsLike,
} from './wsBridge';

export interface TerminalSize {
  cols: number;
  rows: number;
}

// The structural subset of an ssh2 shell stream this bridge drives -- an
// interface rather than an import of ssh2's own type (there isn't one; see
// sshClient.ts) so tests can hand this a plain EventEmitter-shaped fake
// instead of a live SSH channel. It is BridgeStream (the read/release subset
// wsBridge.ts drives, shared with logFollow.ts's LogStream) plus the two
// members only an interactive shell has.
export interface ShellStream extends BridgeStream {
  write(data: string | Buffer): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
}

export interface TerminalDeps {
  // Opens the remote shell. Callers wire this to session.transport (the
  // ordinary SSH user), NEVER session.privilegedTransport -- a browser tab
  // able to open a root shell with no further prompt would be a serious,
  // silent privilege escalation, not a convenience. See index.ts.
  openShell(size: TerminalSize): Promise<ShellStream>;
}

// xterm.js's default geometry. The real size arrives moments later as the
// client's first resize control frame, once its DOM has actually measured
// the terminal element; opening with a guess rather than blocking on that
// round trip lets the shell start (and the remote MOTD/prompt start
// arriving) immediately.
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

const MIN_DIM = 1;
const MAX_DIM = 1000;

function isValidDim(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= MIN_DIM && n <= MAX_DIM;
}

type ControlFrame = { kind: 'resize'; size: TerminalSize } | { kind: 'malformed' } | null;

// A control frame is exactly `{"type":"resize","cols":N,"rows":N}`; anything
// else a TEXT message could be -- ordinary keystrokes, a pasted `{}`, JSON
// with a different `type` -- is not control at all and returns null, which
// tells the caller to write it to the shell like any other input. Only a
// message that DOES claim to be a resize but fails validation (non-integer,
// out of range, missing field) comes back as 'malformed': still not written
// as input, but distinct from ordinary text so the caller never confuses "not
// JSON" with "a broken resize request".
//
// This is deliberately only ever called on data arriving socket->server.
// Terminal *output* (server->socket) is raw bytes from the remote shell and
// is never run through this parser -- the protocol is control in one
// direction only.
function classifyControl(text: string): ControlFrame {
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (!msg || typeof msg !== 'object' || msg.type !== 'resize') {
    return null;
  }
  if (!isValidDim(msg.cols) || !isValidDim(msg.rows)) {
    return { kind: 'malformed' };
  }
  return { kind: 'resize', size: { cols: msg.cols, rows: msg.rows } };
}

export function bridgeTerminal(deps: TerminalDeps, socket: WsLike): void {
  let stream: ShellStream | null = null;
  // Input (and a resize) can arrive while openShell()'s round trip to the
  // remote host is still in flight; neither is dropped on the floor.
  const inputQueue: (string | Buffer)[] = [];
  let pendingResize: TerminalSize | null = null;
  let torndown = false;

  // Both directions end here. Guarded by `torndown` so it does not matter
  // which side notices first (socket close vs. stream close/error): the
  // other side's own close/error firing a moment later must not throw or
  // double-run the teardown -- this runs against the user's production
  // server, and a leaked shell channel is a real, ongoing cost to them.
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
      // close() is not safely retryable: `ws` has already moved the socket to
      // CLOSING by the time anything in it can throw, so a second close() is
      // a no-op and the socket would sit half-open with no close frame sent
      // and no timer armed to destroy it -- a spinner in the browser and a
      // leaked socket here. terminate() is the one thing that still works.
      try {
        socket.terminate();
      } catch (terminateError) {
        // Already gone is exactly what we wanted.
      }
    }
  }

  socket.on('message', (data, isBinary) => {
    // After teardown there is no stream to write to and never will be, so
    // without this every further frame would pile up in inputQueue with
    // nothing left to drain it -- an unbounded buffer fed by a socket that
    // may still be live (the shell failed to open, but the client has not
    // noticed the close yet and keeps typing).
    if (torndown) {
      return;
    }
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
      const control = classifyControl(text);
      if (control) {
        if (control.kind === 'resize') {
          if (stream) {
            stream.setWindow(control.size.rows, control.size.cols, 0, 0);
          } else {
            pendingResize = control.size;
          }
        }
        // Either kind of control frame: never fall through to be written as
        // terminal input, and never throw for a malformed one.
        return;
      }
    }
    if (stream) {
      stream.write(data);
    } else {
      inputQueue.push(data);
    }
  });

  socket.on('close', () => teardown());
  // A socket-level failure is not a clean exit -- reporting it as CLOSE_NORMAL
  // would tell the UI "session ended" for what was actually a broken bridge.
  // 1011 is the same code the shell-channel-error path below uses for the
  // mirror-image failure.
  socket.on('error', () => teardown(CLOSE_INTERNAL_ERROR, 'socket error'));

  deps.openShell(DEFAULT_SIZE).then(
    openedStream => {
      // The socket went away while the channel was still opening -- there is
      // no reader left on the other end, so do not leave a shell running
      // with nobody attached to it.
      if (torndown) {
        releaseStream(openedStream);
        return;
      }

      stream = openedStream;

      // Attached BEFORE setWindow()/the inputQueue replay below, on purpose:
      // either of those can throw (a channel that died the instant it was
      // handed back), and a stream adopted with listeners attached only
      // afterward would be released with no 'error' listener on it -- the
      // exact ERR_UNHANDLED_ERROR class releaseStream's own comment already
      // guards against on every other path. Attaching first closes that gap
      // for free.
      //
      // Output forwarding (and the backpressure that keeps a flooding shell
      // from filling this process's heap) is wsBridge.ts's forwardOutput,
      // the identical copy logFollow.ts drives.
      forwardOutput(openedStream, socket, () => torndown);
      // The shell exiting (the user typed `exit`, or the remote host closed
      // the session) is a NORMAL end to the conversation, not an error. Only
      // the channel failing under us is 1011.
      openedStream.on('close', () => teardown(CLOSE_NORMAL));
      openedStream.on('error', () => teardown(CLOSE_INTERNAL_ERROR, 'shell channel error'));

      // Only now, with every listener already attached, replay what arrived
      // while the round trip to the remote host was still in flight.
      if (pendingResize) {
        openedStream.setWindow(pendingResize.rows, pendingResize.cols, 0, 0);
      }
      inputQueue.splice(0).forEach(chunk => openedStream.write(chunk));
    },
    error => {
      // No stream was ever assigned, so teardown() only needs to close the
      // socket -- but it must still close it, with a reason, rather than
      // leaving an authenticated socket open with nothing ever driving it.
      teardown(CLOSE_INTERNAL_ERROR, (error && error.message) || 'failed to open shell');
    }
  );
}
