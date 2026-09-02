import {
  MAX_GRID_BYTES,
  REMOTE_READ_ONLY_REASON,
  isEcho,
  isStaleOp,
  isTooLarge,
  readOnlyReasonFor,
} from '../editorLogic';

describe('MAX_GRID_BYTES', () => {
  it('is 10 MB', () => {
    expect(MAX_GRID_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('isTooLarge', () => {
  it('is false at the limit', () => {
    expect(isTooLarge(MAX_GRID_BYTES)).toBe(false);
  });
  it('is true one past the limit', () => {
    expect(isTooLarge(MAX_GRID_BYTES + 1)).toBe(true);
  });
  it('is false for an empty file', () => {
    expect(isTooLarge(0)).toBe(false);
  });
  it('honours an explicit limit', () => {
    expect(isTooLarge(11, 10)).toBe(true);
  });
});

describe('isEcho', () => {
  it('is true when the new text is exactly what the host last wrote', () => {
    expect(isEcho('a,b\n', 'a,b\n')).toBe(true);
  });
  it('is false when the text differs', () => {
    expect(isEcho('a,c\n', 'a,b\n')).toBe(false);
  });
  // Nothing written yet means every change came from somewhere else.
  it('is false when the host has written nothing', () => {
    expect(isEcho('a,b\n', null)).toBe(false);
  });
});

describe('isStaleOp', () => {
  it('is false when the base matches the document version', () => {
    expect(isStaleOp(7, 7)).toBe(false);
  });
  it('is true when the document has moved on', () => {
    expect(isStaleOp(7, 8)).toBe(true);
  });
});

describe('readOnlyReasonFor', () => {
  it('explains why a remote preview cannot be edited', () => {
    expect(readOnlyReasonFor('remote', 'remote')).toBe(REMOTE_READ_ONLY_REASON);
  });
  it('tells the user what to do about it', () => {
    expect(REMOTE_READ_ONLY_REASON).toBe('Remote preview — read-only. Download the file to edit it.');
  });
  it('gives no reason for a local file', () => {
    expect(readOnlyReasonFor('file', 'remote')).toBeUndefined();
  });
  it('gives no reason for an untitled document', () => {
    expect(readOnlyReasonFor('untitled', 'remote')).toBeUndefined();
  });
});
