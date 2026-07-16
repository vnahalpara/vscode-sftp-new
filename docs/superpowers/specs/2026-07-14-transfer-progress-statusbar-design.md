# Live transfer progress in the status bar

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan

## Goal

While a file is uploading or downloading over SFTP, show live progress in the
VS Code status bar item: how many bytes have transferred out of the total file
size, the current transfer speed, and an estimated time remaining. For
multi-file / folder transfers, show an aggregate view (files done / total,
total bytes transferred / total bytes, combined speed, ETA).

Today the status bar text is set **once** when a transfer starts
(`serviceManager/index.ts` → `beforeTransfer` → `sftpBarItem.showMsg`) and never
updated until the transfer finishes. This design adds a live, throttled update
loop.

## Display format

All sizes and speeds are **byte-based (megabytes, not megabits)**: `1 MB = 1024
KB = 1024 * 1024 bytes`. Speed is bytes/sec formatted the same way (`450 KB/s` =
450 kilobytes per second). Units are uppercase: `KB` / `MB` / `GB`.

### Single file (`totalFiles <= 1`)

```
⠸ remote ➞ local exception.log  1.23 KB / 20 MB · 450 KB/s · 44s left
⠸ local ➞ remote backup.sql  8.4 MB / 8.4 MB · 2.1 MB/s · 0s left
```

Structure: `<spinner> <direction> <filename>  <transferred> / <total> · <speed> · <eta>`

- `<direction>` is the existing `TransferDirection` enum string
  (`remote ➞ local` / `local ➞ remote`). The `➞` glyph is U+279E, unchanged.
- The spinner frame is prepended by `StatusBarItem._render()` as it already is.

### Multi-file / folder (`totalFiles > 1`)

```
⠸ remote ➞ local  (3/12 files)  45 MB / 210 MB · 450 KB/s · 6m left
```

Structure: `<spinner> <direction>  (<doneFiles>/<totalFiles> files)  <transferredBytes> / <totalBytes> · <speed> · <eta>`

- No filename in aggregate mode.
- `<direction>` is taken from the tasks in flight (a batch is effectively one
  direction).

### Terminal messages (on idle, unchanged 4s auto-reset)

- Single, success: `done exception.log`
- Single, failure: `failed exception.log`
- Single, cancelled: `cancelled exception.log`
- Multi, all success: `done 12 files`
- Multi, with failures: `done 10 files, 2 failed`
- Multi, cancelled: `cancelled` (existing per-task cancelled handling still fires)

## Edge cases

- **Unknown total size** (`stat.size` is 0, missing, or fails): drop the
  `/ <total>` segment and the ETA. Single: `1.23 KB · 450 KB/s`. Never render
  `NaN`, `Infinity`, or a negative ETA.
- **Speed not yet established** (fewer than ~2 samples / <~300ms elapsed): omit
  the ETA until a real speed exists; show transferred (+ total) only.
- **Tiny / instant files**: the throttle (~300ms) means these may skip straight
  to the terminal `done` message without an intermediate frame. Acceptable.
- **Multi-select discovery**: multi-selecting N items fans out into N
  independent schedulers that walk their trees in parallel. The aggregate
  `totalFiles` / `totalBytes` therefore climb during the first moment as each
  walk completes, then `doneFiles` counts up as transfers finish. Accepted as
  accurate and self-correcting; we do NOT pre-scan everything before showing
  progress.
- **Cancel / error mid-transfer**: existing `afterTransfer` handling is
  preserved; the aggregator counts a task as done (with an error flag) so the
  batch can still drain and reset.

## Architecture

### New component: `TransferAggregator`

A process-wide singleton created alongside `app.sftpBarItem` in `src/app.ts`.
It becomes the **single owner of the status bar text during transfers** — the
existing per-file text-setting in `serviceManager` is routed through it instead
of writing to `sftpBarItem` directly, so the two never fight over the text.

**State:**

- `totalFiles: number`, `doneFiles: number`, `failedFiles: number`
- `totalBytes: number` — sum of known per-file sizes (may grow during discovery)
- `baseBytes: number` — sum of sizes of fully-completed files
- `inFlight: Map<TransferTask, number>` — live transferred bytes per running task
- a rolling speed window: timestamped samples of cumulative transferred bytes,
  keeping ~1s of history so the displayed speed is smoothed, not jumpy
- `activeOps: number` — refcount of in-progress transfer operations

`transferredBytes` (derived) = `baseBytes + sum(inFlight.values())`.

**API:**

- `beginOperation()` / `endOperation()` — refcount. On the count returning to 0
  (all activity idle), render the terminal message and reset all state.
- `registerTask(task, size)` — `totalFiles++`, `totalBytes += size`. Called when
  a task is added to a scheduler (during eager discovery).
- `onTaskStart(task)` — initialize `inFlight[task] = 0`.
- `onTaskProgress(task, transferred)` — update `inFlight[task]`, push a speed
  sample, request a throttled render.
