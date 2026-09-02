import { detectDelimiter, detectEol, detectFormat, needsQuote } from '../format';

describe('detectEol', () => {
  it('is LF for a LF file', () => {
    expect(detectEol('a,b\n1,2\n')).toBe('\n');
  });
  it('is CRLF for a CRLF file', () => {
    expect(detectEol('a,b\r\n1,2\r\n')).toBe('\r\n');
  });
  it('takes the FIRST line ending, not the most common one', () => {
    expect(detectEol('a\r\nb\nc\n')).toBe('\r\n');
  });
  it('is LF for a file with no line ending at all', () => {
    expect(detectEol('a,b')).toBe('\n');
  });
});

describe('detectDelimiter', () => {
  it('finds a comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n', 'x.csv')).toBe(',');
  });
  it('finds a semicolon', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n', 'x.csv')).toBe(';');
  });
  it('finds a tab', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n', 'x.csv')).toBe('\t');
  });
  it('finds a pipe', () => {
    expect(detectDelimiter('a|b|c\n1|2|3\n', 'x.csv')).toBe('|');
  });

  // The whole point of scoring outside quotes: a semicolon file full of
  // commas inside quoted names must not be read as a comma file.
  it('ignores delimiters inside quotes', () => {
    const text = 'name;note\n"Doe, John";"a, b, c"\n"Roe, Jane";"d, e, f"\n';
    expect(detectDelimiter(text, 'x.csv')).toBe(';');
  });

  it('finds the delimiter on a file with newlines inside quoted cells', () => {
    const text = 'a;b\nx;"line one\nline two"\ny;"p\nq"\n';
    expect(detectDelimiter(text, 'x.csv')).toBe(';');
  });

  it('falls back to a comma when nothing scores', () => {
    expect(detectDelimiter('one\ntwo\nthree\n', 'x.csv')).toBe(',');
  });

  it('falls back to a tab for a .tsv file when nothing scores', () => {
    expect(detectDelimiter('one\ntwo\n', 'x.tsv')).toBe('\t');
  });

  it('prefers the delimiter with the most consistent lines', () => {
    // Every line has exactly one semicolon; commas appear 1, 0, 2 times.
    const text = 'a,b;c\nd;e\nf,g,h;i\n';
    expect(detectDelimiter(text, 'x.csv')).toBe(';');
  });

  it('breaks a score tie on the higher mode', () => {
    // Both appear on both lines: comma twice per line, semicolon once.
    expect(detectDelimiter('a,b,c;d\ne,f,g;h\n', 'x.csv')).toBe(',');
  });

  it('does not let blank lines drag a score down', () => {
    expect(detectDelimiter('a,b\n\nc,d\n\n', 'x.csv')).toBe(',');
  });

  it('still picks the delimiter on a ragged file', () => {
    expect(detectDelimiter('a,b,c\n1,2\n3,4,5,6\n', 'x.csv')).toBe(',');
  });

  it('does not spend the sample on the continuation lines of multi-line cells', () => {
    // Every row spans two physical lines and only the first carries evidence.
    // The first 25 rows read as a semicolon file and the next 25 as a comma
    // file, so the comma only wins if the 50-line sample reaches all 50 rows.
    // Sampling the continuations would stop at row 25 and answer ';'.
    let text = '';
    for (let i = 0; i < 25; i += 1) {
      text += 'x;"p\nq"\n';
    }
    for (let i = 0; i < 25; i += 1) {
      text += 'a,b,"c\nd"\n';
    }
    expect(detectDelimiter(text, 'x.csv')).toBe(',');
  });
});

describe('detectFormat', () => {
  it('reports a final newline when there is one', () => {
    expect(detectFormat('a,b\n', 'x.csv').finalNewline).toBe(true);
  });
  it('reports no final newline when there is none', () => {
    expect(detectFormat('a,b', 'x.csv').finalNewline).toBe(false);
  });
  it('reports no final newline for empty text', () => {
    expect(detectFormat('', 'x.csv').finalNewline).toBe(false);
  });
  it('reports a final newline for a CRLF file', () => {
    expect(detectFormat('a,b\r\n', 'x.csv').finalNewline).toBe(true);
  });

  describe('quoteAll', () => {
    it('is true when every non-empty cell is quoted', () => {
      expect(detectFormat('"a","b"\n"1","2"\n', 'x.csv').quoteAll).toBe(true);
    });
    it('ignores empty cells, which are never required to be quoted', () => {
      expect(detectFormat('"a",\n"1","2"\n', 'x.csv').quoteAll).toBe(true);
    });
    it('is false when any non-empty cell is bare', () => {
      expect(detectFormat('"a",b\n"1","2"\n', 'x.csv').quoteAll).toBe(false);
    });
    it('is false for a file with no cells at all', () => {
      expect(detectFormat('', 'x.csv').quoteAll).toBe(false);
    });
    it('is false for a file whose only cells are empty', () => {
      expect(detectFormat('\n\n', 'x.csv').quoteAll).toBe(false);
    });
  });

  it('reports the whole format for a quoted CRLF semicolon file', () => {
    expect(detectFormat('"a";"b"\r\n"1";"2"\r\n', 'x.csv')).toEqual({
      delimiter: ';',
      eol: '\r\n',
      finalNewline: true,
      quoteAll: true,
    });
  });
});

describe('needsQuote', () => {
  it('is false for a plain value', () => {
    expect(needsQuote('abc', ',')).toBe(false);
  });
  it('is false for an empty value', () => {
    expect(needsQuote('', ',')).toBe(false);
  });
  it('is true when the value contains the delimiter', () => {
    expect(needsQuote('a,b', ',')).toBe(true);
    expect(needsQuote('a;b', ';')).toBe(true);
    expect(needsQuote('a\tb', '\t')).toBe(true);
    expect(needsQuote('a|b', '|')).toBe(true);
  });
  it('is false when the value contains a DIFFERENT delimiter', () => {
    expect(needsQuote('a;b', ',')).toBe(false);
  });
  it('is true when the value contains a quote', () => {
    expect(needsQuote('say "hi"', ',')).toBe(true);
  });
  it('is true when the value contains a line ending', () => {
    expect(needsQuote('a\nb', ',')).toBe(true);
    expect(needsQuote('a\rb', ',')).toBe(true);
  });
  it('is true for leading or trailing whitespace', () => {
    expect(needsQuote(' a', ',')).toBe(true);
    expect(needsQuote('a ', ',')).toBe(true);
  });
  it('is false for whitespace in the middle', () => {
    expect(needsQuote('a b', ',')).toBe(false);
  });
});
