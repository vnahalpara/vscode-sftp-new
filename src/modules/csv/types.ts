// The CSV core's vocabulary. Kept apart from parse.ts so that protocol.ts and
// model.ts can name a table without pulling the parser into the webview
// bundle's import graph for nothing.

export type Delimiter = ',' | ';' | '\t' | '|';
export type Eol = '\n' | '\r\n';

export interface CsvFormat {
  delimiter: Delimiter;
  eol: Eol;
  // Did the text end with an EOL. Preserved so saving does not add or remove
  // a final newline the user never touched.
  finalNewline: boolean;
  // Does the file quote every non-empty cell. Drives the quoting of cells the
  // user changes, so an all-quoted export stays all-quoted.
  quoteAll: boolean;
}

export interface CsvRow {
  cells: string[];
  // Per cell: was it, or should it be, written in quotes.
  quoted: boolean[];
  // The row's original text without its EOL, or null once the row has been
  // edited. A row that still has its raw text is written back byte-for-byte,
  // which is what makes an edit to one cell leave the other 10,000 rows
  // untouched in the diff.
  raw: string | null;
}

export interface CsvTable {
  rows: CsvRow[];
  format: CsvFormat;
}

// In the order format.ts breaks ties in.
export const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];
