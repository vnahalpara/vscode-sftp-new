// Bridges an interactive ssh2 shell channel to the browser over the
// `/ws/terminal` WebSocket. Everything here is plumbing: bytes go one way,
// keystrokes go the other, and a single JSON control frame (resize) is
// carved out of the input stream. All of the security decisions (is this
// caller allowed to open a socket at all) already happened in wsServer.ts's
// checkUpgrade before bridgeTerminal is ever called.

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
}

// The structural subset of a `ws` WebSocket this bridge drives -- declared
// here rather than imported from `ws` so a test can drive it with a fake
// that implements nothing but these three members.
export interface WsLike {
  on(event: 'message', cb: (data: Buffer | string, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
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
  function teardown(reason?: string): void {
    if (torndown) {
      return;
    }
    torndown = true;
    if (stream) {
      releaseStream(stream);
    }
    try {
      socket.close(1011, reason);
    } catch (error) {
      // Already gone is exactly what we wanted.
    }
  }

  socket.on('message', (data, isBinary) => {
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
  socket.on('error', () => teardown());

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
      if (pendingResize) {
        openedStream.setWindow(pendingResize.rows, pendingResize.cols, 0, 0);
      }
      inputQueue.splice(0).forEach(chunk => openedStream.write(chunk));

      openedStream.on('data', chunk => {
        try {
          socket.send(chunk);
        } catch (error) {
          // The socket closed a moment before this chunk arrived; teardown()
          // below (via the stream's own close/error) reaps the rest.
        }
      });
      openedStream.on('close', () => teardown());
      openedStream.on('error', () => teardown());
    },
    error => {
      // No stream was ever assigned, so teardown() only needs to close the
      // socket -- but it must still close it, with a reason, rather than
      // leaving an authenticated socket open with nothing ever driving it.
      teardown((error && error.message) || 'failed to open shell');
    }
  );
}
