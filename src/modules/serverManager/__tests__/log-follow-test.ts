import {
  bridgeLogFollow,
  createFollowLimit,
  LogFollowDeps,
  LogStream,
  LogTarget,
  MAX_CONCURRENT_FOLLOWS,
} from '../logFollow';
import { WsLike } from '../wsBridge';

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

// A stand-in for ssh2's separate stderr readable -- the channel's stderr is
// NOT interleaved into 'data', so a bridge that never reads it cannot see
// why `sudo -n tail` died. pause()/resume() are tracked the same way
// FakeStream's are: ssh2 shares one flow-control window between stdout and
// stderr, so forwardOutput must pause/resume this alongside the channel.
class FakeStderr extends FakeEmitter {
  paused = false;
  pauses = 0;
  resumes = 0;

  pause(): void {
    this.paused = true;
    this.pauses++;
  }
  resume(): void {
    this.paused = false;
    this.resumes++;
  }
}

class FakeStream extends FakeEmitter implements LogStream {
  ended = false;
  closed = false;
  paused = false;
  pauses = 0;
  resumes = 0;
  stderr = new FakeStderr();

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
  acquire?: () => (() => void) | null;
  user?: string;
  host?: string;
} = {}): { deps: LogFollowDeps; execStream: jest.Mock } {
  const execStream = opts.execStream || jest.fn(async (_cmd: string) => (await (opts.stream || Promise.resolve(new FakeStream()))) as LogStream);
  return {
    deps: {
      isPathAllowed: opts.isPathAllowed || (() => true),
      // Uncapped by default: the cap has its own describe block below, and
      // every other test here is about a single follow.
      acquire: opts.acquire || (() => () => undefined),
      user: opts.user || 'deploy',
      host: opts.host || '10.0.0.5',
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

  // ssh2 shares ONE flow-control window and one _waitChanDrain flag between
  // a channel's stdout and stderr (client.js's exec()), and
  // ClientStderr._read re-opens that window on the CHANNEL itself, not on
  // stderr alone. Pausing only stdout leaves the channel free to reopen
  // every time the remote writes a line to stderr -- a `tail -F` warning
  // like "file has been replaced; following new file" -- so each such line
  // would admit one more packet of stdout outside SEND_HIGH_WATER's
  // accounting. Without stderr paused alongside the channel, a steady
  // stderr trickle turns a bounded backlog into a slow, unbounded one.
  test('pauses stderr alongside the channel when the high-water mark is crossed', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));

    expect(stream.stderr.paused).toBe(true);
    expect(stream.stderr.pauses).toBe(1);
  });

  test('resumes stderr alongside the channel once the socket buffer has drained', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    stream.emit('data', Buffer.from('flood'));
    expect(stream.stderr.paused).toBe(true);

    socket.bufferedAmount = 0;
    socket.drain();

    expect(stream.stderr.paused).toBe(false);
    expect(stream.stderr.resumes).toBe(1);
  });

  test('a channel with no stderr readable is paused without throwing', async () => {
    const stream = new FakeStream();
    delete (stream as any).stderr;
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    socket.bufferedAmount = 4 * 1024 * 1024;
    expect(() => stream.emit('data', Buffer.from('flood'))).not.toThrow();
    expect(stream.paused).toBe(true);
  });
});

