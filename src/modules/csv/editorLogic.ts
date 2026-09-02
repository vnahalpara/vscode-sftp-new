import { CsvOp } from './protocol';

// The editor provider's decisions that do not need the vscode module, so they
// can be tested. editor.ts is the wiring; this is the thinking.

// getText().length is a character count, not a byte count. That is the right
// trade here: it is what the provider already has in hand, it is within a
// factor of the true size for any realistic CSV, and the limit's job is to
// stop the webview choking rather than to be exact.
export const MAX_GRID_BYTES = 10 * 1024 * 1024;

export const REMOTE_READ_ONLY_REASON =
  'Remote preview — read-only. Download the file to edit it.';

export function isTooLarge(length: number, limit: number = MAX_GRID_BYTES): boolean {
  return length > limit;
}

// True when a document change is the echo of the host's own WorkspaceEdit.
// Compared by TEXT, not by version: a version is bumped by anything at all,
// including the undo whose whole point is that the grid must notice it.
export function isEcho(text: string, lastWritten: string | null): boolean {
  return lastWritten !== null && text === lastWritten;
}

// The op was made against a different version of the document, so the
// webview's copy is not the document any more. Drop it and resync.
export function isStaleOp(base: number, version: number): boolean {
  return base !== version;
}

// A Remote Explorer preview (downloadWhenOpenInRemoteExplorer off) is backed
// by a content provider with nothing to write to. Editing a remote file with
// that setting ON opens the local copy and works normally.
export function readOnlyReasonFor(scheme: string, remoteScheme: string): string | undefined {
  return scheme === remoteScheme ? REMOTE_READ_ONLY_REASON : undefined;
}

// Ops arrive as JSON over the webview message port. The grid is ours, but the
// message is still untrusted input, and applyOp is TOTAL: it returns the table
// unchanged for an op it cannot use, so a malformed op would leave the grid
// waiting for an ack that never comes. An op that is merely out of range is
// worse -- it applies, and writes a table the user never asked for over their
// file. Checked here, as a pure function, so every rule has a test.
export const INVALID_OP_MESSAGE = 'The grid sent an operation this editor does not understand.';
export const OUT_OF_RANGE_OP_MESSAGE =
  'The grid sent an operation that does not fit this file, so nothing was changed.';

// The largest insertRows the grid ever asks for. Generous for any real "insert
// N rows", small enough that a corrupt count cannot allocate its way to a hang.
export const MAX_INSERT_ROWS = 10000;

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Row indices for duplicateRows/deleteRows. Capped at the row count because
// nothing legitimate names a row twice, and indexSet is O(n*m) in this length.
function isRowList(value: unknown, rowCount: number): boolean {
  if (!Array.isArray(value) || value.length > rowCount) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!isIndex(value[i]) || value[i] >= rowCount) {
      return false;
    }
  }
  return true;
}

// The op itself when it is safe to apply, or the message to show instead.
// `rowCount` and `width` must come from the CURRENT model, so the caller has
// to flush any pending resync before asking.
export function validateOp(op: unknown, rowCount: number, width: number): CsvOp | string {
  if (!op || typeof op !== 'object') {
    return INVALID_OP_MESSAGE;
  }
  const raw = op as { [key: string]: unknown };
  switch (raw.type) {
    case 'setCell': {
      const row = raw.row;
      const col = raw.col;
      if (!isIndex(row) || !isIndex(col) || typeof raw.value !== 'string') {
        return INVALID_OP_MESSAGE;
      }
      // col may EQUAL width: typing in the pad cell past the last column is
      // how a row grows.
      if (row >= rowCount || col > width) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'insertRows': {
      const at = raw.at;
      const count = raw.count;
      if (!isIndex(at) || !isIndex(count)) {
        return INVALID_OP_MESSAGE;
      }
      // at may EQUAL rowCount: that is "append below the last row".
      if (at > rowCount || count < 1 || count > MAX_INSERT_ROWS) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'duplicateRows':
    case 'deleteRows': {
      if (!Array.isArray(raw.rows)) {
        return INVALID_OP_MESSAGE;
      }
      if (!isRowList(raw.rows, rowCount)) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'insertColumn': {
      const at = raw.at;
      if (!isIndex(at)) {
        return INVALID_OP_MESSAGE;
      }
      // at may EQUAL width: "insert after the last column".
      if (at > width) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'deleteColumn': {
      const col = raw.col;
      if (!isIndex(col)) {
        return INVALID_OP_MESSAGE;
      }
      if (col >= width) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'sort': {
      const col = raw.col;
      if (
        !isIndex(col) ||
        (raw.direction !== 'asc' && raw.direction !== 'desc') ||
        typeof raw.hasHeader !== 'boolean'
      ) {
        return INVALID_OP_MESSAGE;
      }
      // An empty file still has one column to sort by.
      if (col >= Math.max(width, 1)) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    case 'replaceAll': {
      const col = raw.col;
      if (
        typeof raw.find !== 'string' ||
        typeof raw.replace !== 'string' ||
        typeof raw.matchCase !== 'boolean' ||
        typeof raw.hasHeader !== 'boolean' ||
        (col !== undefined && !isIndex(col))
      ) {
        return INVALID_OP_MESSAGE;
      }
      // undefined is "every column"; a named one has to exist.
      if (col !== undefined && (col as number) >= width) {
        return OUT_OF_RANGE_OP_MESSAGE;
      }
      break;
    }
    default:
      return INVALID_OP_MESSAGE;
  }
  return op as CsvOp;
}
