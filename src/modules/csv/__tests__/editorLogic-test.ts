import {
  INVALID_OP_MESSAGE,
  MAX_GRID_BYTES,
  MAX_INSERT_ROWS,
  OUT_OF_RANGE_OP_MESSAGE,
  REMOTE_READ_ONLY_REASON,
  isEcho,
  isStaleOp,
  isTooLarge,
  readOnlyReasonFor,
  validateOp,
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

// A three-row, two-column file, so every boundary below has a real one.
const ROWS = 3;
const WIDTH = 2;

const check = (op: unknown) => validateOp(op, ROWS, WIDTH);

describe('validateOp', () => {
  it('returns the very same object for a valid op', () => {
    const op = { type: 'setCell', row: 0, col: 0, value: 'x' };
    expect(check(op)).toBe(op);
  });

  describe('the shape of the message', () => {
    it('rejects a non-object', () => {
      expect(check('setCell')).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects null', () => {
      expect(check(null)).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a type that is not one of the eight', () => {
      expect(check({ type: 'dropTable' })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a missing type', () => {
      expect(check({ row: 0, col: 0, value: 'x' })).toBe(INVALID_OP_MESSAGE);
    });
  });

  describe('setCell', () => {
    it('rejects a fractional row', () => {
      expect(check({ type: 'setCell', row: 0.5, col: 0, value: 'x' })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a negative col', () => {
      expect(check({ type: 'setCell', row: 0, col: -1, value: 'x' })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a value that is not a string', () => {
      expect(check({ type: 'setCell', row: 0, col: 0, value: 7 })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a row past the end of the file', () => {
      expect(check({ type: 'setCell', row: ROWS, col: 0, value: 'x' })).toBe(
        OUT_OF_RANGE_OP_MESSAGE
      );
    });
    it('allows the last row', () => {
      const op = { type: 'setCell', row: ROWS - 1, col: 0, value: 'x' };
      expect(check(op)).toBe(op);
    });
    // Typing in the pad cell past the last column is how a row grows.
    it('allows a col equal to the width', () => {
      const op = { type: 'setCell', row: 0, col: WIDTH, value: 'x' };
      expect(check(op)).toBe(op);
    });
    it('rejects a col past that', () => {
      expect(check({ type: 'setCell', row: 0, col: WIDTH + 1, value: 'x' })).toBe(
        OUT_OF_RANGE_OP_MESSAGE
      );
    });
  });

  describe('insertRows', () => {
    it('allows appending below the last row', () => {
      const op = { type: 'insertRows', at: ROWS, count: 1 };
      expect(check(op)).toBe(op);
    });
    it('rejects an at past that', () => {
      expect(check({ type: 'insertRows', at: ROWS + 1, count: 1 })).toBe(OUT_OF_RANGE_OP_MESSAGE);
    });
    it('rejects a count of zero', () => {
      expect(check({ type: 'insertRows', at: 0, count: 0 })).toBe(OUT_OF_RANGE_OP_MESSAGE);
    });
    it('allows the largest count', () => {
      const op = { type: 'insertRows', at: 0, count: MAX_INSERT_ROWS };
      expect(check(op)).toBe(op);
    });
    it('rejects one more than that', () => {
      expect(check({ type: 'insertRows', at: 0, count: MAX_INSERT_ROWS + 1 })).toBe(
        OUT_OF_RANGE_OP_MESSAGE
      );
    });
    it('rejects a fractional count', () => {
      expect(check({ type: 'insertRows', at: 0, count: 1.5 })).toBe(INVALID_OP_MESSAGE);
    });
  });

  ['duplicateRows', 'deleteRows'].forEach(type => {
    describe(type, () => {
      it('allows every row of the file', () => {
        const op = { type, rows: [0, 1, 2] };
        expect(check(op)).toBe(op);
      });
      it('allows an empty list', () => {
        const op = { type, rows: [] };
        expect(check(op)).toBe(op);
      });
      it('rejects a list that is not an array', () => {
        expect(check({ type, rows: 0 })).toBe(INVALID_OP_MESSAGE);
      });
      it('rejects a row index past the end', () => {
        expect(check({ type, rows: [0, ROWS] })).toBe(OUT_OF_RANGE_OP_MESSAGE);
      });
      it('rejects a negative row index', () => {
        expect(check({ type, rows: [-1] })).toBe(OUT_OF_RANGE_OP_MESSAGE);
      });
      it('rejects a non-integer entry', () => {
        expect(check({ type, rows: ['0'] })).toBe(OUT_OF_RANGE_OP_MESSAGE);
      });
      it('rejects a list longer than the file has rows', () => {
        expect(check({ type, rows: [0, 0, 0, 0] })).toBe(OUT_OF_RANGE_OP_MESSAGE);
      });
    });
  });

  describe('insertColumn', () => {
    it('allows inserting after the last column', () => {
      const op = { type: 'insertColumn', at: WIDTH };
      expect(check(op)).toBe(op);
    });
    it('rejects an at past that', () => {
      expect(check({ type: 'insertColumn', at: WIDTH + 1 })).toBe(OUT_OF_RANGE_OP_MESSAGE);
    });
    it('rejects a negative at', () => {
      expect(check({ type: 'insertColumn', at: -1 })).toBe(INVALID_OP_MESSAGE);
    });
  });

  describe('deleteColumn', () => {
    it('allows the last column', () => {
      const op = { type: 'deleteColumn', col: WIDTH - 1 };
      expect(check(op)).toBe(op);
    });
    it('rejects a col at the width', () => {
      expect(check({ type: 'deleteColumn', col: WIDTH })).toBe(OUT_OF_RANGE_OP_MESSAGE);
    });
    it('rejects a missing col', () => {
      expect(check({ type: 'deleteColumn' })).toBe(INVALID_OP_MESSAGE);
    });
  });

  describe('sort', () => {
    it('allows a column of the file', () => {
      const op = { type: 'sort', col: 1, direction: 'desc', hasHeader: true };
      expect(check(op)).toBe(op);
    });
    it('rejects a col at the width', () => {
      expect(check({ type: 'sort', col: WIDTH, direction: 'asc', hasHeader: true })).toBe(
        OUT_OF_RANGE_OP_MESSAGE
      );
    });
    // An empty file still has one column to sort by.
    it('allows column 0 of an empty file', () => {
      const op = { type: 'sort', col: 0, direction: 'asc', hasHeader: false };
      expect(validateOp(op, 0, 0)).toBe(op);
    });
    it('rejects a direction that is neither asc nor desc', () => {
      expect(check({ type: 'sort', col: 0, direction: 'up', hasHeader: true })).toBe(
        INVALID_OP_MESSAGE
      );
    });
    it('rejects a hasHeader that is not a boolean', () => {
      expect(check({ type: 'sort', col: 0, direction: 'asc', hasHeader: 'yes' })).toBe(
        INVALID_OP_MESSAGE
      );
    });
  });

  describe('replaceAll', () => {
    const base = { type: 'replaceAll', find: 'a', replace: 'b', matchCase: false, hasHeader: true };

    it('allows an op with no column scope', () => {
      const op = { ...base };
      expect(check(op)).toBe(op);
    });
    it('allows a column scope inside the file', () => {
      const op = { ...base, col: WIDTH - 1 };
      expect(check(op)).toBe(op);
    });
    it('rejects a column scope at the width', () => {
      expect(check({ ...base, col: WIDTH })).toBe(OUT_OF_RANGE_OP_MESSAGE);
    });
    it('rejects a fractional column scope', () => {
      expect(check({ ...base, col: 0.5 })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a find that is not a string', () => {
      expect(check({ ...base, find: 1 })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a replace that is not a string', () => {
      expect(check({ ...base, replace: null })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a matchCase that is not a boolean', () => {
      expect(check({ ...base, matchCase: 1 })).toBe(INVALID_OP_MESSAGE);
    });
    it('rejects a hasHeader that is not a boolean', () => {
      expect(check({ ...base, hasHeader: undefined })).toBe(INVALID_OP_MESSAGE);
    });
  });
});
