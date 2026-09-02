import { parseCsv } from '../parse';
import { CsvFormat } from '../types';

const COMMA: CsvFormat = { delimiter: ',', eol: '\n', finalNewline: true, quoteAll: false };
const SEMI: CsvFormat = { delimiter: ';', eol: '\n', finalNewline: true, quoteAll: false };

const cellsOf = (text: string, format: CsvFormat = COMMA) =>
  parseCsv(text, format).rows.map(row => row.cells);

describe('parseCsv', () => {
  it('splits plain rows and cells', () => {
    expect(cellsOf('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('parses a last row without a trailing newline', () => {
    expect(cellsOf('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('does not turn the trailing newline into an extra row', () => {
    expect(parseCsv('a,b\n', COMMA).rows).toHaveLength(1);
  });

  it('returns no rows at all for empty input', () => {
    expect(parseCsv('', COMMA).rows).toEqual([]);
  });

  // A lone newline is one blank line, which is one row of one empty cell.
  // Serializing it back has to produce "\n" again, which only works if the
  // row exists and finalNewline is true.
  it('reads a lone newline as one row with one empty cell', () => {
    expect(cellsOf('\n')).toEqual([['']]);
  });

  it('reads a blank line as a row with one empty cell', () => {
    expect(cellsOf('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('unwraps quoted fields and records that they were quoted', () => {
    const table = parseCsv('"a",b\n', COMMA);
    expect(table.rows[0].cells).toEqual(['a', 'b']);
    expect(table.rows[0].quoted).toEqual([true, false]);
  });

  it('keeps a delimiter inside quotes as literal text', () => {
    expect(cellsOf('"Doe, John",42\n')).toEqual([['Doe, John', '42']]);
  });

  it('turns a doubled quote into one quote', () => {
    expect(cellsOf('"he said ""no""",2\n')).toEqual([['he said "no"', '2']]);
  });

  it('keeps a newline inside quotes as literal text (LF)', () => {
    expect(cellsOf('"line one\nline two",x\n')).toEqual([['line one\nline two', 'x']]);
  });

  it('keeps a newline inside quotes as literal text (CRLF)', () => {
    expect(cellsOf('"line one\r\nline two",x\r\n')).toEqual([['line one\r\nline two', 'x']]);
  });

  it('treats a quote inside an unquoted field as literal', () => {
    const table = parseCsv('a"b,c\n', COMMA);
    expect(table.rows[0].cells).toEqual(['a"b', 'c']);
    expect(table.rows[0].quoted).toEqual([false, false]);
  });

  // Real exports do this. Dropping the tail would silently lose data, so the
  // tolerant reading is to append it.
  it('appends text that follows a closing quote to the same field', () => {
    expect(cellsOf('"b"x,c\n')).toEqual([['bx', 'c']]);
  });

  it('leaves an unterminated quote running to the end of the text', () => {
    expect(cellsOf('a,"bc')).toEqual([['a', 'bc']]);
  });

  it('reads a trailing delimiter as an empty last cell', () => {
    expect(cellsOf('a,b,\n')).toEqual([['a', 'b', '']]);
  });

  it('keeps ragged rows ragged', () => {
    expect(cellsOf('a,b,c\n1,2\n3,4,5,6\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['3', '4', '5', '6'],
    ]);
  });

  it('honours a non-comma delimiter', () => {
    expect(cellsOf('a;b\n1;2\n', SEMI)).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('splits on CRLF as well as LF', () => {
    expect(cellsOf('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  describe('raw', () => {
    it('is the row text without its line ending', () => {
      const table = parseCsv('a,b\r\n1,2\r\n', COMMA);
      expect(table.rows.map(row => row.raw)).toEqual(['a,b', '1,2']);
    });

    it('includes the quotes exactly as they were written', () => {
      expect(parseCsv('"a", b\n', COMMA).rows[0].raw).toBe('"a", b');
    });

    it('includes a newline that was inside quotes', () => {
      expect(parseCsv('"x\ny",z\n', COMMA).rows[0].raw).toBe('"x\ny",z');
    });

    it('is an empty string for a blank line', () => {
      expect(parseCsv('\n', COMMA).rows[0].raw).toBe('');
    });
  });
});
