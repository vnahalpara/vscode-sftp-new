// What the two WebSocket bridges in this folder -- terminal.ts (an
// interactive shell over /ws/terminal) and logFollow.ts (`tail -F`/
// `journalctl -f` over /ws/logs) -- have genuinely in common: a `ws` socket
// on one side, an ssh2 channel on the pooled SSH connection on the other,
// and two hazards that are identical in both directions.
//
// This module exists because the second bridge was written by copying the
// first. The constants came across as imports, but releaseStream and the
// whole send/pause/resume block came across as CHARACTER-FOR-CHARACTER
// duplicates differing only in a parameter's type -- so the end()/close()
// lesson below, which has now been re-learned four times in this milestone,
// had two places to be forgotten in. The two streams share the exact
// {on, end, close, pause, resume} subset, so one structural type (see
// BridgeStream) lets one copy serve both, and the next fix to either hazard
// lands once.

// The structural subset of a `ws` WebSocket these bridges drive -- declared
// here rather than imported from `ws` so a test can drive it with a fake
// that implements nothing but these few members.
export interface WsLike {
  on(event: 'message', cb: (data: Buffer | string, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  // The callback fires once `ws` has handed the frame to the socket (or
  // failed to), which is how a bridge learns that its send buffer has
  // drained without polling for it.
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  // Bytes queued in `ws` but not yet written to the socket. This is the
  // number that grows without bound if nothing throttles the producer.
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
  // The ungraceful exit: destroys the underlying socket outright. Needed
  // because close() can leave a socket in CLOSING forever -- see either
  // bridge's teardown().
  terminate(): void;
}

// The structural subset of an ssh2 channel BOTH bridges drive: enough to
// forward output with backpressure and to give the channel back. Neither
// bridge's own stream type is imported here -- ShellStream (terminal.ts)
// adds write()/setWindow(), LogStream (logFollow.ts) is read-only and adds
// stderr, and both satisfy this subset structurally, which is the point.
export interface BridgeStream {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  // Sends CHANNEL_EOF only -- NOT enough on its own. See releaseStream.
  end(): void;
  // Sends CHANNEL_CLOSE and actually gives the channel back.
  close(): void;
  // Flow control. Pausing an ssh2 channel stops it re-opening its SSH
  // window, which is what makes the REMOTE end stop sending -- see
  // forwardOutput for why that matters.
  pause(): void;
  resume(): void;
}

// RFC 6455 close codes. 1000 is "the conversation ended normally" -- which
// is what typing `exit` is, and what the user closing the tab is. 1011 means
// the SERVER hit a condition that stopped it fulfilling the request, and is
// reserved for exactly that: the channel could not be opened, it failed
// under us, or (in logFollow.ts) the caller asked for something it is not
// allowed to read. The UI reads these to decide whether to show "session
// ended" or an actual error, so reporting 1011 for every close makes a clean
// exit indistinguishable from a broken bridge.
//
// Both bridges use these two and only these two, rather than inventing
// per-bridge schemes the client would have to special-case.
export const CLOSE_NORMAL = 1000;
export const CLOSE_INTERNAL_ERROR = 1011;

// A close frame's payload is at most 125 bytes: 2 for the code, 123 for the
// reason. `ws` does not truncate -- sender.close() THROWS a RangeError past
// that, synchronously, after WebSocket.close() has already set the ready
// state to CLOSING and before it arms the close timer. The result is a
// socket that sends no close frame, has no timer to destroy it, and is never
// retried (teardown is one-shot): the browser sits on a spinner and a
// half-open socket leaks. And the reason is remote-controlled in the cases
// that matter -- it comes from error.message (ssh2 builds a channel-open
// failure message out of verbatim text from the remote sshd) or, for
// logFollow.ts, from the remote command's own stderr.
const MAX_REASON_BYTES = 123;

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

// How much output may sit unsent in `ws`'s buffer before the remote end is
// told to stop talking, and how far it must drain before it is let go again.
// Two marks rather than one so a busy stream does not pause and resume on
// every frame.
//
// Without this a bridge is an unbounded pipe from the remote host into the
// extension host's heap: ssh2 re-opens its flow-control window as fast as a
// synchronous 'data' handler drains it, so `cat /dev/urandom` (or a busy log
// under `tail -F`) with a backgrounded, throttled browser tab piles up tens
// of MB per second in this process until it dies -- taking every other
// extension, and the user's unsaved work, with it. A megabyte of pending
// output is far more than any interactive session or log view needs, and is
// bounded.
export const SEND_HIGH_WATER = 1024 * 1024;
export const SEND_LOW_WATER = 256 * 1024;

// Give the remote channel back. end() alone is NOT enough and the difference
// is not cosmetic: ssh2 builds these channels with allowHalfOpen true, and
// its 'finish' handler (Channel.js's onFinish) sends CHANNEL_EOF and then
// deliberately SKIPS close() for a half-open-capable channel. The remote
// process keeps running, the local Channel and its _chanMgr slot stay
// allocated, and the stream's own 'close' never fires -- so nothing else
// reaps it either.
//
// That leak lands on the POOLED SSH connection this dashboard shares with
// SFTP and the monitor sampler. With sshd's default MaxSessions 10, roughly
// ten open-and-close cycles exhaust the channel budget and every later file
// transfer, `systemctl status` and metrics sample on that profile fails with
// "administratively prohibited", while ten orphaned remote processes sit
// running on the user's production host. A leaked `tail -F` is if anything
// worse than a leaked shell: it has no `exit` a user can type and no idle
// timeout of its own. end() + close() is exactly what ssh2's own
// Channel.destroy() does.
//
// The two calls are caught separately on purpose: a throw from end() (an
// already-dead channel) must not be allowed to skip the close().
export function releaseStream(stream: BridgeStream): void {
  // A stream can error ASYNCHRONOUSLY in response to being ended (the
  // connection died a moment ago and the write fails), and an 'error' with no
  // listener is a throw out of the event loop -- an extension host crash.
  // A bridge's own listeners are attached only once the stream is adopted,
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

// Forward remote output to the socket with backpressure, and nothing else.
// The browser is the slow end here -- a throttled background tab reads at a
// trickle while a shell or a busy log can produce megabytes a second -- and
// `ws` buffers whatever it cannot write, in this process's heap. Pausing the
// ssh2 channel stops it re-opening its SSH window, which is what actually
// makes the REMOTE end stop producing rather than just moving the backlog
// around.
//
// `isTornDown` is a callback, not a boolean, precisely because it is read
// again on every chunk and inside the drain callback -- both of which run
// long after this function has returned.
export function forwardOutput(stream: BridgeStream, socket: WsLike, isTornDown: () => boolean): void {
  let paused = false;
  stream.on('data', chunk => {
    // Teardown already closed this channel; further in-flight data has
    // nowhere useful to go. Without this, socket.send() below runs on a
    // CLOSING/CLOSED socket -- `ws`'s sendAfterClose only ever increments
    // _sender._bufferedBytes, never decrements it, so bufferedAmount climbs
    // without bound and an already-released stream can be pause()d a second
    // time.
    if (isTornDown()) {
      return;
    }
    try {
      socket.send(chunk, () => {
        // Fired once `ws` has written the frame (or failed to). Let the
        // remote end talk again once the backlog has genuinely drained.
        if (paused && !isTornDown() && socket.bufferedAmount <= SEND_LOW_WATER) {
          paused = false;
          try {
            stream.resume();
          } catch (error) {
            // A dead channel cannot be resumed, and does not need to be.
          }
        }
      });
    } catch (error) {
      // The socket closed a moment before this chunk arrived; the bridge's
      // teardown (via the stream's own close/error) reaps the rest.
    }
    if (!paused && socket.bufferedAmount > SEND_HIGH_WATER) {
      paused = true;
      try {
        stream.pause();
      } catch (error) {
        // Nothing to fall back to: without pause() this is an unbounded
        // buffer, but a throw here means the channel is already gone.
      }
    }
  });
}
