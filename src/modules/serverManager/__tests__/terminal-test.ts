import { bridgeTerminal, TerminalDeps, WsLike, ShellStream, TerminalSize } from '../terminal';

// A minimal EventEmitter-shaped fake -- just enough of `.on(event, cb)` to
// drive the bridge, with no dependency on Node's real EventEmitter or a live
// socket/SSH connection.
class FakeEmitter {
  private _listeners: { [event: string]: Array<(...args: any[]) => void> } = {};

  on(event: string, cb: (...args: any[]) => void): void {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
  }

  emit(event: string, ...args: any[]): void {
    (this._listeners[event] || []).slice().forEach(cb => cb(...args));
  }
}

class FakeSocket extends FakeEmitter implements WsLike {
  sent: Array<string | Buffer> = [];
  closed = false;
  terminated = false;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  terminate(): void {
    this.terminated = true;
  }
}

class FakeStream extends FakeEmitter implements ShellStream {
  written: Array<string | Buffer> = [];
  ended = false;
  closed = false;
  windows: Array<{ rows: number; cols: number }> = [];

  write(data: string | Buffer): void {
    this.written.push(data);
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }
  setWindow(rows: number, cols: number): void {
    this.windows.push({ rows, cols });
  }
}

function deps(stream: Promise<ShellStream>): TerminalDeps {
  return { openShell: (_size: TerminalSize) => stream };
}

// Every openShell() in these tests resolves in a microtask; flush that
// before asserting on anything that only exists once the stream is wired up.
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

test('remote output is forwarded to the socket', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  stream.emit('data', Buffer.from('hello\r\n'));

  expect(socket.sent).toEqual([Buffer.from('hello\r\n')]);
});

test('socket input is written to the shell', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  socket.emit('message', 'ls -la\n', false);

  expect(stream.written).toEqual(['ls -la\n']);
});

test('a resize control message calls setWindow, and is NOT written as input', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  socket.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), false);

  expect(stream.windows).toEqual([{ rows: 40, cols: 120 }]);
  expect(stream.written).toEqual([]);
});

test('a malformed resize message is ignored, not written as input, and does not throw', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  expect(() => {
    socket.emit('message', JSON.stringify({ type: 'resize', cols: 'abc', rows: 40 }), false);
    socket.emit('message', JSON.stringify({ type: 'resize', cols: 0, rows: 40 }), false);
    socket.emit('message', JSON.stringify({ type: 'resize', cols: 2000, rows: 40 }), false);
    socket.emit('message', JSON.stringify({ type: 'resize' }), false);
  }).not.toThrow();

  expect(stream.windows).toEqual([]);
  expect(stream.written).toEqual([]);
});

test('ordinary text that happens to be JSON but is not a resize is written as input', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  const payload = JSON.stringify({ hello: 'world' });
  socket.emit('message', payload, false);

  expect(stream.written).toEqual([payload]);
  expect(stream.windows).toEqual([]);
});

test('closing the socket ends the remote stream', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  socket.emit('close');

  expect(stream.ended).toBe(true);
});

// end() on an ssh2 shell channel sends CHANNEL_EOF and stops there
// (allowHalfOpen), leaving the remote PTY running and the channel slot
// allocated on the POOLED connection SFTP also uses. close() is what actually
// gives the channel back, so assert it specifically rather than settling for
// "ended".
test('closing the socket CLOSES the remote channel, not just its write side', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  socket.emit('close');

  expect(stream.closed).toBe(true);
});

test('a socket that closed while the shell was still opening closes the channel', async () => {
  let resolveShell: (stream: ShellStream) => void = () => undefined;
  const shellPromise = new Promise<ShellStream>(resolve => {
    resolveShell = resolve;
  });
  const socket = new FakeSocket();
  bridgeTerminal(deps(shellPromise), socket);

  socket.emit('close');
  const stream = new FakeStream();
  resolveShell(stream);
  await flush();

  expect(stream.ended).toBe(true);
  expect(stream.closed).toBe(true);
});

