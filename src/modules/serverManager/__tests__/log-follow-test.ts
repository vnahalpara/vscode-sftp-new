import { bridgeLogFollow, LogFollowDeps, LogStream, LogTarget } from '../logFollow';
import { WsLike } from '../terminal';

// Same minimal EventEmitter-shaped fake terminal-test.ts uses -- no
// dependency on Node's real EventEmitter or a live socket/SSH connection.
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
  // Stands in for `ws`'s own send buffer -- see terminal-test.ts's identical
  // fake for why this is a plain field a test can set directly, drained via
  // drain() the way `ws` plays back send() callbacks once bytes are written.
  bufferedAmount = 0;
  private _pending: Array<(err?: Error) => void> = [];

  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    if (cb) {
      this._pending.push(cb);
    }
  }
  drain(): void {
    const pending = this._pending.splice(0);
    pending.forEach(cb => cb());
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

class FakeStream extends FakeEmitter implements LogStream {
  ended = false;
  closed = false;
  paused = false;
  pauses = 0;
  resumes = 0;

  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }
  pause(): void {
    this.paused = true;
    this.pauses++;
  }
  resume(): void {
    this.paused = false;
    this.resumes++;
  }
}

const FILE_PATH = '/var/log/nginx/access.log';
const UNIT = 'nginx.service';

function fileTarget(path: string = FILE_PATH): LogTarget {
  return { kind: 'file', path };
}

function unitTarget(unit: string = UNIT): LogTarget {
  return { kind: 'unit', unit };
}

// Builds LogFollowDeps around a single fake channel and a permissive
// allowlist by default; individual tests override isPathAllowed or the
// stream/promise to exercise refusal and failure paths.
function deps(opts: {
  stream?: Promise<LogStream>;
  isPathAllowed?: (path: string) => boolean;
  execStream?: jest.Mock;
} = {}): { deps: LogFollowDeps; execStream: jest.Mock } {
  const execStream = opts.execStream || jest.fn(async (_cmd: string) => (await (opts.stream || Promise.resolve(new FakeStream()))) as LogStream);
  return {
    deps: {
      isPathAllowed: opts.isPathAllowed || (() => true),
      execStream,
    },
    execStream,
  };
}

// Every execStream() in these tests resolves in a microtask; flush that
// before asserting on anything that only exists once the channel is wired up.
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

test('follows an allowlisted file and streams lines to the socket', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps({ stream: Promise.resolve(stream), isPathAllowed: p => p === FILE_PATH });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  expect(execStream).toHaveBeenCalledTimes(1);
  expect(execStream.mock.calls[0][0]).toContain('tail');
  expect(execStream.mock.calls[0][0]).toContain(FILE_PATH);

  stream.emit('data', Buffer.from('a log line\n'));

  expect(socket.sent).toEqual([Buffer.from('a log line\n')]);
});

test('follows a valid journald unit and streams lines to the socket', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, unitTarget());
  await flush();

  expect(execStream).toHaveBeenCalledTimes(1);
  expect(execStream.mock.calls[0][0]).toContain('journalctl');
  expect(execStream.mock.calls[0][0]).toContain(UNIT);

  stream.emit('data', Buffer.from('unit log line\n'));

  expect(socket.sent).toEqual([Buffer.from('unit log line\n')]);
});

test('refuses a path that is not in the session allowlist', async () => {
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps({ isPathAllowed: () => false });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  expect(execStream).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
  expect(socket.sent).toEqual([]);
});

// The allowlist is the authority, not isLogFilePath -- a path can look
// exactly like a legitimate discovery (shaped correctly, rooted under
// /var/log) and still never have been surfaced by a discovery scan for this
// session. Nothing about its shape should let it through.
test('a path that passes isLogFilePath but was never discovered is refused', async () => {
  const socket = new FakeSocket();
  const neverDiscovered = '/var/log/some/other/service.log';
  const { deps: d, execStream } = deps({ isPathAllowed: p => p !== neverDiscovered });

  bridgeLogFollow(d, socket, fileTarget(neverDiscovered));
  await flush();

  expect(execStream).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
});

