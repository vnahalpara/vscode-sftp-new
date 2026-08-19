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

export interface TerminalSize {
  cols: number;
  rows: number;
}

// The structural subset of an ssh2 shell stream this bridge drives -- an
// interface rather than an import of ssh2's own type (there isn't one; see
// sshClient.ts) so tests can hand this a plain EventEmitter-shaped fake
// instead of a live SSH channel.
export interface ShellStream {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  write(data: string | Buffer): void;
  end(): void;
  // Sends CHANNEL_CLOSE. Declared alongside end() because end() ALONE does
  // not release the channel -- see releaseStream below for why that matters.
  close(): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  // Flow control. Pausing an ssh2 channel stops it re-opening its SSH window,
  // which is what makes the REMOTE end stop sending -- see the send path in
  // bridgeTerminal for why that matters.
  pause(): void;
  resume(): void;
}

// The structural subset of a `ws` WebSocket this bridge drives -- declared
// here rather than imported from `ws` so a test can drive it with a fake
// that implements nothing but these few members.
export interface WsLike {
  on(event: 'message', cb: (data: Buffer | string, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  // The callback fires once `ws` has handed the frame to the socket (or
  // failed to), which is how this bridge learns that its send buffer has
  // drained without polling for it.
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  // Bytes queued in `ws` but not yet written to the socket. This is the
  // number that grows without bound if nothing throttles the producer.
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
  // The ungraceful exit: destroys the underlying socket outright. Needed
  // because close() can leave a socket in CLOSING forever -- see teardown().
  terminate(): void;
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

// RFC 6455 close codes. 1000 is "the conversation ended normally" -- which
// is what typing `exit` is, and what the user closing the tab is. 1011 means
// the SERVER hit a condition that stopped it fulfilling the request, and is
// reserved here for exactly that: the shell could not be opened, or the
// channel failed under us. The UI reads these to decide whether to show
// "session ended" or an actual error, so reporting 1011 for every close (as
// this did) makes a clean exit indistinguishable from a broken bridge.
//
// Exported so logFollow.ts (the /ws/logs bridge) uses the exact same two
// codes rather than inventing its own scheme -- see that module for how it
// maps an authorization refusal onto CLOSE_INTERNAL_ERROR.
export const CLOSE_NORMAL = 1000;
export const CLOSE_INTERNAL_ERROR = 1011;

// A close frame's payload is at most 125 bytes: 2 for the code, 123 for the
// reason. `ws` does not truncate -- sender.close() THROWS a RangeError past
// that, synchronously, after WebSocket.close() has already set the ready
// state to CLOSING and before it arms the close timer. The result is a
// socket that sends no close frame, has no timer to destroy it, and is never
// retried (teardown is one-shot): the browser sits on a spinner and a
// half-open socket leaks. And the reason is remote-controlled in the case
// that matters -- it comes from error.message, and ssh2 builds a
// channel-open failure message out of verbatim text from the remote sshd.
const MAX_REASON_BYTES = 123;

// Exported so logFollow.ts reuses this exact truncation rather than writing a
// second one -- see the module comment above for why a naive close(code,
// reason) is unsafe with a reason this bridge did not choose (ssh2/sshd
// error text).
export function truncateReason(reason: string): string {
  // Every character is at least one byte, so 123 characters is a safe upper
  // bound to start from -- this avoids walking a pathologically long remote
  // string one character at a time.
  let out = reason.slice(0, MAX_REASON_BYTES);
  while (Buffer.byteLength(out, 'utf8') > MAX_REASON_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

// How much output may sit unsent in `ws`'s buffer before the remote shell is
// told to stop talking, and how far it must drain before it is let go again.
// Two marks rather than one so a busy terminal does not pause and resume on
// every frame.
//
// Without this the bridge is an unbounded pipe from the remote host into the
// extension host's heap: ssh2 re-opens its flow-control window as fast as a
// synchronous 'data' handler drains it, so `cat /dev/urandom` with a
// backgrounded (and therefore throttled) browser tab piles up tens of MB per
// second in this process until it dies -- taking every other extension, and
// the user's unsaved work, with it. A megabyte of pending output is far more
// than any interactive session needs, and is bounded.
// Exported so logFollow.ts uses the same watermarks rather than picking its
// own, arbitrarily different numbers for what is the identical hazard: a
// busy `tail -F` outrunning a WebSocket.
export const SEND_HIGH_WATER = 1024 * 1024;
export const SEND_LOW_WATER = 256 * 1024;

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

// Give the remote channel back. end() alone is NOT enough and the difference
// is not cosmetic: ssh2 builds a shell Channel with allowHalfOpen true, and
// its 'finish' handler (Channel.js's onFinish) sends CHANNEL_EOF and then
// deliberately SKIPS close() for a half-open-capable channel. The remote PTY
// keeps running, the local Channel and its _chanMgr slot stay allocated, and
// the stream's own 'close' never fires -- so nothing else reaps it either.
//
// That leak lands on the POOLED SSH connection this dashboard shares with
// SFTP and the monitor sampler. With sshd's default MaxSessions 10, roughly
// ten open-and-close cycles of the Terminal tab exhaust the channel budget
// and every later file transfer, `systemctl status` and metrics sample on
// that profile fails with "administratively prohibited", while ten orphaned
// shells sit running on the user's production host. end() + close() is
// exactly what ssh2's own Channel.destroy() does.
//
// The two calls are caught separately on purpose: a throw from end() (an
// already-dead channel) must not be allowed to skip the close().
function releaseStream(stream: ShellStream): void {
  // A stream can error ASYNCHRONOUSLY in response to being ended (the
  // connection died a moment ago and the write fails), and an 'error' with no
  // listener is a throw out of the event loop -- an extension host crash.
  // The bridge's own listeners are attached only once the stream is adopted,
  // so the mid-open teardown path would otherwise release a stream that has
  // no listener at all. Attaching one here means every release path is
  // covered, and a duplicate on the ordinary path is harmless.
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
      // Output is forwarded with backpressure. The browser is the slow end
      // here -- a throttled background tab reads at a trickle while the
      // remote shell can produce megabytes a second -- and `ws` buffers
      // whatever it cannot write, in this process's heap. Pausing the ssh2
      // channel stops it re-opening its SSH window, which is what actually
      // makes the remote host stop sending rather than just moving the
      // backlog around.
      let paused = false;
      openedStream.on('data', chunk => {
        // Teardown already closed this channel; further in-flight data has
        // nowhere useful to go. Without this, socket.send() below runs on a
        // CLOSING/CLOSED socket -- `ws`'s sendAfterClose only ever
        // increments _sender._bufferedBytes, never decrements it, so
        // bufferedAmount climbs without bound and an already-released stream
        // can be pause()d a second time.
        if (torndown) {
          return;
        }
        try {
          socket.send(chunk, () => {
            // Fired once `ws` has written the frame (or failed to). Let the
            // shell talk again once the backlog has genuinely drained.
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