- `onTaskDone(task, { error })` — `doneFiles++` (and `failedFiles++` on error),
  move that task's size into `baseBytes`, delete from `inFlight`, render.
- internal `render()` — throttled (~300ms); composes the single-file or
  aggregate string per the format above and calls `sftpBarItem.showMsg(...)`.

**Rounding / smoothing:** speed = `Δbytes / Δseconds` over the rolling window.
ETA = `(totalBytes - transferredBytes) / speed`, formatted as `Ns` / `Nm Ns` /
`Nh Nm`. Guard against divide-by-zero and unknown totals.

### Byte formatter

A shared `fmtBytes(n)` helper (base-1024, uppercase units) producing `1.23 KB`,
`20 MB`, `1.4 GB`. The `clone` module already has an equivalent `fmtBytes`;
extract/mirror it into a shared util so the codebase stays consistent rather
than duplicating a third copy.

### Wiring into the transfer path

1. **Propagate size into the task.** `TransferTask` does not currently carry the
   file size. Add `size` to `TransferOption` (`transferTask.ts`) and populate it
   where the walk already has it:
   - folder walk: `FileEntry.size` from `srcFs.list()` in `transferFolder`
     (`transfer.ts`),
   - single file: `stat.size` from the top-level `lstat` in `transferFile` /
     `transfer()` (`transfer.ts:428`).
2. **Count bytes as they stream.** In `TransferTask._transferFile()`, attach
   `.on('data', chunk => { transferred += chunk.length; emitProgress() })` to the
   readable `this._handle`. This works for both directions because both pipe the
   same readable stream. Emitting is throttled (~300ms) inside the task, or the
   task emits raw and the aggregator throttles rendering — the aggregator
   throttles regardless. This is a **passive listener**; it does not alter the
   pipe, so transfer speed/correctness is unaffected.
3. **Surface progress.** Add a `progress` signal from the task/service (a new
   event alongside `BEFORE_TRANSFER` / `AFTER_TRANSFER`, or a callback on the
   task) carrying `{ task, transferred }`.
4. **Feed the aggregator from `serviceManager`.** In
   `src/modules/serviceManager/index.ts`:
   - bracket the operation with `aggregator.beginOperation()` /
     `endOperation()` (aligned with the existing `startSpinner` / `stopSpinner`
     bracketing in `createFileHandler.ts`, or via the scheduler
     begin/idle lifecycle),
   - `beforeTransfer` → `aggregator.registerTask` + `onTaskStart` (replacing the
     direct `showMsg`),
   - the new progress event → `aggregator.onTaskProgress`,
   - `afterTransfer` → `aggregator.onTaskDone` (replacing the direct
     `done/failed/cancelled` `showMsg`).
5. **Register task size at enqueue time.** So the aggregate total is known
   before transfers start, `registerTask` is best called where tasks are added
   to the scheduler (the `t => scheduler.add(t)` collect callback in
   `fileHandlers/transfer/index.ts`), using the size propagated in step 1.

### Operation lifecycle & reset

`beginOperation` is called when a transfer operation starts (per `handle()` /
per command run). `endOperation` is called when it finishes. Because
multi-select produces N parallel `handle()` calls sharing the one global
aggregator, the refcount ensures the aggregate spans all of them and only
resets once the last one drains. On reset: render the terminal summary message
with the 4s auto-reset, then clear all counters/maps/speed window.

## Components & responsibilities

| Component | Responsibility | Depends on |
|-----------|----------------|------------|
| `fmtBytes` util | Format a byte count as `X.XX KB/MB/GB` | — |
| `TransferAggregator` | Own status text during transfers; track counts/bytes/speed/ETA; render throttled | `fmtBytes`, `StatusBarItem` |
| `TransferTask._transferFile` | Count streamed bytes, emit throttled per-file progress | readable stream |
| `TransferOption.size` + walk | Carry per-file size from discovery into the task | `FileEntry.size` / `lstat.size` |
| `serviceManager` handlers | Bridge transfer events → aggregator | `TransferAggregator` |

## Testing

- **`fmtBytes` unit tests**: boundaries (0, 1023, 1024, 1MB, 1GB), rounding to 2
  decimals, unit selection.
- **Speed/ETA unit tests**: rolling-window speed calc; ETA formatting
  (`s`/`m`/`h`); divide-by-zero and unknown-total guards produce no `NaN`/`Infinity`.
- **`TransferAggregator` unit tests**: single-file string, multi-file aggregate
  string, unknown-size degradation, terminal messages (all-success, with
  failures), refcount reset across overlapping operations.
- **Manual verification**: download a large file (observe live bytes/speed/ETA);
  download a folder (observe `(done/total files)` aggregate); multi-select
  several files (observe totals climb then drain); a tiny file (goes straight to
  `done`).

## Non-goals

- No change to transfer concurrency, correctness, or the underlying ssh2
  streaming API (no switch to `fastGet`/`fastPut`).
- No progress UI outside the status bar (no VS Code `Progress` notification).
- No persistence of transfer history.