// Defense in depth in the other direction: even a caller whose isPathAllowed
// says yes must not get a path outside /var/log followed -- isLogFilePath is
// re-checked here regardless of what the allowlist predicate reports.
test('refuses a path outside /var/log even when the predicate says it is allowed', async () => {
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps({ isPathAllowed: () => true });

  bridgeLogFollow(d, socket, fileTarget('/etc/shadow'));
  await flush();

  expect(execStream).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
});

// A path discovered for one session's allowlist must not be readable through
// another session's socket -- isPathAllowed must be a closure over ONE
// session, never a global "known to anyone" predicate.
test('a path in session As allowlist is refused for session B', async () => {
  const sharedPath = '/var/log/shared-looking.log';
  const sessionA = new Set([sharedPath]);
  const sessionB = new Set<string>(); // never discovered this path

  const socketA = new FakeSocket();
  const { deps: depsA, execStream: execA } = deps({ isPathAllowed: p => sessionA.has(p) });
  bridgeLogFollow(depsA, socketA, fileTarget(sharedPath));
  await flush();
  expect(execA).toHaveBeenCalledTimes(1);
  expect(socketA.closed).toBe(false);

  const socketB = new FakeSocket();
  const { deps: depsB, execStream: execB } = deps({ isPathAllowed: p => sessionB.has(p) });
  bridgeLogFollow(depsB, socketB, fileTarget(sharedPath));
  await flush();

  expect(execB).not.toHaveBeenCalled();
  expect(socketB.closed).toBe(true);
  expect(socketB.closeCode).toBe(1011);
});

test('refuses an unsafe unit name', async () => {
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps();

  bridgeLogFollow(d, socket, unitTarget('-Hattacker@evil'));
  await flush();

  expect(execStream).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
});

test('refuses a unit name containing shell metacharacters', async () => {
  const socket = new FakeSocket();
  const { deps: d, execStream } = deps();

  bridgeLogFollow(d, socket, unitTarget('evil; rm -rf /'));
  await flush();

  expect(execStream).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
});

// end() on an ssh2 exec channel sends CHANNEL_EOF and stops there
// (allowHalfOpen), leaving `tail -F`/`journalctl -f` running on the remote
// host and the channel slot allocated on the pooled connection SFTP and the
// Terminal tab also ride. close() is what actually gives the channel back --
// assert it specifically, exactly as terminal-test.ts does for the shell
// bridge.
test('closing the socket kills the remote tail: the channel is CLOSED, not merely ended', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  socket.emit('close');

  expect(stream.ended).toBe(true);
  expect(stream.closed).toBe(true);
});

test('a socket that closed while the channel was still opening closes the channel once opened', async () => {
  let resolveStream: (stream: LogStream) => void = () => undefined;
  const streamPromise = new Promise<LogStream>(resolve => {
    resolveStream = resolve;
  });
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: streamPromise });

  bridgeLogFollow(d, socket, fileTarget());
  socket.emit('close');

  const stream = new FakeStream();
  resolveStream(stream);
  await flush();

  expect(stream.ended).toBe(true);
  expect(stream.closed).toBe(true);
});

// The channel dying under us -- the SSH connection dropping -- must not
// leave anything running or leaked, and must not tell the client "session
// ended cleanly" (1000) for what was actually a broken connection.
test('a dropped connection kills the remote tail: the channel is released and the socket closes 1011', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  stream.emit('error', new Error('connection reset'));

  expect(stream.ended).toBe(true);
  expect(stream.closed).toBe(true);
  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
});

// Unlike an interactive shell, `tail -F`/`journalctl -f` have no `exit` a
// user types -- a spontaneous 'close' on this channel always means the
// follow ended without this bridge asking for it, so it is never the clean
// 1000 terminal.ts reports for a shell exiting normally.
test('the remote channel closing unexpectedly closes the socket with 1011, not a clean 1000', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  stream.emit('close');

  expect(socket.closeCode).toBe(1011);
});

