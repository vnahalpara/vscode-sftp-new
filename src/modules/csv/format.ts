import { parseCsv } from './parse';
import { CsvFormat, Delimiter, DELIMITERS, Eol } from './types';

// How much of the file the two detectors look at. Both are sampling
// heuristics -- reading a 10MB export end to end twice to learn its delimiter
// would be the slowest thing the editor does.
const SAMPLE_RECORDS = 50;
const QUOTE_SCAN_ROWS = 1000;
const QUOTE_SCAN_BYTES = 256 * 1024;

export function detectEol(text: string): Eol {
  const at = text.indexOf('\n');
  if (at === -1) {
    return '\n';
  }
  return at > 0 && text.charAt(at - 1) === '\r' ? '\r\n' : '\n';
}

function delimiterIndex(ch: string): number {
  for (let i = 0; i < DELIMITERS.length; i += 1) {
    if (DELIMITERS[i] === ch) {
      return i;
    }
  }
  return -1;
}

// The most common value in a list. Ties go to the LARGER value: on a ragged
// file every count is unique, and the larger one is the better guess at the
// file's real column count.
function modeOf(values: number[]): number {
  let best = 0;
  let bestFrequency = 0;
  values.forEach(value => {
    let frequency = 0;
    values.forEach(other => {
      if (other === value) {
        frequency += 1;
      }
    });
    if (frequency > bestFrequency || (frequency === bestFrequency && value > best)) {
      bestFrequency = frequency;
      best = value;
    }
  });
  return best;
}

// Score each candidate over the first SAMPLE_RECORDS records: take the most
// common per-record count, and score the candidate by how many records hit
// exactly that count. A mode of 0 means the character does not separate
// anything, so it scores 0.
//
// Counting is per RECORD, not per physical line, and the quote state carries
// across lines. A quoted cell may hold a newline, and a continuation line
// carries either nothing or only the tail of its record: counting per line
// halves the real delimiter's score, and misses it entirely when the
// multi-line cell is the first column and every delimiter of the record sits
// on a continuation line.
export function detectDelimiter(text: string, fileName: string): Delimiter {
  const counts: number[][] = DELIMITERS.map(() => []);
  const lines = text.split(/\r\n|\n/);
  let inQuotes = false;
  let collected = 0;
  let perRecord = DELIMITERS.map(() => 0);
  let recordChars = 0;

  for (let l = 0; l < lines.length && collected < SAMPLE_RECORDS; l += 1) {
    const line = lines[l];
    recordChars += line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line.charAt(i);
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (inQuotes) {
        continue;
      }
      const d = delimiterIndex(ch);
      if (d !== -1) {
        perRecord[d] += 1;
      }
    }
    if (inQuotes) {
      continue; // the record runs on into the next line
    }
    // An empty record is a blank line: no evidence, and it must not eat a
    // slot in the sample.
    if (recordChars > 0) {
      for (let d = 0; d < DELIMITERS.length; d += 1) {
        counts[d].push(perRecord[d]);
      }
      collected += 1;
    }
    perRecord = DELIMITERS.map(() => 0);
    recordChars = 0;
  }

  let bestIndex = -1;
  let bestScore = 0;
  let bestMode = 0;
  // Iterating in DELIMITERS order and only replacing on a STRICT improvement
  // is what implements the final tie-break of `,` `;` `\t` `|`.
  for (let d = 0; d < DELIMITERS.length; d += 1) {
    const mode = modeOf(counts[d]);
    if (mode === 0) {
      continue;
    }
    let score = 0;
    counts[d].forEach(value => {
      if (value === mode) {
        score += 1;
      }
    });
    if (score > bestScore || (score === bestScore && mode > bestMode)) {
      bestScore = score;
      bestMode = mode;
      bestIndex = d;
    }
  }

  if (bestIndex === -1) {
    return /\.tsv$/i.test(fileName) ? '\t' : ',';
  }
  return DELIMITERS[bestIndex];
}

// True when the file quotes every non-empty cell -- an export style worth
// preserving, because a file that quotes everything is usually consumed by
// something that expects it to.
function detectQuoteAll(text: string, delimiter: Delimiter): boolean {
  const truncated = text.length > QUOTE_SCAN_BYTES;
  const sample = truncated ? text.slice(0, QUOTE_SCAN_BYTES) : text;
  const parsed = parseCsv(sample, { delimiter, eol: '\n', finalNewline: false, quoteAll: false });
  // A truncated sample can cut a row in half, so its last row is not evidence.
  const rows = truncated ? parsed.rows.slice(0, Math.max(0, parsed.rows.length - 1)) : parsed.rows;

  let seen = 0;
  for (let r = 0; r < rows.length && r < QUOTE_SCAN_ROWS; r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.cells.length; c += 1) {
      if (row.cells[c] === '') {
        continue;
      }
      if (!row.quoted[c]) {
        return false;
      }
      seen += 1;
    }
  }
  return seen > 0;
}

export function detectFormat(text: string, fileName: string): CsvFormat {
  const delimiter = detectDelimiter(text, fileName);
  return {
    delimiter,
    eol: detectEol(text),
    // The initial guess only. Both EOLs end in '\n', so "the text ends with
    // the EOL" is exactly "the text ends with a newline" for any file with a
    // consistent line ending -- and it is the answer that keeps the trailing
    // newline on a file with mixed ones. parseCsv then refines it to what
    // finalNewline actually means (see types.ts), because only the parser
    // knows whether that newline terminated the last row or was swallowed by
    // an unterminated quote.
    finalNewline: text.length > 0 && text.charAt(text.length - 1) === '\n',
    quoteAll: detectQuoteAll(text, delimiter),
  };
}

// Whether writing this value bare would change what it means. Used for cells
// the user CHANGED; cells they did not touch keep the quoting they had.
export function needsQuote(value: string, delimiter: Delimiter): boolean {
  if (value === '') {
    return false;
  }
  if (value.indexOf(delimiter) !== -1 || value.indexOf('"') !== -1) {
    return true;
  }
  if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
    return true;
  }
  return /^\s|\s$/.test(value);
}
