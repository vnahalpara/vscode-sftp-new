# Live transfer progress in the status bar

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan

## Goal

While a file is uploading or downloading, show live progress in the SFTP status
bar item instead of a static `remote ➞ local exception.log`. Progress means:
transferred bytes, total file size, current speed, and estimated time remaining.
For folder / multi-file transfers, show an aggregate: how many files are done vs
total, and total bytes transferred vs total size.

All sizes and speeds are **byte-based** (megabytes, not megabits): `MB` = 1024²
bytes, `KB/s` = kilobytes per second.

## Display format

Single file (`totalFiles ≤ 1`):

```
⠸ remote ➞ local exception.log  1.23 KB / 20 MB · 450 KB/s · 44s left
```

Multi-file / folder (`totalFiles > 1`) — aggregate:

```
⠸ remote ➞ local  (3/12 files)  45 MB / 210 MB · 450 KB/s · 6m left
```

The leading spinner frame is prepended by `StatusBarItem._render()` as it already
is today; the aggregator only supplies the text after it.

### Formatting rules

- **Byte formatter** `fmtBytes(n)`: base-1024, chooses `B` / `KB` / `MB` / `GB`.
  Two decimals below `10` in a unit, otherwise ≤1 decimal (e.g. `1.23 KB`,
  `8.4 MB`, `210 MB`, `1.4 GB`). Mirrors the existing `fmtBytes` in
  `src/modules/clone/` for consistency; extracted into a shared util so both
  code paths use one implementation.
- **Speed** `fmtBytes(bytesPerSec) + '/s'`.
- **ETA** `(totalBytes − transferredBytes) / speed`, formatted compactly:
  `44s left`, `6m left`, `1h 3m left`. Rounded, never sub-second.

### Degradation / edge cases

- **Unknown total** (size `0`, missing, or not yet summed): drop `/ total` and
  the ETA; show `1.23 KB · 450 KB/s`.
- **Speed not yet known** (fewer than ~2 samples, or 0 bytes so far): omit the
  ETA segment. Never render `Infinity`, `NaN`, or a negative ETA.
- **Instant / tiny files**: the throttle may mean a file goes straight to the
  terminal `done` message with no intermediate tick. Acceptable — no flicker.
- **Cancel / error**: unchanged terminal handling (see Terminal messages).

## Architecture

### New component: `TransferAggregator`

A process-wide singleton created alongside `app.sftpBarItem` in `src/app.ts`. It
becomes the **single owner** of the status bar text for the duration of any
transfer, so the current per-file text-setting in `serviceManager` is routed
through it rather than competing with it.

State:

- `totalFiles`, `doneFiles`, `failedFiles`
- `totalBytes` — sum of known per-file sizes registered so far
- `baseBytes` — sum of sizes of files that have finished
- in-flight map: `task → transferredBytes` for currently-active files
- `transferredBytes()` = `baseBytes + Σ in-flight`
- speed window — a short rolling buffer of `{ t, bytes }` samples (~1s) used to
  compute a smoothed `bytesPerSec`. Runtime uses `Date.now()` for `t`; unit tests
  inject timestamps so speed is deterministic and testable without wall-clock
  timing.
- `activeOps` — refcount of in-progress transfer operations.

API (all called from `serviceManager` / `TransferTask`, never from UI directly):

- `beginOperation()` / `endOperation()` — refcount around each `handle()`
  operation. `0 → 1` starts a fresh batch (reset counters). `N → 0` finalizes:
  render the terminal message and schedule the reset.
- `registerTask(task, size)` — `totalFiles++`, `totalBytes += size` (size may be
  `0`/unknown). Called when a task is added to a scheduler / begins.
- `onProgress(task, transferredBytes)` — update in-flight bytes for that task,
  request a throttled re-render.
- `onDone(task, { error, cancelled })` — move that task's bytes into `baseBytes`,
  `doneFiles++` (or `failedFiles++`), re-render.
- `render()` — throttled (~300ms); composes the single/aggregate string per the
  file count and pushes it to `app.sftpBarItem.showMsg(...)`.

