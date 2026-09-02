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
