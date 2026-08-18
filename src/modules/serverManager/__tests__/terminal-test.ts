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
  closeReason: string | undefined;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason;
  }
}

class FakeStream extends FakeEmitter implements ShellStream {
  written: Array<string | Buffer> = [];
  ended = false;
  windows: Array<{ rows: number; cols: number }> = [];

  write(data: string | Buffer): void {
    this.written.push(data);
  }
  end(): void {
    this.ended = true;
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
  expect(socket.closeReason).toBe('connection refused');
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