Rendering picks **single vs aggregate** by `totalFiles`. Direction text
(`remote ➞ local` / `local ➞ remote`) comes from the active task's
`transferType`; in the rare mixed-direction multi-select, the most recent task's
direction is used.

### Wiring into the existing transfer path

1. **Propagate size into the task.** `TransferTask` currently receives only
   `{fsPath, fileSystem}` pairs and `{fileType, transferDirection, transferOption}`
   (`src/fileHandlers/transfer/transfer.ts:125-141`). Add the file `size` (already
   present on the `FileEntry` from `srcFs.list()` in `transferFolder`, and on the
   top-level `lstat` in `transferFile`) into `TransferOption` so the task and the
   aggregator know the per-file total without a second stat.

2. **Count bytes as they stream.** In `TransferTask._transferFile()`
   (`src/core/transferTask.ts`, around the `srcFs.get(src)` at ~line 177), attach
   `this._handle.on('data', chunk => { transferred += chunk.length })` to the
   readable stream. This works for **both** directions because the same readable
   is piped to the target in either case. Emit a **throttled** (~300ms) progress
   signal carrying `{ task, transferred }`. This is purely observational — a
   passive listener on the existing stream — so transfer speed and correctness are
   unaffected.

3. **Feed the aggregator.** In `src/modules/serviceManager/index.ts`:
   - `beforeTransfer(task)` → `aggregator.registerTask(task, size)` (instead of
     directly setting `showMsg`).
   - new progress event → `aggregator.onProgress(task, transferred)`.
   - `afterTransfer(error, task)` → `aggregator.onDone(task, {...})`.

4. **Bracket the operation.** `beginOperation()` / `endOperation()` are called
   around each `handle()` — the natural place is `src/fileHandlers/createFileHandler.ts`
   lines 106/118, which already wrap each op with
   `startSpinner()` … `finally { stopSpinner() }`. The refcount makes concurrent
   multi-select schedulers collapse into one shared aggregate that resets only when
   the last operation drains.

### Terminal messages (on `endOperation`, refcount → 0)

- Single file, success: `done exception.log` (existing behavior).
- Single file, failure / cancel: `failed exception.log` / `cancelled exception.log`
  (existing behavior).
- Multi-file, all success: `done 12 files`.
- Multi-file, partial failure: `done 10, 2 failed`.

All use the existing 4s auto-reset (`showMsg(..., 2000 * 2)`).

## Multi-select behavior (accepted)

Multi-select walks each selected URI in parallel, each with its own scheduler
(`src/commands/abstract/createCommand.ts:57-66`). Because discovery per URI is
eager but the URIs finish walking at different times, the aggregate `total files`
and `total bytes` may **tick upward** during the first moment of a multi-select
until every walk completes, then count down as transfers finish. This is accurate
and self-correcting; we accept it rather than pre-scanning all selections before
showing anything.

## Testing

- **`fmtBytes` unit tests**: boundary values (`0`, `1023`, `1024`, `1048575`,
  `1048576`, GB range), decimal rules.
- **ETA / speed formatter tests**: `0` speed → no ETA; sub-second → `Ns left`;
  minutes/hours formatting.
- **`TransferAggregator` unit tests** (no real streams — drive the API directly):
  - single-file: register(1, 20MB) → onProgress → renders `x / 20 MB · speed`.
  - unknown size: register(1, 0) → renders transferred + speed, no `/ total`, no ETA.
  - multi-file: register three tasks → aggregate `(0/3 files)` → onDone increments
    `doneFiles` and moves bytes to base.
  - refcount: begin → begin → end → still active; final end → terminal message +
    reset.
  - partial failure terminal string `done N, M failed`.
- **Speed smoothing test**: feed timestamped samples, assert smoothed rate is
  within tolerance and never `NaN`/`Infinity`.

Follow the repo's existing test layout (`src/core/__tests__/`), preferring focused
unit tests over integration tests.

## Non-goals

- No switch to `fastGet`/`fastPut` — the streaming `.on('data')` counter is the
  smaller change and fits the existing pipe architecture.
- No per-file progress bar in the VS Code notification area (this is status-bar
  only).
- No change to transfer concurrency, ordering, or correctness.
