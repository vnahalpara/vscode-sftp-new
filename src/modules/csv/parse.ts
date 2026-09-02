import { CsvFormat, CsvRow, CsvTable } from './types';

// RFC 4180 with the tolerance every real CSV file needs: a quote inside an
// unquoted field is literal, text after a closing quote is appended to the
// same field, and an unterminated quote runs to the end rather than throwing.
// This parser NEVER throws -- any text produces some table, because the
// alternative is an editor that refuses to open a file the user can see.
//
// Only `format.delimiter` is read. The whole format travels so the returned
// table is complete.
export function parseCsv(text: string, format: CsvFormat): CsvTable {
  const rows: CsvRow[] = [];
  const delimiter = format.delimiter;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const rowStart = i;
    const cells: string[] = [];
    const quoted: boolean[] = [];

    for (;;) {
      let value = '';
      let wasQuoted = false;

      if (text.charAt(i) === '"') {
        wasQuoted = true;
        i += 1;
        while (i < len) {
          const ch = text.charAt(i);
          if (ch === '"') {
            if (text.charAt(i + 1) === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i += 1; // the closing quote
            break;
          }
          value += ch;
          i += 1;
        }
        // Anything between the closing quote and the next delimiter or line
        // ending belongs to this field.
        while (i < len) {
          const ch = text.charAt(i);
          if (ch === delimiter || ch === '\n' || ch === '\r') {
            break;
          }
          value += ch;
          i += 1;
        }
      } else {
        while (i < len) {
          const ch = text.charAt(i);
          if (ch === delimiter || ch === '\n' || ch === '\r') {
            break;
          }
          value += ch;
          i += 1;
        }
      }

      cells.push(value);
      quoted.push(wasQuoted);

      if (i < len && text.charAt(i) === delimiter) {
        i += 1;
        continue;
      }
      break;
    }

    const rowEnd = i;
    if (text.charAt(i) === '\r') {
      i += 1;
    }
    if (text.charAt(i) === '\n') {
      i += 1;
    }
    rows.push({ cells, quoted, raw: text.slice(rowStart, rowEnd) });
  }

  return { rows, format };
}