test('a stream that throws from end() is still closed', async () => {
  const stream = new FakeStream();
  stream.end = () => {
    throw new Error('already gone');
  };
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  expect(() => socket.emit('close')).not.toThrow();
  expect(stream.closed).toBe(true);
});

test('the remote stream closing closes the socket', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  stream.emit('close');

  expect(socket.closed).toBe(true);
});

test('a shell that fails to open closes the socket with a reason', async () => {
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.reject(new Error('connection refused'))), socket);
  await flush();
  await flush();

  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
  expect(socket.closeReason).toBe('connection refused');
});

// The UI has to be able to tell "your shell exited" from "the bridge broke",
// and the close code is the only signal it gets.
test('a shell that exits normally closes the socket with 1000, not an error code', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  stream.emit('close');

  expect(socket.closeCode).toBe(1000);
});

test('a stream error closes the socket with 1011', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  stream.emit('error', new Error('channel died'));

  expect(socket.closeCode).toBe(1011);
});

// A close frame carries at most 123 bytes of reason, and `ws` throws a
// RangeError rather than truncating -- after it has already moved the socket
// to CLOSING, so no close frame is sent and no timer is armed to destroy it.
// The reason is remote-controlled here: ssh2 builds a channel-open failure
// message out of text the remote sshd supplied.
test('a huge failure reason is truncated to fit a close frame', async () => {
  const socket = new FakeSocket();
  const reason = 'x'.repeat(5000);
  bridgeTerminal(deps(Promise.reject(new Error(reason))), socket);
  await flush();
  await flush();

  expect(Buffer.byteLength(socket.closeReason || '', 'utf8')).toBeLessThanOrEqual(123);
});

test('a multi-byte failure reason is truncated by BYTES, not characters', async () => {
  const socket = new FakeSocket();
  // Four bytes per character: 123 characters would be 492 bytes.
  bridgeTerminal(deps(Promise.reject(new Error('\u{1F4A9}'.repeat(200)))), socket);
  await flush();
  await flush();

  expect(Buffer.byteLength(socket.closeReason || '', 'utf8')).toBeLessThanOrEqual(123);
});

// If close() throws anyway, `ws` has already set CLOSING and a retry is a
// no-op: the socket would sit half-open forever with the browser on a
// spinner. terminate() is the only thing left that works.
test('a socket whose close() throws is terminated instead of left half-open', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  socket.close = () => {
    throw new RangeError('nope');
  };
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  expect(() => stream.emit('close')).not.toThrow();
  expect(socket.terminated).toBe(true);
});

// Nothing drains inputQueue after teardown, so frames arriving on a socket
// the client has not yet noticed is closed would accumulate without bound.
test('frames arriving after teardown are dropped, not queued forever', async () => {
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.reject(new Error('no shell'))), socket);
  await flush();
  await flush();

  expect(() => {
    socket.emit('message', 'still typing\n', false);
    socket.emit('message', JSON.stringify({ type: 'resize', cols: 10, rows: 10 }), false);
  }).not.toThrow();
  // Nothing was sent back and nothing re-closed the socket.
  expect(socket.sent).toEqual([]);
});

test('double teardown (socket close then stream close) does not throw', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  bridgeTerminal(deps(Promise.resolve(stream)), socket);
  await flush();

  expect(() => {
    socket.emit('close');
    stream.emit('close');
    stream.emit('error', new Error('boom'));
  }).not.toThrow();

  expect(stream.ended).toBe(true);
  expect(socket.closed).toBe(true);
});

test('terminal bytes queued while the shell is still opening are not lost', async () => {
  let resolveShell: (stream: ShellStream) => void = () => undefined;
  const shellPromise = new Promise<ShellStream>(resolve => {
    resolveShell = resolve;
  });
  const socket = new FakeSocket();
  bridgeTerminal(deps(shellPromise), socket);

  socket.emit('message', 'echo hi\n', false);

  const stream = new FakeStream();
  resolveShell(stream);
  await flush();

  expect(stream.written).toEqual(['echo hi\n']);
});
