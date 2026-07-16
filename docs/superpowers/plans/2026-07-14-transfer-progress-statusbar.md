# Live Transfer Progress in the Status Bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live byte progress (transferred / total), transfer speed, and ETA in the SFTP status bar during uploads and downloads — per-file for single transfers, aggregated (files done/total + combined bytes) for folder / multi-file transfers.

**Architecture:** A new `TransferAggregator` singleton (on the shared `app` object) becomes the sole owner of the status bar text during transfers. A tiny `ProgressStream` Transform, inserted into the transfer pipe, counts bytes as they flow and reports them to the task; the task forwards them to the aggregator, which throttles rendering to the existing `StatusBarItem`. Per-file size is threaded from the directory walk into each `TransferTask`, so totals are known before transfers start.

**Tech Stack:** TypeScript 3.9, Node streams, Jest (config in `package.json`, tests live in `**/__tests__/*.ts`), VS Code extension host.

## Global Constraints

- All sizes/speeds are **byte-based** (megabytes, not megabits): `1 KB = 1024 bytes`. Speed is bytes/sec.
- Units uppercase: `B` / `KB` / `MB` / `GB` / `TB`.
- The `➞` glyph in `TransferDirection` (U+279E) is unchanged.
- Do **not** switch the transport off the ssh2 streaming API (no `fastGet`/`fastPut`).
- Byte counting must be **passive** — it must not alter transfer correctness or drop data.
- Keep Sorbet-style types? No — this is a TS project; add types matching existing style (`typed` pragmas are Homebrew-only and do not apply here). New files use explicit types on exported functions.
- Run tests with `npx jest` (script: `npm test`). Run a single file with `npx jest <path>`.

## File Structure

**Create:**
- `src/ui/transferFormat.ts` — pure formatters (`formatBytes`, `formatSpeed`, `formatDuration`) + `SpeedWindow` class.
- `src/ui/__tests__/transferFormat-test.ts` — unit tests for the above.
- `src/core/progressStream.ts` — `ProgressStream` Transform that counts bytes passing through.
- `src/core/__tests__/progressStream-test.ts` — unit tests.
- `src/ui/transferAggregator.ts` — `TransferAggregator` class (state + throttled rendering).
- `src/ui/__tests__/transferAggregator-test.ts` — unit tests.

**Modify:**
- `src/core/transferTask.ts` — add `size` to `TransferOption`, `get size()`, public `onProgress`, insert `ProgressStream` in `_transferFile`.
- `src/fileHandlers/transfer/transfer.ts` — propagate per-file `size` into every task's `transferOption`.
- `src/fileHandlers/transfer/__tests__/transfer-test.ts` — assert propagated `size`.
- `src/app.ts` — instantiate `app.transferAggregator`.
- `src/core/fileService.ts` — call `beginOperation` / `registerTask` / `endOperation` around the transfer scheduler lifecycle.
- `src/modules/serviceManager/index.ts` — route `beforeTransfer` / `afterTransfer` through the aggregator; wire `task.onProgress`.

---

### Task 1: Byte / speed / duration formatters + speed window

**Files:**
- Create: `src/ui/transferFormat.ts`
- Test: `src/ui/__tests__/transferFormat-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatBytes(n: number): string` — e.g. `formatBytes(1258) === '1.23 KB'`, `formatBytes(0) === '0 B'`.
  - `formatSpeed(bytesPerSec: number): string` — e.g. `formatSpeed(460800) === '450 KB/s'`.
  - `formatDuration(seconds: number): string` — e.g. `formatDuration(44) === '44s'`, `formatDuration(360) === '6m'`, `formatDuration(366) === '6m 6s'`.
  - `class SpeedWindow` with `add(t: number, cumulativeBytes: number): void`, `speed(): number` (bytes/sec, `0` if unknown), `reset(): void`. Constructor `new SpeedWindow(windowMs = 1000)`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/__tests__/transferFormat-test.ts`:

```ts
import { formatBytes, formatSpeed, formatDuration, SpeedWindow } from '../transferFormat';

describe('formatBytes', () => {
  it('formats zero as 0 B', () => expect(formatBytes(0)).toBe('0 B'));
  it('formats bytes with no decimals', () => expect(formatBytes(512)).toBe('512 B'));
  it('formats 1023 B without rolling to KB', () => expect(formatBytes(1023)).toBe('1023 B'));
  it('formats exactly 1 KB', () => expect(formatBytes(1024)).toBe('1 KB'));
  it('trims trailing zeros', () => expect(formatBytes(1536)).toBe('1.5 KB'));
  it('keeps two decimals', () => expect(formatBytes(1258)).toBe('1.23 KB'));
  it('formats whole MB', () => expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB'));
  it('formats GB', () => expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB'));
});

describe('formatSpeed', () => {
  it('appends /s', () => expect(formatSpeed(450 * 1024)).toBe('450 KB/s'));
  it('formats zero speed', () => expect(formatSpeed(0)).toBe('0 B/s'));
});

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(44)).toBe('44s'));
  it('rounds fractional seconds', () => expect(formatDuration(44.6)).toBe('45s'));
  it('formats whole minutes', () => expect(formatDuration(360)).toBe('6m'));
  it('formats minutes and seconds', () => expect(formatDuration(366)).toBe('6m 6s'));
  it('formats whole hours', () => expect(formatDuration(7200)).toBe('2h'));
  it('formats hours and minutes', () => expect(formatDuration(7260)).toBe('2h 1m'));
});