test('a channel that fails to open closes the socket with a reason', async () => {
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.reject(new Error('permission denied')) as any });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();
  await flush();

  expect(socket.closed).toBe(true);
  expect(socket.closeCode).toBe(1011);
  expect(socket.closeReason).toBe('permission denied');
});

test('a huge failure reason is truncated to fit a close frame', async () => {
  const socket = new FakeSocket();
  const reason = 'x'.repeat(5000);
  const { deps: d } = deps({ stream: Promise.reject(new Error(reason)) as any });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();
  await flush();

  expect(Buffer.byteLength(socket.closeReason || '', 'utf8')).toBeLessThanOrEqual(123);
});

test('a socket whose close() throws is terminated instead of left half-open', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  socket.close = () => {
    throw new RangeError('nope');
  };
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  expect(() => stream.emit('close')).not.toThrow();
  expect(socket.terminated).toBe(true);
});

test('double teardown (socket close then channel close/error) does not throw', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  expect(() => {
    socket.emit('close');
    stream.emit('close');
    stream.emit('error', new Error('boom'));
  }).not.toThrow();

  expect(stream.ended).toBe(true);
  expect(socket.closed).toBe(true);
});

test('remote data arriving after teardown is not forwarded to the socket', async () => {
  const stream = new FakeStream();
  const socket = new FakeSocket();
  const { deps: d } = deps({ stream: Promise.resolve(stream) });

  bridgeLogFollow(d, socket, fileTarget());
  await flush();

  socket.emit('close'); // runs teardown()
  stream.emit('data', Buffer.from('late output'));

  expect(socket.sent).toEqual([]);
});

describe('backpressure', () => {
  // A busy log can outrun a WebSocket just as easily as a flooding shell --
  // same hazard terminal.ts guards against, same fix: pause the channel
  // above a high-water mark on the socket's own send buffer, and resume once
  // it has genuinely drained, rather than letting output pile up in this
  // process's heap without bound.
  test('pauses the channel when the socket buffer passes the high-water mark', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));

    expect(stream.paused).toBe(true);
    expect(stream.pauses).toBe(1);
  });

  test('does not pause an ordinary trickle of log lines', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 512;
    stream.emit('data', Buffer.from('a line\n'));
    socket.drain();

    expect(stream.pauses).toBe(0);
    expect(stream.resumes).toBe(0);
  });

  test('resumes the channel once the socket buffer has drained', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));
    expect(stream.paused).toBe(true);

    socket.bufferedAmount = 0;
    socket.drain();

    expect(stream.paused).toBe(false);
    expect(stream.resumes).toBe(1);
  });

  test('stays paused while the buffer is still above the low-water mark', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));

    socket.bufferedAmount = 900 * 1024;
    socket.drain();

    expect(stream.paused).toBe(true);
  });

  test('does not buffer without bound: bufferedAmount never grows past what the socket already reported', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    // A flood of lines arriving while the socket is already over the
    // high-water mark must pause immediately on the first chunk, not after
    // accumulating several -- there is no local queue for this bridge to
    // grow in the first place.
    socket.bufferedAmount = 2 * 1024 * 1024;
    stream.emit('data', Buffer.from('line 1\n'));
    expect(stream.pauses).toBe(1);

    stream.emit('data', Buffer.from('line 2\n'));
    stream.emit('data', Buffer.from('line 3\n'));
    // Still just the one pause() call -- emit() does not call pause() again
    // while already paused, matching terminal.ts's !paused guard.
    expect(stream.pauses).toBe(1);
  });

  test('does not resume a channel after teardown', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));
    socket.emit('close');

    socket.bufferedAmount = 0;
    socket.drain();

    expect(stream.resumes).toBe(0);
  });
});