// Teardown was already correct on every path, but nothing bounded
// SIMULTANEOUS follows. Each open socket holds one exec channel on the
// pooled SSH connection this dashboard shares with SFTP and the sampler, so
// ten concurrent follows exhaust OpenSSH's default MaxSessions and every
// later file transfer on the profile fails with "administratively
// prohibited" -- a failure that shows up nowhere near the Logs tab.
describe('concurrency cap', () => {
  test('allows follows up to the cap and refuses the next one', () => {
    const limit = createFollowLimit(2);

    expect(limit.acquire('tok')).not.toBeNull();
    expect(limit.acquire('tok')).not.toBeNull();
    expect(limit.acquire('tok')).toBeNull();
    expect(limit.active('tok')).toBe(2);
  });

  test('releasing a slot lets the next follow through', () => {
    const limit = createFollowLimit(1);
    const release = limit.acquire('tok');

    expect(limit.acquire('tok')).toBeNull();
    release!();
    expect(limit.active('tok')).toBe(0);
    expect(limit.acquire('tok')).not.toBeNull();
  });

  test('a double release does not hand back a slot twice', () => {
    const limit = createFollowLimit(1);
    const first = limit.acquire('tok');
    const second = limit.acquire('tok'); // refused, at cap

    first!();
    first!();

    expect(second).toBeNull();
    expect(limit.active('tok')).toBe(0);
    expect(limit.acquire('tok')).not.toBeNull();
    expect(limit.acquire('tok')).toBeNull();
  });

  test('is per session: one session at its cap does not block another', () => {
    const limit = createFollowLimit(1);
    limit.acquire('tok-a');

    expect(limit.acquire('tok-a')).toBeNull();
    expect(limit.acquire('tok-b')).not.toBeNull();
  });

  test('the default cap leaves headroom under sshd MaxSessions 10', () => {
    expect(MAX_CONCURRENT_FOLLOWS).toBeLessThan(10);
  });

  test('refuses an over-cap open with a reason instead of opening a channel', async () => {
    const limit = createFollowLimit(1);
    const first = new FakeSocket();
    const { deps: d1 } = deps({ stream: Promise.resolve(new FakeStream()), acquire: () => limit.acquire('tok') });
    bridgeLogFollow(d1, first, fileTarget());
    await flush();
    expect(first.closed).toBe(false);

    const second = new FakeSocket();
    const { deps: d2, execStream } = deps({ acquire: () => limit.acquire('tok') });
    bridgeLogFollow(d2, second, fileTarget());
    await flush();

    expect(execStream).not.toHaveBeenCalled();
    expect(second.closed).toBe(true);
    expect(second.closeCode).toBe(1011);
    expect(second.closeReason).toContain('Too many log follows');
  });

  test('a closed follow gives its slot back, so the next open succeeds', async () => {
    const limit = createFollowLimit(1);
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream), acquire: () => limit.acquire('tok') });
    bridgeLogFollow(d, socket, fileTarget());
    await flush();
    expect(limit.active('tok')).toBe(1);

    socket.emit('close');
    expect(limit.active('tok')).toBe(0);

    const next = new FakeSocket();
    const { deps: d2, execStream } = deps({
      stream: Promise.resolve(new FakeStream()),
      acquire: () => limit.acquire('tok'),
    });
    bridgeLogFollow(d2, next, fileTarget());
    await flush();

    expect(execStream).toHaveBeenCalledTimes(1);
    expect(next.closed).toBe(false);
  });

  test('a refused request never spends a slot', async () => {
    const limit = createFollowLimit(1);
    const socket = new FakeSocket();
    const { deps: d } = deps({ isPathAllowed: () => false, acquire: () => limit.acquire('tok') });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    expect(socket.closeCode).toBe(1011);
    expect(limit.active('tok')).toBe(0);
  });

  test('a channel that fails to open gives its slot back', async () => {
    const limit = createFollowLimit(1);
    const socket = new FakeSocket();
    const { deps: d } = deps({
      stream: Promise.reject(new Error('permission denied')) as any,
      acquire: () => limit.acquire('tok'),
    });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();
    await flush();

    expect(socket.closeCode).toBe(1011);
    expect(limit.active('tok')).toBe(0);
  });
});

// ssh2 puts a channel's stderr on a separate readable. Leaving it unread
// costs twice: the most common real failure of this feature (no NOPASSWD
// sudoers rule) becomes a generic "log stream closed" with the actual
// diagnosis sitting unread, and those bytes sit outside the backpressure
// scheme, holding channel window the log output does not get.
describe('stderr', () => {
  test('maps a sudo failure to the actionable hint, naming the privileged account', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream), user: 'deploy', host: 'web1' });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
    stream.emit('close');

    expect(socket.closeCode).toBe(1011);
    expect(socket.closeReason).toContain('deploy@web1');
    expect(socket.closeReason).not.toBe('log stream closed');
  });

  test('surfaces a non-sudo stderr message verbatim rather than a generic close', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.stderr.emit(
      'data',
      Buffer.from("tail: cannot open '/var/log/nginx/access.log' for reading: No such file or directory\n")
    );
    stream.emit('close');

    expect(socket.closeReason).toContain('cannot open');
  });

  test('reports the same diagnosis when the channel errors rather than closing', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.stderr.emit('data', Buffer.from('sudo: no tty present and no askpass program specified\n'));
    stream.emit('error', new Error('connection reset'));

    expect(socket.closeCode).toBe(1011);
    expect(socket.closeReason).not.toBe('log channel error');
  });

  test('falls back to the generic reason when stderr said nothing', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.emit('close');

    expect(socket.closeReason).toBe('log stream closed');
  });

  test('a long stderr reason still fits a close frame', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.stderr.emit('data', Buffer.from('x'.repeat(9000)));
    stream.emit('close');

    expect(Buffer.byteLength(socket.closeReason || '', 'utf8')).toBeLessThanOrEqual(123);
  });

  test('stderr is never forwarded to the client as log output', async () => {
    const stream = new FakeStream();
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));

    expect(socket.sent).toEqual([]);
  });

  test('a channel with no stderr readable at all still tears down cleanly', async () => {
    const stream = new FakeStream();
    delete (stream as any).stderr;
    const socket = new FakeSocket();
    const { deps: d } = deps({ stream: Promise.resolve(stream) });

    bridgeLogFollow(d, socket, fileTarget());
    await flush();

    expect(() => stream.emit('close')).not.toThrow();
    expect(socket.closeReason).toBe('log stream closed');
  });
});