describe('SpeedWindow', () => {
  it('returns 0 with fewer than two samples', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    expect(w.speed()).toBe(0);
  });
  it('computes bytes/sec across samples', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(500, 500); // 500 bytes in 0.5s => 1000 B/s
    expect(w.speed()).toBe(1000);
  });
  it('drops samples older than the window', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(1000, 1000);
    w.add(2000, 3000); // window keeps baseline at t=1000: 2000 bytes in 1s => 2000 B/s
    expect(w.speed()).toBe(2000);
  });
  it('resets', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(500, 500);
    w.reset();
    expect(w.speed()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/ui/__tests__/transferFormat-test.ts`
Expected: FAIL — `Cannot find module '../transferFormat'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/transferFormat.ts`:

```ts
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!n || n < 0) {
    return '0 B';
  }
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  if (i === 0) {
    return `${Math.round(n)} B`;
  }
  const value = n / Math.pow(1024, i);
  const trimmed = parseFloat(value.toFixed(2)); // drops trailing zeros: 1.50 -> 1.5, 1.00 -> 1
  return `${trimmed} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export class SpeedWindow {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(private windowMs: number = 1000) {}

  add(t: number, cumulativeBytes: number): void {
    this.samples.push({ t, bytes: cumulativeBytes });
    const cutoff = t - this.windowMs;
    // keep one sample just outside the window as the baseline
    while (this.samples.length > 2 && this.samples[1].t < cutoff) {
      this.samples.shift();
    }
  }

  speed(): number {
    if (this.samples.length < 2) {
      return 0;
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) {
      return 0;
    }
    return (last.bytes - first.bytes) / dt;
  }

  reset(): void {
    this.samples = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/ui/__tests__/transferFormat-test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/ui/transferFormat.ts src/ui/__tests__/transferFormat-test.ts
git commit -m "feat: add byte/speed/duration formatters for transfer progress"
```

---

### Task 2: ProgressStream counting Transform

**Files:**
- Create: `src/core/progressStream.ts`
- Test: `src/core/__tests__/progressStream-test.ts`

**Why a Transform, not a `.on('data')` listener:** in the upload path `sftpFileSystem.put()` does `await this.fchmod(...)` *before* it pipes the input (`_put` → `input.pipe(writer)`). Attaching a raw `data` listener at the task level would switch the source into flowing mode during that await and lose the first chunks. A Transform interposed in the pipe buffers with backpressure, so no data is lost regardless of when the destination attaches.

**Interfaces:**
- Consumes: nothing (Node `stream.Transform`).
- Produces: `class ProgressStream extends Transform`, `new ProgressStream(onBytes: (cumulative: number) => void)`. It passes every chunk through unchanged and calls `onBytes` with the running total after each chunk.

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/progressStream-test.ts`:

```ts
import { Readable } from 'stream';
import ProgressStream from '../progressStream';

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('ProgressStream', () => {
  it('passes all bytes through unchanged', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const progress = new ProgressStream(() => undefined);
    const out = await collect(source.pipe(progress));
    expect(out.toString()).toBe('hello world');
  });

  it('reports cumulative byte counts', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const seen: number[] = [];
    const progress = new ProgressStream(n => seen.push(n));
    await collect(source.pipe(progress));
    expect(seen[seen.length - 1]).toBe(11); // 'hello world'
    expect(seen).toEqual([6, 11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/__tests__/progressStream-test.ts`
Expected: FAIL — `Cannot find module '../progressStream'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/progressStream.ts`:

```ts
import { Transform, TransformCallback } from 'stream';

export default class ProgressStream extends Transform {
  private _bytes = 0;

  constructor(private _onBytes: (cumulative: number) => void) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this._bytes += chunk.length;
    try {
      this._onBytes(this._bytes);
    } catch {
      // never let a progress callback break the transfer
    }
    callback(null, chunk);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/core/__tests__/progressStream-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/progressStream.ts src/core/__tests__/progressStream-test.ts
git commit -m "feat: add ProgressStream transform for counting transferred bytes"
```

---

### Task 3: Thread size + onProgress through TransferTask

**Files:**
- Modify: `src/core/transferTask.ts`
- Test: `src/core/__tests__/progressStream-test.ts` is separate; add a small getter test here: `src/core/__tests__/transferTask-test.ts` (create).

**Interfaces:**
- Consumes: `ProgressStream` from Task 2.
- Produces:
  - `TransferOption.size?: number` (new optional field).
  - `TransferTask.get size(): number` — returns `this._TransferOption.size ?? 0`.
  - `TransferTask.onProgress?: (transferred: number, total: number) => void` — public, settable, defaults undefined.
  - `_transferFile` now pipes `srcFs.get()` output through a `ProgressStream` before handing it to `targetFs.put()`.

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/transferTask-test.ts`:

```ts
import TransferTask, { TransferDirection } from '../transferTask';
import { FileType } from '../fs';

describe('TransferTask.size', () => {
  const fakeFs: any = { pathResolver: {} };

  it('exposes the size from transferOption', () => {
    const task = new TransferTask(
      { fsPath: '/a', fileSystem: fakeFs },
      { fsPath: '/b', fileSystem: fakeFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { atime: 0, mtime: 0, perserveTargetMode: false, size: 1234 },
      }
    );
    expect(task.size).toBe(1234);
  });

  it('defaults size to 0 when unset', () => {
    const task = new TransferTask(
      { fsPath: '/a', fileSystem: fakeFs },
      { fsPath: '/b', fileSystem: fakeFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { atime: 0, mtime: 0, perserveTargetMode: false },
      }
    );
    expect(task.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/__tests__/transferTask-test.ts`
Expected: FAIL — `size` does not exist on `TransferTask` (property missing / returns undefined).

- [ ] **Step 3: Add `size` to `TransferOption` and the getter + `onProgress` field**

In `src/core/transferTask.ts`, extend the interface (add `size`):

```ts
export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  size?: number;
}
```

Add the import at the top of the file (below the existing `import { Readable } from 'stream';`):

```ts
import ProgressStream from './progressStream';
```

Add the public field and getter to the class. Put the field declaration next to `private _cancelled: boolean;`:

```ts
  private _cancelled: boolean;
  onProgress?: (transferred: number, total: number) => void;
```

Add the getter next to the other getters (after `get transferType()`):

```ts
  get size(): number {
    return this._TransferOption.size || 0;
  }
```

- [ ] **Step 4: Run test to verify the getter passes**

Run: `npx jest src/core/__tests__/transferTask-test.ts`
Expected: PASS.

- [ ] **Step 5: Insert ProgressStream into `_transferFile`**

In `src/core/transferTask.ts`, inside `_transferFile`, replace the `try { ... await targetFs.put(this._handle, uploadTarget, {...}) ...` so the stream handed to `put` is wrapped. Locate this block (currently around lines 173-181):

```ts
    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await targetFs.put(this._handle, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
```

Replace it with:

```ts
    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      let input: Readable = this._handle;
      if (this.onProgress) {
        const progressStream = new ProgressStream(transferred =>
          this.onProgress!(transferred, this.size)
        );
        // forward source errors so `put`'s `input.once('error')` still tears down the writer
        this._handle.once('error', err => progressStream.emit('error', err));
        input = this._handle.pipe(progressStream);
      }
      await targetFs.put(input, uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
```

Rationale: `this._handle` stays the source so `cancel()` (which calls `FileSystem.abortReadableStream(this._handle)`) is unchanged. When `onProgress` is set (always true in real runs — see Task 8), bytes flow source → ProgressStream → writer, and the ProgressStream buffers under backpressure so nothing is lost during `sftp.put`'s pre-pipe `await fchmod`.

- [ ] **Step 6: Run the transferTask + progressStream tests + typecheck**

Run: `npx jest src/core/__tests__/transferTask-test.ts src/core/__tests__/progressStream-test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p .` (or `npx tsc --noEmit`)
Expected: no new type errors in `src/core/transferTask.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/core/transferTask.ts src/core/__tests__/transferTask-test.ts
git commit -m "feat: thread size and progress reporting through TransferTask"
```

---

### Task 4: Propagate per-file size in the transfer walk

**Files:**
- Modify: `src/fileHandlers/transfer/transfer.ts`
- Test: `src/fileHandlers/transfer/__tests__/transfer-test.ts`

**Interfaces:**
- Consumes: `TransferOption.size` (Task 3), `FileEntry.size` / `FileStats.size` (already exist on `src/core/fs/fileSystem.ts`).
- Produces: every `TransferTask` collected by `transfer()` / `sync()` now carries `transferOption.size` equal to the source file's byte size.

- [ ] **Step 1: Write the failing test**

In `src/fileHandlers/transfer/__tests__/transfer-test.ts`, add a new `describe` block at the end of the file's top-level `describe('transfer algorithm', ...)` (before its closing `});`). It reuses the existing `fillFs`, `file`, `mapList`, `localFs` helpers:

```ts
  describe('size propagation', () => {
    afterEach(() => {
      vol.reset();
    });

    test('sync tasks carry source file size', async () => {
      fillFs({
        local: {
          a: file('abcde'), // 5 bytes
          b: file('xy'),    // 2 bytes
        },
        remote: {},
      });

      const tasks: TransferTask[] = [];
      const collect = (t: TransferTask) => tasks.push(t);
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: { perserveTargetMode: false },
        },
        collect
      );

      const byTarget: { [k: string]: number } = {};
      tasks.forEach(t => {
        byTarget[t.targetFsPath] = t.size;
      });
      expect(byTarget['/remote/a'.replace(/\//g, path.sep)]).toBe(5);
      expect(byTarget['/remote/b'.replace(/\//g, path.sep)]).toBe(2);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/fileHandlers/transfer/__tests__/transfer-test.ts -t "size propagation"`
Expected: FAIL — `byTarget[...]` is `0` (size not yet propagated), not `5`/`2`.

- [ ] **Step 3: Propagate size in `transferFolder`**

In `src/fileHandlers/transfer/transfer.ts`, in `transferFolder`, the `fileEntries.map` spreads `mtime`/`atime` from `file`. Add `size`:

```ts
          transferOption: {
            ...config.transferOption,
            mtime: file.mtime,
            atime: file.atime,
            size: file.size,
          },
```

- [ ] **Step 4: Propagate size in the single-file `transfer()` entry**

In `src/fileHandlers/transfer/transfer.ts`, in `transfer()`, add `size: stat.size` to `transferOption`:

```ts
  const transferOption = {
    ...config.transferOption,
    fallbackMode: stat.mode,
    mtime: stat.mtime,
    atime: stat.atime,
    size: stat.size,
    filePerm: config?.filePerm,
    dirPerm: config?.dirPerm
  };
```

- [ ] **Step 5: Propagate size in `_sync`'s task options**

In `src/fileHandlers/transfer/transfer.ts`, inside `_sync` → `syncFiles`, there are three `file2trans.push([...])` sites. Add `size` to each option object using the file whose bytes will move:

Site 1 — files exist on both sides (uses `from`):

```ts
              file2trans.push([
                from.fspath,
                to.fspath,
                direction,
                {
                  ...transferOption,
                  mode: to.mode, // prefer target mode
                  mtime: from.mtime,
                  atime: from.atime,
                  size: from.size,
                },
              ]);
```

Site 2 — files exist only on src (uses `srcFile`):

```ts
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
              size: srcFile.size,
            },
          ]);
```

Site 3 — files exist only on target, both-directions (uses `file`):

```ts
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                  size: file.size,
                },
              ]);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/fileHandlers/transfer/__tests__/transfer-test.ts`
Expected: PASS (new `size propagation` test plus all existing `sync` tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/fileHandlers/transfer/transfer.ts src/fileHandlers/transfer/__tests__/transfer-test.ts
git commit -m "feat: propagate per-file size into transfer tasks"
```

---

### Task 5: TransferAggregator

**Files:**
- Create: `src/ui/transferAggregator.ts`
- Test: `src/ui/__tests__/transferAggregator-test.ts`

**Interfaces:**
- Consumes: `formatBytes`, `formatSpeed`, `formatDuration`, `SpeedWindow` (Task 1).
- Produces: `class TransferAggregator` (default export) with:
  - `constructor(bar: StatusLike, opts?: { now?: () => number; throttleMs?: number })` where `StatusLike = { showMsg(text: string, tooltip?: any, hideAfterTimeout?: number): void }`. When `throttleMs === 0`, renders synchronously (used by tests).
  - `beginOperation(): void`
  - `registerTask(task: { size: number }): void`
  - `onTaskStart(task: object, info: { direction: string; filename: string; filepath: string }): void`
  - `onTaskProgress(task: object, transferred: number): void`
  - `onTaskDone(task: object, result: { error?: boolean; cancelled?: boolean }): void`
  - `endOperation(): void`

**Behavior contract (verified by tests):**
- `transferredBytes = baseBytes + Σ inFlight`.
- Single-file text: `${direction} ${filename}  ${xfer}[ / ${total}][ · ${speed}][ · ${eta} left]`.
- Multi-file text (`totalFiles > 1`): `${direction}  (${doneFiles}/${totalFiles} files)  ${xfer}[ / ${total}][ · ${speed}][ · ${eta} left]`.
- Unknown total (`totalBytes <= 0`): omit `/ total` and ETA.
- Speed `0`: omit `· speed` and ETA.
- On the last `endOperation` (refcount to 0): render the terminal summary with a 4000 ms auto-reset, then reset all state. If nothing transferred (`totalFiles === 0`), reset silently (no message).

- [ ] **Step 1: Write the failing test**

Create `src/ui/__tests__/transferAggregator-test.ts`:

```ts
import TransferAggregator from '../transferAggregator';

function makeBar() {
  const calls: Array<{ text: string; tooltip?: any; timeout?: number }> = [];
  return {
    calls,
    showMsg(text: string, tooltip?: any, timeout?: number) {
      calls.push({ text, tooltip, timeout });
    },
    last() {
      return calls[calls.length - 1];
    },
  };
}

// controllable clock
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const DL = 'remote ➞ local';

describe('TransferAggregator single file', () => {
  it('renders transferred / total, speed and ETA', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const task = {};

    agg.beginOperation();
    agg.registerTask({ size: 20 * 1024 * 1024 }); // 20 MB total
    agg.onTaskStart(task, { direction: DL, filename: 'exception.log', filepath: '/x' });

    clock.advance(1000);
    agg.onTaskProgress(task, 450 * 1024); // 450 KB after 1s at t=0 baseline
    // add a second sample so speed can be computed
    clock.advance(1000);
    agg.onTaskProgress(task, 900 * 1024);

    const text = bar.last().text;
    expect(text).toContain(`${DL} exception.log`);
    expect(text).toContain('900 KB / 20 MB');
    expect(text).toContain('· 450 KB/s');
    expect(text).toContain('left');
  });

  it('drops total and ETA when size is unknown', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const task = {};
    agg.beginOperation();
    agg.registerTask({ size: 0 });
    agg.onTaskStart(task, { direction: DL, filename: 'x.log', filepath: '/x' });
    clock.advance(1000);
    agg.onTaskProgress(task, 1258);
    const text = bar.last().text;
    expect(text).toContain('1.23 KB');
    expect(text).not.toContain('/');
    expect(text).not.toContain('left');
  });

  it('shows a done summary and auto-reset on completion', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const task = {};
    agg.beginOperation();
    agg.registerTask({ size: 10 });
    agg.onTaskStart(task, { direction: DL, filename: 'x.log', filepath: '/x' });
    agg.onTaskProgress(task, 10);
    agg.onTaskDone(task, {});
    agg.endOperation();
    expect(bar.last().text).toBe('done x.log');
    expect(bar.last().timeout).toBe(4000);
  });
});

describe('TransferAggregator multi file', () => {
  it('renders aggregate file counts and combined bytes', () => {
    const bar = makeBar();
    const clock = makeClock();
    const agg = new TransferAggregator(bar as any, { now: clock.now, throttleMs: 0 });
    const t1 = {}, t2 = {}, t3 = {};

    agg.beginOperation();
    agg.registerTask({ size: 100 * 1024 * 1024 });
    agg.registerTask({ size: 100 * 1024 * 1024 });
    agg.registerTask({ size: 10 * 1024 * 1024 }); // total 210 MB, 3 files

    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskProgress(t1, 100 * 1024 * 1024);
    agg.onTaskDone(t1, {}); // 1 done, 100 MB base

    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    clock.advance(1000);
    agg.onTaskProgress(t2, 45 * 1024 * 1024); // base 100 + 45 = 145 MB
    clock.advance(1000);
    agg.onTaskProgress(t2, 45 * 1024 * 1024);

    const text = bar.last().text;
    expect(text).toContain(`${DL}  (1/3 files)`);
    expect(text).toContain('145 MB / 210 MB');
  });

  it('summarizes failures', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const t1 = {}, t2 = {};
    agg.beginOperation();
    agg.registerTask({ size: 10 });
    agg.registerTask({ size: 10 });
    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskDone(t1, {});
    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    agg.onTaskDone(t2, { error: true });
    agg.endOperation();
    expect(bar.last().text).toBe('done 1 files, 1 failed');
  });

  it('spans multiple operations via refcount (no early reset)', () => {
    const bar = makeBar();
    const agg = new TransferAggregator(bar as any, { throttleMs: 0 });
    const t1 = {}, t2 = {};
    agg.beginOperation(); // op A
    agg.beginOperation(); // op B
    agg.registerTask({ size: 10 });
    agg.registerTask({ size: 10 });
    agg.onTaskStart(t1, { direction: DL, filename: 'a', filepath: '/a' });
    agg.onTaskDone(t1, {});
    agg.endOperation(); // op A done, but B still active -> no terminal message yet
    const beforeCount = bar.calls.length;
    agg.onTaskStart(t2, { direction: DL, filename: 'b', filepath: '/b' });
    agg.onTaskDone(t2, {});
    agg.endOperation(); // now refcount 0
    expect(bar.last().text).toBe('done 2 files');
    expect(bar.calls.length).toBeGreaterThan(beforeCount);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/ui/__tests__/transferAggregator-test.ts`
Expected: FAIL — `Cannot find module '../transferAggregator'`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/transferAggregator.ts`:

```ts
import { formatBytes, formatSpeed, formatDuration, SpeedWindow } from './transferFormat';

interface StatusLike {
  showMsg(text: string, tooltip?: any, hideAfterTimeout?: number): void;
}

interface TaskLike {
  size: number;
}

export default class TransferAggregator {
  private bar: StatusLike;
  private now: () => number;
  private throttleMs: number;

  private activeOps = 0;
  private totalFiles = 0;
  private doneFiles = 0;
  private failedFiles = 0;
  private cancelledAny = false;
  private totalBytes = 0;
  private baseBytes = 0;
  private inFlight = new Map<object, number>();
  private speedWindow = new SpeedWindow(1000);

  private direction = '';
  private lastFilename = '';
  private lastFilepath = '';

  private renderTimer: any = null;

  constructor(bar: StatusLike, opts: { now?: () => number; throttleMs?: number } = {}) {
    this.bar = bar;
    this.now = opts.now || (() => Date.now());
    this.throttleMs = opts.throttleMs === undefined ? 300 : opts.throttleMs;
  }

  beginOperation(): void {
    this.activeOps += 1;
  }

  registerTask(task: TaskLike): void {
    this.totalFiles += 1;
    this.totalBytes += task.size || 0;
  }

  onTaskStart(task: object, info: { direction: string; filename: string; filepath: string }): void {
    this.inFlight.set(task, 0);
    this.direction = info.direction;
    this.lastFilename = info.filename;
    this.lastFilepath = info.filepath;
    this.scheduleRender();
  }

  onTaskProgress(task: object, transferred: number): void {
    this.inFlight.set(task, transferred);
    this.speedWindow.add(this.now(), this.transferredBytes());
    this.scheduleRender();
  }

  onTaskDone(task: object, result: { error?: boolean; cancelled?: boolean }): void {
    this.doneFiles += 1;
    if (result.cancelled) {
      this.cancelledAny = true;
    } else if (result.error) {
      this.failedFiles += 1;
    }
    this.baseBytes += this.inFlight.get(task) || 0;
    this.inFlight.delete(task);
    this.scheduleRender();
  }

  endOperation(): void {
    this.activeOps -= 1;
    if (this.activeOps > 0) {
      return;
    }
    this.activeOps = 0;
    this.finalize();
  }

  private transferredBytes(): number {
    let sum = this.baseBytes;
    this.inFlight.forEach(v => (sum += v));
    return sum;
  }

  private scheduleRender(): void {
    if (this.throttleMs <= 0) {
      this.render();
      return;
    }
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, this.throttleMs);
  }

  private composeText(): string {
    const xfer = this.transferredBytes();
    const known = this.totalBytes > 0;
    const speed = this.speedWindow.speed();

    let sizePart = formatBytes(xfer);
    if (known) {
      sizePart += ` / ${formatBytes(this.totalBytes)}`;
    }
    let tail = '';
    if (speed > 0) {
      tail += ` · ${formatSpeed(speed)}`;
      if (known) {
        const remaining = Math.max(0, this.totalBytes - xfer);
        tail += ` · ${formatDuration(remaining / speed)} left`;
      }
    }

    if (this.totalFiles > 1) {
      return `${this.direction}  (${this.doneFiles}/${this.totalFiles} files)  ${sizePart}${tail}`;
    }
    return `${this.direction} ${this.lastFilename}  ${sizePart}${tail}`;
  }

  private composeTooltip(): string {
    if (this.totalFiles > 1) {
      return `${this.doneFiles}/${this.totalFiles} files`;
    }
    return this.lastFilepath;
  }

  private render(): void {
    if (this.activeOps <= 0 && this.inFlight.size === 0) {
      return;
    }
    this.bar.showMsg(this.composeText(), this.composeTooltip());
  }

  private finalize(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    if (this.totalFiles === 0) {
      this.reset();
      return;
    }

    let text: string;
    if (this.totalFiles > 1) {
      if (this.cancelledAny) {
        text = `cancelled (${this.doneFiles}/${this.totalFiles})`;
      } else if (this.failedFiles > 0) {
        text = `done ${this.doneFiles - this.failedFiles} files, ${this.failedFiles} failed`;
      } else {
        text = `done ${this.totalFiles} files`;
      }
    } else {
      if (this.cancelledAny) {
        text = `cancelled ${this.lastFilename}`;
      } else if (this.failedFiles > 0) {
        text = `failed ${this.lastFilename}`;
      } else {
        text = `done ${this.lastFilename}`;
      }
    }

    this.bar.showMsg(text, this.composeTooltip(), 4000);
    this.reset();
  }

  private reset(): void {
    this.activeOps = 0;
    this.totalFiles = 0;
    this.doneFiles = 0;
    this.failedFiles = 0;
    this.cancelledAny = false;
    this.totalBytes = 0;
    this.baseBytes = 0;
    this.inFlight.clear();
    this.speedWindow.reset();
    this.direction = '';
    this.lastFilename = '';
    this.lastFilepath = '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/ui/__tests__/transferAggregator-test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/ui/transferAggregator.ts src/ui/__tests__/transferAggregator-test.ts
git commit -m "feat: add TransferAggregator for live status bar progress"
```

---

### Task 6: Instantiate the aggregator on `app`

**Files:**
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `TransferAggregator` (Task 5), existing `app.sftpBarItem`.
- Produces: `app.transferAggregator: TransferAggregator`, available to `fileService` and `serviceManager`.

- [ ] **Step 1: Add the import and field**

In `src/app.ts`, add the import below the `StatusBarItem` import:

```ts
import StatusBarItem from './ui/statusBarItem';
import TransferAggregator from './ui/transferAggregator';
```

Add `transferAggregator` to the `App` interface:

```ts
interface App {
  fsCache: LRU.Cache<string, string>;
  state: AppState;
  sftpBarItem: StatusBarItem;
  transferAggregator: TransferAggregator;
  remoteExplorer: RemoteExplorer;
  dbExplorer: DbExplorer;
  context: vscode.ExtensionContext;
}
```

Instantiate it after `app.sftpBarItem = ...` (it depends on the bar):

```ts
app.transferAggregator = new TransferAggregator(app.sftpBarItem);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (`TransferAggregator`'s constructor accepts `StatusBarItem` structurally because `StatusBarItem` has a matching `showMsg`.)

- [ ] **Step 3: Commit**

```bash
git add src/app.ts
git commit -m "feat: register TransferAggregator on the app singleton"
```

---

### Task 7: Wire the scheduler lifecycle in FileService

**Files:**
- Modify: `src/core/fileService.ts`

**Interfaces:**
- Consumes: `app.transferAggregator` (Task 6), `TransferTask.size` (Task 3).
- Produces: `beginOperation` fires once per transfer scheduler; `registerTask` fires per enqueued task (so totals are known before `run()`); `endOperation` fires exactly once when the scheduler drains **or** is stopped/cancelled.

`app` is already imported in `src/core/fileService.ts` (line 5).

- [ ] **Step 1: Call `beginOperation` and set up an idempotent `finish` in `createTransferScheduler`**

In `src/core/fileService.ts`, inside `createTransferScheduler`, just after the `scheduler` is created and its `onTaskStart`/`onTaskDone` handlers are attached (before `let runningPromise ...`), add:

```ts
    app.transferAggregator.beginOperation();
    let ended = false;
    const finish = () => {
      if (!ended) {
        ended = true;
        app.transferAggregator.endOperation();
      }
    };
```

- [ ] **Step 2: Register each task in `add`, and call `finish` in `stop` and the drain paths**

Still inside the `transferScheduler` object in `createTransferScheduler`, update `stop`, `add`, and `run`:

```ts
      stop() {
        isStopped = true;
        scheduler.empty();
        finish();
      },
      add(task: TransferTask) {
        if (isStopped) {
          return;
        }

        app.transferAggregator.registerTask(task);
        scheduler.add(task);
      },
      run() {
        if (isStopped) {
          return Promise.resolve();
        }

        if (scheduler.size <= 0) {
          fileService._removeScheduler(transferScheduler);
          finish();
          return Promise.resolve();
        }

        if (!runningPromise) {
          runningPromise = new Promise(resolve => {
            scheduler.onIdle(() => {
              runningPromise = null;
              fileService._removeScheduler(transferScheduler);
              finish();
              resolve();
            });
            scheduler.start();
          });
        }
        return runningPromise;
      },
```

Note: `finish` is idempotent, so the `stop()` path used by `cancelTransferTasks` (which does not go through `_removeScheduler`) still ends the operation exactly once, and the normal `onIdle` drain path also ends it exactly once.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the full unit suite (nothing should regress)**

Run: `npx jest`
Expected: PASS. FileService has no direct unit test; the transfer + aggregator + format suites must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/core/fileService.ts
git commit -m "feat: drive TransferAggregator from the transfer scheduler lifecycle"
```

---

### Task 8: Route serviceManager transfer events through the aggregator

**Files:**
- Modify: `src/modules/serviceManager/index.ts`

**Interfaces:**
- Consumes: `app.transferAggregator` (Task 6), `TransferTask.onProgress` (Task 3).
- Produces: the aggregator now owns the status bar text during transfers. `reportError` / `logger` behavior is preserved; the direct `sftpBarItem.showMsg` calls for transfers are removed (the aggregator renders instead).

- [ ] **Step 1: Replace the `beforeTransfer` handler**

In `src/modules/serviceManager/index.ts`, replace the current `service.beforeTransfer(...)` block (lines 102-108) with:

```ts
  service.beforeTransfer(task => {
    const { localFsPath, transferType } = task;
    const filename = path.basename(localFsPath);
    const filepath = simplifyPath(localFsPath);
    app.transferAggregator.onTaskStart(task, {
      direction: transferType,
      filename,
      filepath,
    });
    task.onProgress = transferred =>
      app.transferAggregator.onTaskProgress(task, transferred);
  });
```

`onTaskStart` runs synchronously inside the scheduler's `EVENT_TASK_START` emit, i.e. before `task.run()` streams any bytes — so `task.onProgress` is guaranteed to be set before `_transferFile` builds its `ProgressStream`.

- [ ] **Step 2: Replace the `afterTransfer` handler**

Replace the current `service.afterTransfer(...)` block (lines 109-125) with:

```ts
  service.afterTransfer((error, task) => {
    const { localFsPath, transferType } = task;
    if (task.isCancelled()) {
      logger.info(`cancel transfer ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, { cancelled: true });
    } else if (error) {
      reportError(error, `when ${transferType} ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, { error: true });
    } else {
      logger.info(`${transferType} ${localFsPath}`);
      app.transferAggregator.onTaskDone(task, {});
    }
  });
```

The terminal `done/failed/cancelled` status text is now produced by the aggregator's `finalize()` (Task 5), so it no longer calls `sftpBarItem.showMsg` here.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. `TransferTask` now has a public `onProgress` (Task 3), so the assignment type-checks.

- [ ] **Step 4: Run the full unit suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serviceManager/index.ts
git commit -m "feat: render live transfer progress via TransferAggregator"
```

---

### Task 9: Manual end-to-end verification in the Extension Development Host

**Files:** none (verification only).

This project is a VS Code extension; the streaming path cannot be exercised by Jest against a real SFTP server. Verify by hand in the Extension Development Host.

- [ ] **Step 1: Build the extension**

Run: `npm run compile`
Expected: webpack build succeeds with no TypeScript errors.

- [ ] **Step 2: Launch the Extension Development Host**

In VS Code, press `F5` (Run Extension) to open a new window with the built extension loaded, opened on a workspace that has a configured `sftp.json` pointing at a reachable SFTP host.

- [ ] **Step 3: Single large file download**

Download one large file (tens of MB) from the remote explorer. Watch the status bar (bottom-left).
Expected: it shows e.g. `⠸ remote ➞ local <name>  4.2 MB / 48 MB · 1.3 MB/s · 34s left`, updating roughly 3×/sec, then finishes with `done <name>` which clears after ~4s.

- [ ] **Step 4: Folder download (aggregate)**

Download a folder containing several files.
Expected: the bar shows `⠸ remote ➞ local  (3/12 files)  45 MB / 210 MB · … · … left`; the file count climbs and bytes accumulate; ends with `done 12 files`.

- [ ] **Step 5: Multi-select**

Select several files/folders together and download.
Expected: totals may tick upward briefly as discovery completes, then the aggregate drains to `done N files`. No `NaN`, `Infinity`, or negative ETA at any point.

- [ ] **Step 6: Upload**

Upload a large file and a folder to the remote.
Expected: same behavior with `local ➞ remote`.

- [ ] **Step 7: Tiny file + cancel**

Download a 1-byte file (expect it to jump straight to `done <name>`). Then start a large transfer and cancel it via the SFTP cancel command.
Expected: cancel yields `cancelled <name>` (single) or `cancelled (x/y)` (batch), and the status bar returns to its idle `SFTP` label — not stuck on a stale progress string.

- [ ] **Step 8: Commit (docs/notes only, if any)**

No code change expected here. If verification surfaces a bug, fix it under the relevant earlier task with its own test, then re-verify.

---

## Self-Review

**Spec coverage:**
- Single-file `transferred / total · speed · ETA` → Tasks 1, 3, 5, 8. ✓
- Uppercase KB/MB/GB, byte-based → Task 1 (`formatBytes`). ✓
- Speed smoothing (~1s window) → Task 1 (`SpeedWindow`). ✓
- ETA formatting + guards (no NaN/Infinity) → Task 1 (`formatDuration`), Task 5 (`speed > 0` / `known` guards). ✓
- Unknown size degradation → Task 5 (test + guard). ✓
- Multi-file aggregate `(done/total files)` + combined bytes → Tasks 4, 5, 7. ✓
- Total known up-front via eager discovery → Task 7 (`registerTask` at enqueue). ✓
- Multi-select spanning schedulers → Task 5 (refcount test) + Task 7 (`beginOperation`/`finish`). ✓
- Terminal summaries (`done N files`, `… failed`, cancelled) → Task 5 (`finalize`) + Task 8. ✓
- Passive byte counting, no data loss during sftp `fchmod` await → Task 2 (Transform + rationale), Task 3 (error forwarding). ✓
- Aggregator owns text; `reportError`/`logger` preserved → Task 8. ✓
- Reset on cancel (no stale bar) → Task 7 (`stop` → `finish`) + Task 9 Step 7. ✓

**Placeholder scan:** none — every code step shows full code; every run step shows the command and expected result.

**Type consistency:** `TransferOption.size?` (Task 3) is read by `get size()` (Task 3), `registerTask({ size })` (Tasks 5, 7), and propagated in Task 4. `onProgress?: (transferred, total) => void` (Task 3) is set in Task 8 and called in Task 3's `_transferFile`. `TransferAggregator` method names (`beginOperation`, `registerTask`, `onTaskStart`, `onTaskProgress`, `onTaskDone`, `endOperation`) are identical across Tasks 5, 7, 8. `StatusLike.showMsg` matches `StatusBarItem.showMsg` overloads structurally.
