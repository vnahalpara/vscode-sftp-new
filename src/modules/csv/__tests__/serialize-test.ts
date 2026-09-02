import * as fs from 'fs';
import * as path from 'path';
import { detectFormat } from '../format';
import { setCell } from '../model';
import { parseCsv } from '../parse';
import { serializeCell, serializeCsv } from '../serialize';
import { CsvFormat, CsvTable } from '../types';

const FIXTURE_DIR = path.join(__dirname, '__fixtures__');
const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter(name => /\.(csv|tsv)$/.test(name))
  .sort();

const COMMA: CsvFormat = { delimiter: ',', eol: '\n', finalNewline: true, quoteAll: false };

describe('the round-trip corpus', () => {
  it('has every fixture the corpus is supposed to cover', () => {
    expect(FIXTURES).toEqual([
      'blank-lines.csv',
      'crlf.csv',
      'embedded-newlines.csv',
      'empty.csv',
      'no-final-newline.csv',
      'only-newline.csv',
      'pipe.csv',
      'plain.csv',
      'quote-all.csv',
      'quote-escapes.csv',
      'ragged.csv',
      'semicolon.csv',
      'tabs.tsv',
      'trailing-delimiter.csv',
      'unterminated-quote-crlf.csv',
      'unterminated-quote.csv',
    ]);
  });

  // The load-bearing property of the whole feature: opening a file and saving
  // it without editing anything must not change one byte.
  FIXTURES.forEach(name => {
    it(`serialize(parse(${name})) is byte-identical`, () => {
      const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
      const table = parseCsv(text, detectFormat(text, name));
      expect(serializeCsv(table)).toBe(text);
    });
  });
});

describe('serializeCsv', () => {
  it('writes a row that still has its raw text exactly as it was', () => {
    const table: CsvTable = {
      rows: [{ cells: ['a', 'b'], quoted: [false, false], raw: '"a" ,   b' }],
      format: { ...COMMA, finalNewline: false },
    };
    expect(serializeCsv(table)).toBe('"a" ,   b');
  });

  it('rebuilds a row whose raw is null from its cells', () => {
    const table: CsvTable = {
      rows: [{ cells: ['a', 'b'], quoted: [false, false], raw: null }],
      format: { ...COMMA, finalNewline: false },
    };
    expect(serializeCsv(table)).toBe('a,b');
  });

  it('joins rows with the format eol and appends a final one when asked', () => {
    const table: CsvTable = {
      rows: [
        { cells: ['a'], quoted: [false], raw: null },
        { cells: ['b'], quoted: [false], raw: null },
      ],
      format: { delimiter: ',', eol: '\r\n', finalNewline: true, quoteAll: false },
    };
    expect(serializeCsv(table)).toBe('a\r\nb\r\n');
  });

  it('omits the final eol when the file did not have one', () => {
    const table: CsvTable = {
      rows: [{ cells: ['a'], quoted: [false], raw: null }],
      format: { ...COMMA, finalNewline: false },
    };
    expect(serializeCsv(table)).toBe('a');
  });

  it('writes an empty table as an empty file, final newline or not', () => {
    expect(serializeCsv({ rows: [], format: COMMA })).toBe('');
  });

  // The reason unchanged cells keep their own `quoted` flag: editing one cell
  // in a row must not re-quote its neighbours.
  it('keeps unchanged cells bare while quoting the changed one', () => {
    const table: CsvTable = {
      rows: [{ cells: ['a', 'x,y', ' c'], quoted: [false, true, false], raw: null }],
      format: { ...COMMA, finalNewline: false },
    };
    expect(serializeCsv(table)).toBe('a,"x,y", c');
  });
});

describe('serializeCell', () => {
  it('writes a bare value bare', () => {
    expect(serializeCell('abc', false)).toBe('abc');
  });
  it('wraps a quoted value in quotes', () => {
    expect(serializeCell('abc', true)).toBe('"abc"');
  });
  it('doubles the quotes inside a quoted value', () => {
    expect(serializeCell('he said "no"', true)).toBe('"he said ""no"""');
  });
  it('writes an empty quoted cell as two quotes', () => {
    expect(serializeCell('', true)).toBe('""');
  });
  it('leaves a value containing a delimiter alone when it is not marked quoted', () => {
    // serializeCell obeys the flag; deciding the flag is needsQuote's job.
    expect(serializeCell('a,b', false)).toBe('a,b');
  });
});

// The bug this guards: the file's last newline is swallowed by an
// unterminated quoted field, so it lives inside the last row's `raw`. If
// `finalNewline` still came from "the text ends with \n", every save appended
// another one, and the file grew a blank line each time.
describe('an unterminated quote at the end of the file', () => {
  const TEXT = 'name,note\nAda,"unclosed\n';

  it('does not gain a newline over five successive edits', () => {
    let text = TEXT;
    for (let i = 0; i < 5; i += 1) {
      const table = parseCsv(text, detectFormat(text, 'x.csv'));
      text = serializeCsv(setCell(table, 0, 0, `name${i}`));
    }
    expect(text).toBe('name4,note\nAda,"unclosed\n');
    // The only growth is the edit itself: 'name' -> 'name4'.
    expect(text.length).toBe(TEXT.length + 1);
  });
});

describe('mixed line endings', () => {
  // Documented, deliberate lossiness: CsvFormat holds one Eol and CsvRow has
  // no per-row terminator, so a mixed file is normalized to the detected one.
  it('normalizes to the first line ending found', () => {
    const text = 'a,b\r\n1,2\n3,4\n';
    const table = parseCsv(text, detectFormat(text, 'x.csv'));
    expect(serializeCsv(table)).toBe('a,b\r\n1,2\r\n3,4\r\n');
  });
});
