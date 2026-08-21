import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { exportFilename, streamExport } from '../dbExportStream';

const DB = { username: 'u', password: 'DB-PASSWORD-4c1f', name: 'shop' };

function fakeDeps(overrides: any = {}) {
  const execs: string[] = [];
  return {
    execs,
    deps: {
      exec: async (cmd: string) => {
        execs.push(cmd);
        return { stdout: '', stderr: '', code: 0 };
      },
      // (Readable as any).from: @types/node is pinned at v9, whose typings
      // predate Readable.from (added in Node 10) -- it exists at runtime
      // under the Jest/Node version this actually runs on, but the plain
      // typed call fails ts-loader's full-program check in `npm run
      // compile` (see global-constraints.md #11). Cast rather than swap to
      // `new Readable({ read() {...} })` so this stays the same one-liner
      // the brief specifies.
      get: async () => (Readable as any).from([Buffer.from('gzipbytes')]),
      remotePath: '/var/www/html',
      randomName: () => 'abc123',
      ...overrides,
    },
  };
}

function fakeSink() {
  const chunks: Buffer[] = [];
  let abort: () => void = () => undefined;
  let drain: () => void = () => undefined;
  return {
    chunks,
    ended: false,
    fireAbort: () => abort(),
    fireDrain: () => drain(),
    sink: {
      write(chunk: Buffer) {
        chunks.push(chunk);
        return true;
      },
      end() {
        (this as any).ended = true;
      },
      onAbort(fn: () => void) {
        abort = fn;
      },
      onDrain(fn: () => void) {
        drain = fn;
      },
    },
  };
}

// A source stream stand-in for the backpressure tests below, deliberately
// NOT a real stream.Readable: a real Readable's switch into/out of flowing
// mode happens on process.nextTick, which would make these tests depend on
// exact tick timing to stay deterministic. This fake's pause()/resume() are
// simple recorded flags, and 'data'/'end' only ever fire when the test
// itself calls emit() -- so "no further chunks are written until drain
// fires" is enforced by the test never emitting one, exactly mirroring what
// a real paused stream guarantees by not emitting 'data' on its own.
class FakeSourceStream extends EventEmitter {
  paused = false;
  destroyed = false;
  pause() {
    this.paused = true;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
}

// Waits for streamExport's two internal `await`s (deps.exec, then deps.get)
// to resolve and for it to reach the point where it attaches listeners to
// the source stream -- setImmediate runs only after the microtask queue
// (every chained promise continuation in between) is fully drained, so this
// is safe regardless of exactly how many microtask hops those awaits take.
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('exportFilename', () => {
  it('names a whole-database dump', () => {
    expect(exportFilename('shop', null, '2026-08-20')).toBe('shop-2026-08-20.sql.gz');
  });

  it('names a single-table dump', () => {
    expect(exportFilename('shop', 'wp_posts', '2026-08-20')).toBe('shop.wp_posts-2026-08-20.sql.gz');
  });

  // The filename lands in a Content-Disposition header. A name carrying a
  // quote or a newline could forge a second header.
  it('replaces characters that are not safe in a header', () => {
    expect(exportFilename('a"b\nc', null, 's')).toBe('a_b_c-s.sql.gz');
  });
});

describe('streamExport', () => {
  it('streams the dump to the sink and ends it', async () => {
    const { deps } = fakeDeps();
    const sink = fakeSink();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, sink.sink as any);
    expect(Buffer.concat(sink.chunks).toString()).toBe('gzipbytes');
  });

  it('stages the dump under remotePath so a chrooted SFTP can read it back', async () => {
    const { deps, execs } = fakeDeps();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    expect(execs[0]).toContain('/var/www/html/.sftp-db-export-tmp');
  });

  // Global Constraint 7.
  it('removes the temp file after a successful stream', async () => {
    const { deps, execs } = fakeDeps();
    await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    expect(execs[execs.length - 1]).toContain('rm -f');
  });

  it('removes the temp file when the dump command fails', async () => {
    const { deps, execs } = fakeDeps({
      exec: async (cmd: string) => {
        execs.push(cmd);
        return cmd.indexOf('rm -f') === -1
          ? { stdout: '', stderr: 'mysqldump: got error 1045', code: 1 }
          : { stdout: '', stderr: '', code: 0 };
      },
    });
    await expect(
      streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any)
    ).rejects.toThrow(/1045/);
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  it('removes the temp file when the download fails', async () => {
    const { deps, execs } = fakeDeps({
      get: async () => {
        throw new Error('sftp closed');
      },
    });
    await expect(
      streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any)
    ).rejects.toThrow('sftp closed');
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  it('removes the temp file when the browser aborts mid-stream', async () => {
    let push: (chunk: Buffer | null) => void = () => undefined;
    const stream = new Readable({ read() {} });
    push = chunk => (chunk === null ? stream.push(null) : stream.push(chunk));
    const { deps, execs } = fakeDeps({ get: async () => stream });
    const sink = fakeSink();
    const pending = streamExport(deps as any, { dbConfig: DB as any, table: null }, sink.sink as any);
    push(Buffer.from('partial'));
    sink.fireAbort();
    await pending.catch(() => undefined);
    expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
  });

  // Global Constraint 1: the dump command embeds MYSQL_PWD. It must never
  // become part of an error message the caller might log or return.
  it('does not put the password in the error it throws', async () => {
    const { deps } = fakeDeps({
      exec: async (cmd: string) =>
        cmd.indexOf('rm -f') === -1
          ? { stdout: '', stderr: 'failed', code: 1 }
          : { stdout: '', stderr: '', code: 0 },
    });
    // toThrow() does not accept an asymmetric matcher, so assert on the
    // caught error directly.
    let caught: Error | null = null;
    try {
      await streamExport(deps as any, { dbConfig: DB as any, table: null }, fakeSink().sink as any);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('DB-PASSWORD-4c1f');
  });

  // Backpressure: streaming into the response must not turn into buffering
  // the whole dump in the extension host's memory just because sink.write()
  // occasionally returns false.
  describe('backpressure', () => {
    it('pauses the source when the sink signals backpressure, writes nothing further, and resumes only once onDrain fires', async () => {
      const source = new FakeSourceStream();
      const { deps } = fakeDeps({ get: async () => source });
      const written: Buffer[] = [];
      const writeResults = [true, false]; // 2nd write signals "buffer full"
      let drain: () => void = () => undefined;
      const sink = {
        write: (chunk: Buffer) => {
          written.push(chunk);
          return writeResults[Math.min(written.length - 1, writeResults.length - 1)];
        },
        end: () => undefined,
        onAbort: () => undefined,
        onDrain: (fn: () => void) => {
          drain = fn;
        },
      };

      const pending = streamExport(deps as any, { dbConfig: DB as any, table: null }, sink as any);
      await flush();

      source.emit('data', Buffer.from('a'));
      expect(source.paused).toBe(false);

      source.emit('data', Buffer.from('b'));
      expect(source.paused).toBe(true); // 1. paused after the write that returned false
      expect(written.length).toBe(2); // 2. nothing further written while paused

      drain();
      expect(source.paused).toBe(false);

      source.emit('data', Buffer.from('c'));
      source.emit('end');
      await pending; // 3. the export still completes correctly once drain is delivered

      expect(Buffer.concat(written).toString()).toBe('abc');
    });

    it('removes the temp file when the browser aborts while the source is paused, and destroys the source', async () => {
      const source = new FakeSourceStream();
      const { deps, execs } = fakeDeps({ get: async () => source });
      let abort: () => void = () => undefined;
      const sink = {
        write: () => false, // every write signals backpressure
        end: () => undefined,
        onAbort: (fn: () => void) => {
          abort = fn;
        },
        onDrain: () => undefined,
      };

      const pending = streamExport(deps as any, { dbConfig: DB as any, table: null }, sink as any);
      await flush();

      source.emit('data', Buffer.from('x'));
      expect(source.paused).toBe(true);

      abort();
      await pending.catch(() => undefined);

      // 4. an abort arriving while paused still destroys the source and
      // removes the temp file.
      expect(source.destroyed).toBe(true);
      expect(execs.some(c => c.indexOf('rm -f') !== -1)).toBe(true);
    });
  });
});
