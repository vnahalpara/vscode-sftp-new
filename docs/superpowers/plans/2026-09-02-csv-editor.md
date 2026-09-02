# CSV Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `.csv` and `.tsv` file open in a searchable, editable grid editor that writes the file back in the format it was opened in.

**Architecture:** Three parts. A pure TypeScript **CSV core** under `src/modules/csv/` (format detection, parse, serialize, edit operations, shared protocol types) that jest tests exhaustively and that imports neither `vscode` nor Node. An **editor provider** (`CustomTextEditorProvider`) that owns the `TextDocument`, runs the core on it, and talks to the webview by messages — every grid change becomes one `WorkspaceEdit`, so the dirty dot, `Ctrl+S` and one-undo-step-per-operation come for free. A **React grid webview** under `webui/csv/`, built by a second Vite config in library mode into `media/csv/csv.js` + `media/csv/csv.css`, which draws the table and sends operations but never touches the file.

**Tech Stack:** TypeScript 3.9 (extension, compiled by webpack + ts-loader), React 18 + Vite 6 library mode (webview), jest 29 with `test/preprocessor.js` (transpile-only), VS Code 1.67 API.

**Spec:** `docs/superpowers/specs/2026-09-02-csv-editor-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- `npm test` (jest via `test/preprocessor.js`) does **NOT** typecheck. `npm run compile` (webpack + ts-loader, production) is what `vsce package` runs and it **DOES** typecheck. Every task ends with `npm run compile` green and `npm test` green **except the ONE known baseline failure** `transfer algorithm › sync › sync --update with time offset` in `src/fileHandlers/transfer/__tests__/transfer-test.ts`.
- `@types/vscode` is `1.67` and `engines.vscode` is `^1.67.0`. `@types/node` is v9. Extension `tsconfig` `lib` is `["es6"]`, `target` `es6`. **TypeScript is 3.9.10** — no template-literal types, no `satisfies`, no variadic tuples. Optional chaining and nullish coalescing are available (3.7+).
- Because `lib` is `["es6"]`: do **not** use `fs.rmSync`, `Object.fromEntries`, `Array.prototype.flat`, `Array.prototype.includes` (ES2016 — use `indexOf`), `String.prototype.matchAll`, `String.prototype.replaceAll`, `String.prototype.padStart`, or `Object.entries`. `String.prototype.endsWith`, `String.prototype.includes`, `Array.prototype.find` and the three-argument `localeCompare(that, locales, options)` **are** available (verified against tsc 3.9.10 with `--lib es6`).
- `strictNullChecks` and `noUnusedLocals` are on. `noUnusedParameters` is off, so `(_, index) => …` is fine.
- Jest tests live in `__tests__/*.ts` next to the code (`src/modules/csv/__tests__/` and `webui/csv/__tests__/`), **plain `.ts` only** — no `.tsx`, no JSX. `testMatch` is `<rootDir>/**/*/__tests__/*.ts`; `moduleFileExtensions` is `ts,js`; the transform runs on `.ts` only.
- The webview bundle is React + TypeScript (`.tsx` allowed there, built by Vite, **not** by jest or webpack). Pure logic the tests need must be in `.ts` files with no React import — with the single exception of `webui/csv/useVirtualRows.ts`, whose test imports only its pure function (React resolves fine under jest because it is an installed CommonJS package).
- `@types/react` is **NOT** installed and must not be added. `webui/` is excluded from `tsconfig.json`, webpack compiles only `src/`, and Vite transpiles without typechecking — so nothing ever typechecks `webui/csv/*.tsx`. Editor squiggles on React imports there are expected and harmless.
- Shared protocol types: `src/modules/csv/protocol.ts` is imported by BOTH the host (webpack) and the webview (Vite, via the relative path `../../src/modules/csv/protocol`). It must be types + tiny pure helpers only, **no `vscode` import, no Node APIs**. The same is true of `types.ts`, `parse.ts`, `format.ts`, `serialize.ts` and `model.ts`, all of which the webview bundle pulls in through `tableState.ts`.
- **Never re-export a type with `export … from`** in a file the webview imports. esbuild transpiles per file and cannot tell a type from a value, so `export { Delimiter } from './types'` becomes a runtime re-export of a binding that does not exist and Rollup fails the build. Import types directly from `./types` on both sides.
- Commit messages end with these two trailer lines exactly:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf`
- Version bumps to **1.32.0** (current is 1.31.1). CHANGELOG entry `## 1.32.0 - 2026-09-02` at the top; README section `## CSV editor` placed right after the `## PDF viewer` section.
- **Never run anything against a real remote host. No network.**
- Comments: minimal, truthful, explain WHY not what; match the style of `src/modules/pdf/viewer.ts`.
- Commands in `src/commands/` named `command*.ts` are auto-registered by `src/initCommands.ts` via `require.context` — there is **no manual registration step** for a new command file.
- macOS has no `timeout` command. Do not use it in verification scripts.

## Task order note

The spec lists `format.ts` before `parse.ts`, and the brief suggested the same order. **A real dependency forces the swap:** `detectFormat` must report `quoteAll`, which is "every non-empty cell in the first 1000 rows is quoted" — a per-cell fact that only a parser knows. The alternatives are to duplicate the field scanner inside `format.ts` (a DRY violation on the most correctness-critical code in the feature) or to have `format.ts` call `parseCsv`. This plan does the latter, so `parse.ts` is Task 1 and `format.ts` is Task 2. `parseCsv` takes a `CsvFormat` but reads only its `delimiter`, so the cycle is broken cleanly. Nothing else in the order changes.

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/modules/csv/types.ts` | `Delimiter`, `Eol`, `CsvFormat`, `CsvRow`, `CsvTable`, `DELIMITERS` | 1 |
| `src/modules/csv/parse.ts` | `parseCsv` — tolerant RFC 4180 scanner that records each row's `raw` | 1 |
| `src/modules/csv/format.ts` | `detectFormat`, `detectDelimiter`, `detectEol`, `needsQuote` | 2 |
| `src/modules/csv/serialize.ts` | `serializeCsv`, `serializeCell` — the round-trip half | 3 |
| `src/modules/csv/protocol.ts` | `CsvOp` union, `WebviewMessage`, `HostMessage`, `delimiterLabel`, `eolLabel` | 4 |
| `src/modules/csv/model.ts` | the operations as pure functions, `applyOp`, `tableWidth`, `tableRows`, `compareValues` | 4 |
| `src/modules/csv/shell.ts` | the webview page as a pure function of its URIs | 5 |
| `src/modules/csv/editorLogic.ts` | the provider's decisions that do not need `vscode` | 5 |
| `src/modules/csv/editor.ts` | `CsvEditorProvider`, the one file that imports `vscode` | 6 |
| `src/modules/editorTarget.ts` | `activeDocumentUri` — moved from `src/modules/markdown/target.ts` | 6 |
| `src/commands/commandCsvOpenAsText.ts` | the `sftp.csv.openAsText` command | 6 |
| `webui/csv/vite.config.ts` | the library-mode build into `media/csv/` | 7 |
| `webui/csv/vscode.ts` | the `acquireVsCodeApi` wrapper (the only impure webui module) | 7 |
| `webui/csv/search.ts` | `matchCell`, `filterRows`, `highlightRanges` | 7 |
| `webui/csv/sortState.ts` | the asc → desc → clear cycle | 7 |
| `webui/csv/tableState.ts` | optimistic `CsvOp` application on `string[][]`, by running the host's own `applyOp` | 7 |
| `webui/csv/main.tsx`, `App.tsx` | mount, message plumbing, op queue, screens | 7, 8, 9 |
| `webui/csv/useVirtualRows.ts` | `virtualWindow` (pure) + the scroll hook | 8 |
| `webui/csv/Grid.tsx`, `Toolbar.tsx` | the grid and the toolbar | 8 |
| `webui/csv/FindReplace.tsx`, `ContextMenu.tsx` | search/replace UI and the two context menus | 9 |
| `webui/csv/styles.css` | VS Code CSS variables only | 8, 9 |
| `scripts/verify-csv-grid.js` | headless-Chrome check of the built bundle | 10 |


## Reviewer amendments (apply these; they override the task text where they differ)

Recorded after a review of the plan against the spec. Each is a small change to the code shown
in the task named; the implementer of that task makes it.

**A1 — Task 6, `editor.ts`, `register()`: `supportsMultipleEditorsPerDocument: false`, not
`true`.** With `true`, two grid tabs on the same file each register their own
`onDidChangeTextDocument` handler, and the first handler to see the echo of a WorkspaceEdit clears
`lastWritten` — so the second panel treats nothing as an echo when it should, or, in the other
order, treats the edit as an echo and never updates. With `false` VS Code moves the existing tab
instead of opening a second one, so there is at most one panel per document and the echo mark is
sound. Keep the `panels` counter and `acquire`/`release` as written (VS Code can dispose and
recreate the one panel when a tab is dragged between groups, and the counter handles either
ordering). Update the comment to say why `false`: one grid per file, because a second one could
not be kept in sync through a per-panel echo mark. A side-by-side text editor is not a second
custom editor and is unaffected. The spec has been amended to match.

**A2 — Task 6, `editor.ts`, the `onDidReceiveMessage` handler: the `op` branch calls the async
`applyFromWebview` without awaiting it, so a rejection inside it (say `applyEdit` throwing on a
closed document) escapes the surrounding `try`/`catch` as an unhandled promise rejection.** Chain
a `.catch` on that call that does exactly what the `catch` block does: log via `logger.error`,
send `{ type: 'error', message }`, then `sendTable()`. Leave the synchronous `try`/`catch` in
place for the other branches.

**A3 (revised after Task 2 implementation) — Task 2, `format.ts`, `detectDelimiter`: count per
logical record, not per physical line.** The first version of this amendment said "skip a line that
began inside a quoted field". That drops the delimiters of a record whose FIRST column is
multi-line (`"line one\nline two";x` — the `;` is on a continuation line), so such a file fell back
to comma. The rule that satisfies the rationale in both directions: a record is the run of physical
lines up to and including the first line that ends with `inQuotes === false`; a record's count for
each candidate is the SUM of that candidate's outside-quotes occurrences across its physical lines;
a record whose text is empty (a blank line) is skipped; the sample is the first 50 records. The
quote state still carries across lines. Tests in `format-test.ts` must cover: the brief's original
fixture with the multi-line cell in the FIRST column (`'a;b\n"line one\nline two";x\n"p\nq";y\n'`
detects `;`); the same with the multi-line cell in the LAST column (detects `;`); and that
continuation lines do not count toward the 50-record sample (a file whose 50 records each span two
lines still detects its delimiter from all 50, and one whose delimiter only appears after record 50
is not seen). Ruling recorded in the ledger.

**A4 — Task 6, `editor.ts`, `acquire()`: skip parsing when the text is over the limit.** A file
the grid will refuse should not be parsed at open just to be thrown away; when
`isTooLarge(text.length)` is true, store an empty table (`{ rows: [], format: detectFormat('',
name) }`) and let `sendTable` send `tooLarge` as it already does. `reparse()` gets the same guard.

---

### Task 1: CSV types and the parser

**Files:**
- Create: `src/modules/csv/types.ts`
- Create: `src/modules/csv/parse.ts`
- Test: `src/modules/csv/__tests__/parse-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Delimiter = ',' | ';' | '\t' | '|'`
  - `type Eol = '\n' | '\r\n'`
  - `interface CsvFormat { delimiter: Delimiter; eol: Eol; finalNewline: boolean; quoteAll: boolean }`
  - `interface CsvRow { cells: string[]; quoted: boolean[]; raw: string | null }`
  - `interface CsvTable { rows: CsvRow[]; format: CsvFormat }`
  - `const DELIMITERS: Delimiter[]` — in the tie-break order `,` `;` `\t` `|`
  - `function parseCsv(text: string, format: CsvFormat): CsvTable`

**Notes:**
- `parseCsv` reads only `format.delimiter`. It carries the whole `CsvFormat` so the returned `CsvTable` is complete and so callers cannot forget to attach one.
- Spec ambiguity resolved: the spec says both "a blank line is a row with one empty cell" and "the trailing EOL does not produce a row". For the input `"\n"` these read differently. This plan takes **one row with one empty cell** — the text before the trailing EOL *is* a blank line, and "the trailing EOL does not produce a row" means it produces no *additional* row. `""` (a genuinely empty file) parses to zero rows. Both round-trip.

- [ ] **Step 1: Write the failing test**

Create `src/modules/csv/__tests__/parse-test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/csv/__tests__/parse-test.ts`
Expected: FAIL — `Cannot find module '../parse'`.

- [ ] **Step 3: Write `src/modules/csv/types.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/modules/csv/parse.ts`**

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/parse-test.ts`
Expected: PASS — 22 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run compile`
Expected: webpack succeeds with no TypeScript errors. (`parse.ts` is not imported by anything yet, so ts-loader will not visit it — that is expected; the real gate for this file arrives in Task 2.)

- [ ] **Step 7: Commit**

```bash
git add src/modules/csv/types.ts src/modules/csv/parse.ts src/modules/csv/__tests__/parse-test.ts
git commit -m "feat: parse CSV text into rows that remember their original text" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 2: Format detection and the quoting rule

**Files:**
- Create: `src/modules/csv/format.ts`
- Test: `src/modules/csv/__tests__/format-test.ts`

**Interfaces:**
- Consumes: `parseCsv(text, format)`, `CsvFormat`, `Delimiter`, `Eol`, `DELIMITERS` from Task 1.
- Produces:
  - `function detectFormat(text: string, fileName: string): CsvFormat`
  - `function detectDelimiter(text: string, fileName: string): Delimiter`
  - `function detectEol(text: string): Eol`
  - `function needsQuote(value: string, delimiter: Delimiter): boolean`

**Notes — two spec ambiguities resolved:**

1. **Quote state across lines.** The spec says "count each candidate outside quotes **on each line**". Read literally (reset the quote state at every line break) a file with newlines inside quoted fields is miscounted: in `a,b\n"line one\nline two",x\n` the third line starts inside a field, so the `"` flips the counter *into* quotes and the real delimiter is not counted. This plan **carries the quote state across the sampled lines**, which is the reading consistent with the rest of the spec (where a newline inside quotes is explicitly literal). Blank lines are skipped for scoring but still advance the state.
2. **Ties when computing the mode.** The spec defines the tie-breaks for the *score*, not for the mode itself. When two counts occur equally often, this plan takes **the larger count**. On the ragged fixture (`2, 1, 3` commas) that gives mode 3 and score 1, which still beats every other candidate's 0.

`finalNewline` is `text.length > 0 && the last character is '\n'`. Both EOLs end in `\n`, so for any file with a consistent line ending this is exactly the spec's "text ends with the EOL", and it is the safer answer for a file with mixed line endings (see Task 3's note on the round-trip guarantee).

- [ ] **Step 1: Write the failing test**

Create `src/modules/csv/__tests__/format-test.ts`:

```ts
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

  it('carries quote state across lines so an embedded newline does not hide the delimiter', () => {
    const text = 'a;b\n"line one\nline two";x\n"p\nq";y\n';
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/csv/__tests__/format-test.ts`
Expected: FAIL — `Cannot find module '../format'`.

- [ ] **Step 3: Write `src/modules/csv/format.ts`**

```ts
import { parseCsv } from './parse';
import { CsvFormat, Delimiter, DELIMITERS, Eol } from './types';

// How much of the file the two detectors look at. Both are sampling
// heuristics -- reading a 10MB export end to end twice to learn its delimiter
// would be the slowest thing the editor does.
const SAMPLE_LINES = 50;
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

// Score each candidate over the first SAMPLE_LINES non-empty lines: take the
// most common per-line count, and score the candidate by how many lines hit
// exactly that count. A mode of 0 means the character does not separate
// anything, so it scores 0.
//
// The quote state is NOT reset per line. A quoted field may span lines, and
// resetting would count the delimiters of every line after an embedded
// newline as if they were inside quotes.
export function detectDelimiter(text: string, fileName: string): Delimiter {
  const counts: number[][] = DELIMITERS.map(() => []);
  const lines = text.split(/\r\n|\n/);
  let inQuotes = false;
  let collected = 0;

  for (let l = 0; l < lines.length && collected < SAMPLE_LINES; l += 1) {
    const line = lines[l];
    const perLine = DELIMITERS.map(() => 0);
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
        perLine[d] += 1;
      }
    }
    if (line.length === 0) {
      continue;
    }
    for (let d = 0; d < DELIMITERS.length; d += 1) {
      counts[d].push(perLine[d]);
    }
    collected += 1;
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
    // Both EOLs end in '\n', so "the text ends with the EOL" is exactly "the
    // text ends with a newline" for any file with a consistent line ending --
    // and it is the answer that keeps the trailing newline on a file with
    // mixed ones.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/format-test.ts`
Expected: PASS — 33 tests.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx jest src/modules/csv && npm run compile`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/csv/format.ts src/modules/csv/__tests__/format-test.ts
git commit -m "feat: detect a CSV file's delimiter, line ending and quoting style" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 3: The serializer and the round-trip corpus

**Files:**
- Create: `src/modules/csv/serialize.ts`
- Create: 14 fixtures under `src/modules/csv/__tests__/__fixtures__/`
- Test: `src/modules/csv/__tests__/serialize-test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `detectFormat`, `CsvTable`, `CsvRow`, `CsvFormat` from Tasks 1–2.
- Produces:
  - `function serializeCsv(table: CsvTable): string`
  - `function serializeCell(value: string, quoted: boolean): string`

**Notes:**
- The fixtures live in `__tests__/__fixtures__/`, a *subdirectory*, so jest's `testMatch` (`<rootDir>/**/*/__tests__/*.ts`) never tries to run them, and webpack never sees them because nothing imports them.
- **Scope of the round-trip guarantee, stated honestly:** `serializeCsv(parseCsv(text, detectFormat(text, name))) === text` holds for any file with a *consistent* line ending — which is every fixture and every file a normal tool writes. A file with **mixed** line endings is normalized to the detected EOL, because `CsvFormat` has exactly one `Eol` field and `CsvRow` has no per-row terminator; preserving both would be a redesign of the spec's data model. Task 3 asserts the normalization explicitly rather than pretending it does not happen.

- [ ] **Step 1: Create the fixture corpus**

Run this exactly — writing the files from a script rather than by hand is the only way to be sure about trailing newlines and CRLFs:

```bash
mkdir -p src/modules/csv/__tests__/__fixtures__
node -e '
const fs = require("fs");
const dir = "src/modules/csv/__tests__/__fixtures__";
const files = {
  "plain.csv": "a,b,c\n1,2,3\n",
  "semicolon.csv": "name;note\n\"Doe, John\";\"said \"\"hi\"\"\"\n",
  "tabs.tsv": "a\tb\n1\t2\n",
  "pipe.csv": "a|b\n1|2\n",
  "crlf.csv": "a,b\r\n1,2\r\n",
  "no-final-newline.csv": "a,b\n1,2",
  "embedded-newlines.csv": "a,b\n\"line one\nline two\",x\n",
  "quote-escapes.csv": "a,b\n\"he said \"\"no\"\"\",2\n",
  "ragged.csv": "a,b,c\n1,2\n3,4,5,6\n",
  "blank-lines.csv": "a,b\n\n1,2\n\n",
  "trailing-delimiter.csv": "a,b,\n1,2,\n",
  "quote-all.csv": "\"a\",\"b\"\r\n\"1\",\"2\"\r\n",
  "empty.csv": "",
  "only-newline.csv": "\n"
};
Object.keys(files).forEach(name => fs.writeFileSync(dir + "/" + name, files[name], "utf8"));
console.log("wrote", Object.keys(files).length, "fixtures");
'
```

Expected output: `wrote 14 fixtures`.

Verify the bytes:

```bash
ls -la src/modules/csv/__tests__/__fixtures__/ && xxd src/modules/csv/__tests__/__fixtures__/crlf.csv | head -2
```
Expected: `crlf.csv` is 14 bytes and contains `0d 0a` twice; `empty.csv` is 0 bytes; `only-newline.csv` is 1 byte.

- [ ] **Step 2: Write the failing test**

Create `src/modules/csv/__tests__/serialize-test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { detectFormat } from '../format';
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

describe('mixed line endings', () => {
  // Documented, deliberate lossiness: CsvFormat holds one Eol and CsvRow has
  // no per-row terminator, so a mixed file is normalized to the detected one.
  it('normalizes to the first line ending found', () => {
    const text = 'a,b\r\n1,2\n3,4\n';
    const table = parseCsv(text, detectFormat(text, 'x.csv'));
    expect(serializeCsv(table)).toBe('a,b\r\n1,2\r\n3,4\r\n');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/modules/csv/__tests__/serialize-test.ts`
Expected: FAIL — `Cannot find module '../serialize'`.

- [ ] **Step 4: Write `src/modules/csv/serialize.ts`**

```ts
import { CsvRow, CsvTable } from './types';

export function serializeCell(value: string, quoted: boolean): string {
  return quoted ? `"${value.replace(/"/g, '""')}"` : value;
}

function serializeRow(row: CsvRow, delimiter: string): string {
  // A row nobody edited is written back byte-for-byte. This is what keeps a
  // one-cell edit to a 10,000-row file a one-line diff, and it is why `raw`
  // exists at all.
  if (row.raw !== null) {
    return row.raw;
  }
  return row.cells
    .map((cell, index) => serializeCell(cell, row.quoted[index] === true))
    .join(delimiter);
}

export function serializeCsv(table: CsvTable): string {
  const { rows, format } = table;
  const body = rows.map(row => serializeRow(row, format.delimiter)).join(format.eol);
  // No trailing eol on a file with no rows: deleting every row should leave an
  // empty file, not a lone newline.
  return format.finalNewline && rows.length > 0 ? body + format.eol : body;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/serialize-test.ts`
Expected: PASS — 27 tests, including 14 named `serialize(parse(<fixture>)) is byte-identical`.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx jest src/modules/csv && npm run compile`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/csv/serialize.ts src/modules/csv/__tests__/serialize-test.ts src/modules/csv/__tests__/__fixtures__
git commit -m "feat: write a CSV table back in the format it was read in" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 4: The operation model and the message protocol

**Files:**
- Create: `src/modules/csv/protocol.ts`
- Create: `src/modules/csv/model.ts`
- Test: `src/modules/csv/__tests__/model-test.ts`

**Interfaces:**
- Consumes: `needsQuote` (Task 2); `CsvFormat`, `CsvRow`, `CsvTable`, `Delimiter`, `Eol` (Task 1).
- Produces from `protocol.ts`:
  - `type SortDirection = 'asc' | 'desc'`
  - `interface SetCellOp { type: 'setCell'; row: number; col: number; value: string }`
  - `interface InsertRowsOp { type: 'insertRows'; at: number; count: number }`
  - `interface DuplicateRowsOp { type: 'duplicateRows'; rows: number[] }`
  - `interface DeleteRowsOp { type: 'deleteRows'; rows: number[] }`
  - `interface InsertColumnOp { type: 'insertColumn'; at: number }`
  - `interface DeleteColumnOp { type: 'deleteColumn'; col: number }`
  - `interface SortOp { type: 'sort'; col: number; direction: SortDirection; hasHeader: boolean }`
  - `interface ReplaceAllOp { type: 'replaceAll'; find: string; replace: string; col?: number; matchCase: boolean; hasHeader: boolean }`
  - `type CsvOp = SetCellOp | InsertRowsOp | DuplicateRowsOp | DeleteRowsOp | InsertColumnOp | DeleteColumnOp | SortOp | ReplaceAllOp`
  - `type WebviewMessage = { type: 'ready' } | { type: 'op'; base: number; op: CsvOp } | { type: 'openAsText' }`
  - `type HostMessage = TableMessage | AckMessage | TooLargeMessage | ErrorMessage` (shapes below)
  - `function delimiterLabel(delimiter: Delimiter): string`, `function eolLabel(eol: Eol): string`
- Produces from `model.ts`:
  - `function tableWidth(table: CsvTable): number`
  - `function tableRows(table: CsvTable): string[][]`
  - `function compareValues(a: string, b: string): number`
  - `function setCell(table: CsvTable, row: number, col: number, value: string): CsvTable`
  - `function insertRows(table: CsvTable, at: number, count: number): CsvTable`
  - `function duplicateRows(table: CsvTable, targets: number[]): CsvTable`
  - `function deleteRows(table: CsvTable, targets: number[]): CsvTable`
  - `function insertColumn(table: CsvTable, at: number): CsvTable`
  - `function deleteColumn(table: CsvTable, col: number): CsvTable`
  - `function sortRows(table: CsvTable, col: number, direction: SortDirection, hasHeader: boolean): CsvTable`
  - `function replaceAll(table: CsvTable, find: string, replace: string, col: number | undefined, matchCase: boolean, hasHeader: boolean): CsvTable`
  - `function applyOp(table: CsvTable, op: CsvOp): CsvTable`

**Notes:**
- Every function is pure: the input table and its rows and arrays are never mutated, so the host can keep the previous table if a `WorkspaceEdit` fails.
- Row indices are **document** indices throughout. The header toggle only ever appears as an operation's `hasHeader` field.
- `delimiterLabel`/`eolLabel` live in `protocol.ts` because they describe protocol values and both sides render them; they are the "tiny pure helpers" the protocol module is allowed.

- [ ] **Step 1: Write `src/modules/csv/protocol.ts`**

There is no test-first cycle for a file that is almost entirely types — the test in Step 3 covers the two helpers, and `npm run compile` is the gate for the rest.

```ts
import { Delimiter, Eol } from './types';

// The wire format between the editor provider and the grid webview. Shared by
// BOTH sides: the host compiles it with webpack, the webview imports it from
// Vite by relative path. That means no `vscode` import, no Node API, and no
// `export ... from` re-export of a type (esbuild would turn one into a runtime
// re-export of a binding that does not exist and Rollup would fail).

export type SortDirection = 'asc' | 'desc';

export interface SetCellOp {
  type: 'setCell';
  row: number;
  col: number;
  value: string;
}

export interface InsertRowsOp {
  type: 'insertRows';
  at: number;
  count: number;
}

export interface DuplicateRowsOp {
  type: 'duplicateRows';
  rows: number[];
}

export interface DeleteRowsOp {
  type: 'deleteRows';
  rows: number[];
}

export interface InsertColumnOp {
  type: 'insertColumn';
  at: number;
}

export interface DeleteColumnOp {
  type: 'deleteColumn';
  col: number;
}

export interface SortOp {
  type: 'sort';
  col: number;
  direction: SortDirection;
  hasHeader: boolean;
}

export interface ReplaceAllOp {
  type: 'replaceAll';
  find: string;
  replace: string;
  // Absent means every column.
  col?: number;
  matchCase: boolean;
  hasHeader: boolean;
}

export type CsvOp =
  | SetCellOp
  | InsertRowsOp
  | DuplicateRowsOp
  | DeleteRowsOp
  | InsertColumnOp
  | DeleteColumnOp
  | SortOp
  | ReplaceAllOp;

export interface ReadyMessage {
  type: 'ready';
}

export interface OpMessage {
  type: 'op';
  // The document version the op was made against. The host rejects the op if
  // the document has moved on, because the webview's copy is then not the
  // document any more.
  base: number;
  op: CsvOp;
}

export interface OpenAsTextMessage {
  type: 'openAsText';
}

export type WebviewMessage = ReadyMessage | OpMessage | OpenAsTextMessage;

export interface TableMessage {
  type: 'table';
  revision: number;
  rows: string[][];
  delimiter: Delimiter;
  eol: Eol;
  readOnly: boolean;
  readOnlyReason?: string;
}

export interface AckMessage {
  type: 'ack';
  revision: number;
}

export interface TooLargeMessage {
  type: 'tooLarge';
  bytes: number;
  limit: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type HostMessage = TableMessage | AckMessage | TooLargeMessage | ErrorMessage;

export function delimiterLabel(delimiter: Delimiter): string {
  if (delimiter === ',') {
    return 'Comma';
  }
  if (delimiter === ';') {
    return 'Semicolon';
  }
  if (delimiter === '\t') {
    return 'Tab';
  }
  return 'Pipe';
}

export function eolLabel(eol: Eol): string {
  return eol === '\r\n' ? 'CRLF' : 'LF';
}
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/csv/__tests__/model-test.ts`:

```ts
import { delimiterLabel, eolLabel } from '../protocol';
import {
  applyOp,
  compareValues,
  deleteColumn,
  deleteRows,
  duplicateRows,
  insertColumn,
  insertRows,
  replaceAll,
  setCell,
  sortRows,
  tableRows,
  tableWidth,
} from '../model';
import { serializeCsv } from '../serialize';
import { CsvFormat, CsvTable } from '../types';

const COMMA: CsvFormat = { delimiter: ',', eol: '\n', finalNewline: true, quoteAll: false };
const QUOTE_ALL: CsvFormat = { ...COMMA, quoteAll: true };

// Build a table whose rows all still carry their raw text, so every test can
// ask the sharpest question there is: which rows LOST it.
function tableOf(rows: string[][], format: CsvFormat = COMMA): CsvTable {
  return {
    rows: rows.map(cells => ({
      cells: cells.slice(),
      quoted: cells.map(() => false),
      raw: cells.join(format.delimiter),
    })),
    format,
  };
}

const raws = (table: CsvTable) => table.rows.map(row => row.raw);

describe('tableWidth', () => {
  it('is the widest row', () => {
    expect(tableWidth(tableOf([['a'], ['a', 'b', 'c'], ['a', 'b']]))).toBe(3);
  });
  it('is 0 for an empty table', () => {
    expect(tableWidth(tableOf([]))).toBe(0);
  });
});

describe('tableRows', () => {
  it('is the cells, ragged as they are', () => {
    expect(tableRows(tableOf([['a', 'b'], ['c']]))).toEqual([['a', 'b'], ['c']]);
  });
  it('copies, so the caller cannot reach back into the table', () => {
    const table = tableOf([['a']]);
    tableRows(table)[0][0] = 'mutated';
    expect(table.rows[0].cells[0]).toBe('a');
  });
});

describe('setCell', () => {
  it('sets the value', () => {
    const next = setCell(tableOf([['a', 'b']]), 0, 1, 'z');
    expect(next.rows[0].cells).toEqual(['a', 'z']);
  });

  it('rebuilds only that row', () => {
    const next = setCell(tableOf([['a'], ['b'], ['c']]), 1, 0, 'z');
    expect(raws(next)).toEqual(['a', null, 'c']);
  });

  it('pads the row with empty cells when the column is beyond its end', () => {
    const next = setCell(tableOf([['a']]), 0, 3, 'z');
    expect(next.rows[0].cells).toEqual(['a', '', '', 'z']);
  });

  it('quotes the new value when it needs it', () => {
    const next = setCell(tableOf([['a', 'b']]), 0, 1, 'x,y');
    expect(next.rows[0].quoted).toEqual([false, true]);
  });

  it('quotes the new value in a quote-all file even when it does not need it', () => {
    const next = setCell(tableOf([['a', 'b']], QUOTE_ALL), 0, 1, 'z');
    expect(next.rows[0].quoted).toEqual([false, true]);
  });

  it('leaves other cells quoting alone', () => {
    const table = tableOf([['a', 'b']]);
    table.rows[0].quoted = [true, false];
    expect(setCell(table, 0, 1, 'z').rows[0].quoted).toEqual([true, false]);
  });

  it('does not mutate the table it was given', () => {
    const table = tableOf([['a']]);
    setCell(table, 0, 0, 'z');
    expect(table.rows[0].cells).toEqual(['a']);
    expect(table.rows[0].raw).toBe('a');
  });

  it('ignores a row index the table does not have', () => {
    const table = tableOf([['a']]);
    expect(setCell(table, 5, 0, 'z')).toBe(table);
  });
});

describe('insertRows', () => {
  it('inserts blank rows of the table width at the index', () => {
    const next = insertRows(tableOf([['a', 'b'], ['c', 'd']]), 1, 2);
    expect(tableRows(next)).toEqual([['a', 'b'], ['', ''], ['', ''], ['c', 'd']]);
  });

  it('rebuilds only the new rows', () => {
    expect(raws(insertRows(tableOf([['a'], ['b']]), 1, 1))).toEqual(['a', null, 'b']);
  });

  it('quotes the new blanks in a quote-all file', () => {
    const next = insertRows(tableOf([['a', 'b']], QUOTE_ALL), 1, 1);
    expect(next.rows[1].quoted).toEqual([true, true]);
  });

  it('gives an empty table one cell to start from', () => {
    expect(tableRows(insertRows(tableOf([]), 0, 1))).toEqual([['']]);
  });

  it('clamps an index past the end to the end', () => {
    expect(tableRows(insertRows(tableOf([['a']]), 99, 1))).toEqual([['a'], ['']]);
  });
});

describe('duplicateRows', () => {
  it('puts each copy directly after its original', () => {
    expect(tableRows(duplicateRows(tableOf([['a'], ['b'], ['c']]), [0, 2]))).toEqual([
      ['a'], ['a'], ['b'], ['c'], ['c'],
    ]);
  });

  // The copy is byte-identical to the original when written, which is why it
  // keeps the original's raw rather than being rebuilt.
  it('keeps raw on the copies so nothing is rebuilt', () => {
    const next = duplicateRows(tableOf([['a'], ['b']]), [0]);
    expect(raws(next)).toEqual(['a', 'a', 'b']);
  });

  it('copies the cells rather than sharing them', () => {
    const next = duplicateRows(tableOf([['a']]), [0]);
    expect(next.rows[0].cells).not.toBe(next.rows[1].cells);
  });

  it('ignores duplicates and out-of-range indices', () => {
    expect(tableRows(duplicateRows(tableOf([['a']]), [0, 0, 7]))).toEqual([['a'], ['a']]);
  });
});

describe('deleteRows', () => {
  it('removes the rows', () => {
    expect(tableRows(deleteRows(tableOf([['a'], ['b'], ['c']]), [0, 2]))).toEqual([['b']]);
  });
  it('rebuilds nothing', () => {
    expect(raws(deleteRows(tableOf([['a'], ['b']]), [0]))).toEqual(['b']);
  });
  it('does nothing for an empty selection', () => {
    const table = tableOf([['a']]);
    expect(deleteRows(table, [])).toBe(table);
  });
});

describe('insertColumn', () => {
  it('inserts an empty cell at the index in every row', () => {
    expect(tableRows(insertColumn(tableOf([['a', 'b'], ['c', 'd']]), 1))).toEqual([
      ['a', '', 'b'],
      ['c', '', 'd'],
    ]);
  });

  it('pads a short row out to the index first', () => {
    expect(tableRows(insertColumn(tableOf([['a', 'b', 'c'], ['x']]), 2))).toEqual([
      ['a', 'b', '', 'c'],
      ['x', '', ''],
    ]);
  });

  it('rebuilds every row', () => {
    expect(raws(insertColumn(tableOf([['a'], ['b']]), 0))).toEqual([null, null]);
  });

  it('quotes the new cell in a quote-all file', () => {
    expect(insertColumn(tableOf([['a']], QUOTE_ALL), 0).rows[0].quoted).toEqual([true, false]);
  });
});

describe('deleteColumn', () => {
  it('removes the column from every row that has it', () => {
    expect(tableRows(deleteColumn(tableOf([['a', 'b', 'c'], ['x', 'y', 'z']]), 1))).toEqual([
      ['a', 'c'],
      ['x', 'z'],
    ]);
  });

  it('leaves a row that never had the column alone, raw and all', () => {
    const next = deleteColumn(tableOf([['a', 'b', 'c'], ['x']]), 2);
    expect(tableRows(next)).toEqual([['a', 'b'], ['x']]);
    expect(raws(next)).toEqual([null, 'x']);
  });
});

describe('compareValues', () => {
  it('compares two numbers numerically, not as text', () => {
    expect(compareValues('9', '10')).toBeLessThan(0);
  });
  it('compares decimals and negatives', () => {
    expect(compareValues('-2.5', '1')).toBeLessThan(0);
    expect(compareValues('1.5', '1.25')).toBeGreaterThan(0);
  });
  it('tolerates surrounding whitespace on a number', () => {
    expect(compareValues(' 2 ', '10')).toBeLessThan(0);
  });
  it('falls back to a case-insensitive text compare', () => {
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
    expect(compareValues('Apple', 'apple')).toBe(0);
  });
  it('compares mixed text and numbers as text', () => {
    expect(compareValues('10', 'a')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  const NUMBERS = () => tableOf([['n'], ['10'], ['9'], ['100']]);

  it('sorts data rows ascending and leaves the header where it is', () => {
    expect(tableRows(sortRows(NUMBERS(), 0, 'asc', true))).toEqual([['n'], ['9'], ['10'], ['100']]);
  });

  it('sorts descending', () => {
    expect(tableRows(sortRows(NUMBERS(), 0, 'desc', true))).toEqual([['n'], ['100'], ['10'], ['9']]);
  });

  it('sorts row 0 too when the header toggle is off', () => {
    // All-numeric on purpose: the comparator is numeric for two numbers and
    // locale for anything else, so a table mixing the two has no order this
    // test could assert without depending on comparison order.
    const table = tableOf([['3'], ['1'], ['2']]);
    expect(tableRows(sortRows(table, 0, 'asc', false))).toEqual([['1'], ['2'], ['3']]);
  });

  it('keeps every row raw, because sorting only moves rows', () => {
    expect(raws(sortRows(NUMBERS(), 0, 'asc', true))).toEqual(['n', '9', '10', '100']);
  });

  it('is stable: equal keys keep their original order', () => {
    const table = tableOf([['k', 'v'], ['a', '1'], ['a', '2'], ['a', '3']]);
    expect(tableRows(sortRows(table, 0, 'asc', true)).map(row => row[1])).toEqual(
      ['1', '2', '3']
    );
  });

  it('is stable in the descending direction too', () => {
    const table = tableOf([['k', 'v'], ['a', '1'], ['a', '2'], ['a', '3']]);
    expect(tableRows(sortRows(table, 0, 'desc', true)).map(row => row[1])).toEqual(
      ['1', '2', '3']
    );
  });

  it('sends empty cells to the bottom ascending', () => {
    const table = tableOf([['k'], ['b'], [''], ['a']]);
    expect(tableRows(sortRows(table, 0, 'asc', true))).toEqual([['k'], ['a'], ['b'], ['']]);
  });

  // Not negated with the rest of the comparator: a blank is missing data and
  // belongs out of the way whichever way the column is sorted.
  it('sends empty cells to the bottom descending as well', () => {
    const table = tableOf([['k'], ['b'], [''], ['a']]);
    expect(tableRows(sortRows(table, 0, 'desc', true))).toEqual([['k'], ['b'], ['a'], ['']]);
  });

  it('treats a missing cell on a ragged row as empty', () => {
    const table = tableOf([['k', 'v'], ['x'], ['a', 'b']]);
    expect(tableRows(sortRows(table, 1, 'asc', true))).toEqual([['k', 'v'], ['a', 'b'], ['x']]);
  });

  it('does nothing dangerous to an empty table', () => {
    expect(tableRows(sortRows(tableOf([]), 0, 'asc', true))).toEqual([]);
  });
});

describe('replaceAll', () => {
  const T = () => tableOf([['name', 'note'], ['cat', 'a cat here'], ['dog', 'no match']]);

  it('replaces every occurrence in every data cell', () => {
    const next = replaceAll(T(), 'cat', 'fox', undefined, true, true);
    expect(tableRows(next)).toEqual([['name', 'note'], ['fox', 'a fox here'], ['dog', 'no match']]);
  });

  it('replaces repeated occurrences within one cell', () => {
    const table = tableOf([['h'], ['a a a']]);
    expect(tableRows(replaceAll(table, 'a', 'b', undefined, true, true))).toEqual([['h'], ['b b b']]);
  });

  it('rebuilds only the rows that matched', () => {
    expect(raws(replaceAll(T(), 'cat', 'fox', undefined, true, true))).toEqual([
      'name,note',
      null,
      'dog,no match',
    ]);
  });

  it('never touches row 0 when the header toggle is on', () => {
    const table = tableOf([['cat'], ['cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, true, true))).toEqual([['cat'], ['fox']]);
  });

  it('treats row 0 as data when the header toggle is off', () => {
    const table = tableOf([['cat'], ['cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, true, false))).toEqual([['fox'], ['fox']]);
  });

  it('honours a column scope', () => {
    const next = replaceAll(T(), 'cat', 'fox', 1, true, true);
    expect(tableRows(next)).toEqual([['name', 'note'], ['cat', 'a fox here'], ['dog', 'no match']]);
  });

  it('matches case-insensitively when asked, and keeps the replacement verbatim', () => {
    const table = tableOf([['h'], ['CAT and cat']]);
    expect(tableRows(replaceAll(table, 'cat', 'fox', undefined, false, true))).toEqual([
      ['h'],
      ['fox and fox'],
    ]);
  });

  it('does not match a different case when matchCase is on', () => {
    const table = tableOf([['h'], ['CAT']]);
    expect(replaceAll(table, 'cat', 'fox', undefined, true, true)).toEqual(table);
  });

  it('re-quotes a replaced cell that now needs quoting', () => {
    const table = tableOf([['h'], ['ab']]);
    expect(replaceAll(table, 'b', ',b', undefined, true, true).rows[1].quoted).toEqual([true]);
  });

  it('does nothing at all for an empty search', () => {
    const table = T();
    expect(replaceAll(table, '', 'x', undefined, true, true)).toBe(table);
  });

  it('returns the same table when nothing matched', () => {
    const table = T();
    expect(replaceAll(table, 'zebra', 'x', undefined, true, true)).toBe(table);
  });
});

describe('applyOp', () => {
  it('dispatches setCell', () => {
    const next = applyOp(tableOf([['a']]), { type: 'setCell', row: 0, col: 0, value: 'z' });
    expect(tableRows(next)).toEqual([['z']]);
  });
  it('dispatches insertRows', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'insertRows', at: 0, count: 1 }))).toEqual([
      [''], ['a'],
    ]);
  });
  it('dispatches duplicateRows', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'duplicateRows', rows: [0] }))).toEqual([
      ['a'], ['a'],
    ]);
  });
  it('dispatches deleteRows', () => {
    expect(tableRows(applyOp(tableOf([['a'], ['b']]), { type: 'deleteRows', rows: [0] }))).toEqual([['b']]);
  });
  it('dispatches insertColumn', () => {
    expect(tableRows(applyOp(tableOf([['a']]), { type: 'insertColumn', at: 0 }))).toEqual([['', 'a']]);
  });
  it('dispatches deleteColumn', () => {
    expect(tableRows(applyOp(tableOf([['a', 'b']]), { type: 'deleteColumn', col: 0 }))).toEqual([['b']]);
  });
  it('dispatches sort', () => {
    const table = tableOf([['h'], ['b'], ['a']]);
    expect(
      tableRows(applyOp(table, { type: 'sort', col: 0, direction: 'asc', hasHeader: true }))
    ).toEqual([['h'], ['a'], ['b']]);
  });
  it('dispatches replaceAll', () => {
    const table = tableOf([['h'], ['cat']]);
    const op = { type: 'replaceAll' as 'replaceAll', find: 'cat', replace: 'fox', matchCase: true, hasHeader: true };
    expect(tableRows(applyOp(table, op))).toEqual([['h'], ['fox']]);
  });
});

describe('an operation serialized back to text', () => {
  // The end-to-end shape of what the provider does: apply one op, write the
  // file, and change nothing else.
  it('changes only the edited row', () => {
    const table = tableOf([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    const next = applyOp(table, { type: 'setCell', row: 1, col: 1, value: 'Z,Z' });
    expect(serializeCsv(next)).toBe('a,b\nc,"Z,Z"\ne,f\n');
  });
});

describe('the protocol labels', () => {
  it('names every delimiter', () => {
    expect(delimiterLabel(',')).toBe('Comma');
    expect(delimiterLabel(';')).toBe('Semicolon');
    expect(delimiterLabel('\t')).toBe('Tab');
    expect(delimiterLabel('|')).toBe('Pipe');
  });
  it('names both line endings', () => {
    expect(eolLabel('\n')).toBe('LF');
    expect(eolLabel('\r\n')).toBe('CRLF');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/modules/csv/__tests__/model-test.ts`
Expected: FAIL — `Cannot find module '../model'`.

- [ ] **Step 4: Write `src/modules/csv/model.ts`**

```ts
import { needsQuote } from './format';
import { CsvOp, SortDirection } from './protocol';
import { CsvFormat, CsvRow, CsvTable } from './types';

// Every operation is a pure (table, args) => table. Nothing here mutates its
// input, which is what lets the provider keep the old table when a
// WorkspaceEdit fails.
//
// Each one sets `raw = null` on EXACTLY the rows it changes, and no others:
// that is the difference between a one-line diff and a whole-file rewrite.

export function tableWidth(table: CsvTable): number {
  let width = 0;
  for (const row of table.rows) {
    if (row.cells.length > width) {
      width = row.cells.length;
    }
  }
  return width;
}

export function tableRows(table: CsvTable): string[][] {
  return table.rows.map(row => row.cells.slice());
}

function blankRow(format: CsvFormat, width: number): CsvRow {
  const cells: string[] = [];
  const quoted: boolean[] = [];
  for (let i = 0; i < width; i += 1) {
    cells.push('');
    quoted.push(format.quoteAll);
  }
  return { cells, quoted, raw: null };
}

// A copy of `row` at least `length` cells wide. Always a copy, so the caller
// may write to it.
function padTo(row: CsvRow, length: number, format: CsvFormat): CsvRow {
  const cells = row.cells.slice();
  const quoted = row.quoted.slice();
  if (cells.length >= length) {
    return { cells, quoted, raw: row.raw };
  }
  while (cells.length < length) {
    cells.push('');
    quoted.push(format.quoteAll);
  }
  return { cells, quoted, raw: null };
}

// Sorted, de-duplicated, in-range row indices.
function indexSet(values: number[], length: number): number[] {
  const out: number[] = [];
  values.forEach(value => {
    if (value >= 0 && value < length && out.indexOf(value) === -1) {
      out.push(value);
    }
  });
  return out.sort((a, b) => a - b);
}

export function setCell(table: CsvTable, row: number, col: number, value: string): CsvTable {
  if (row < 0 || row >= table.rows.length || col < 0) {
    return table;
  }
  const format = table.format;
  const target = padTo(table.rows[row], col + 1, format);
  target.cells[col] = value;
  target.quoted[col] = format.quoteAll || needsQuote(value, format.delimiter);
  target.raw = null;
  const rows = table.rows.slice();
  rows[row] = target;
  return { rows, format };
}

export function insertRows(table: CsvTable, at: number, count: number): CsvTable {
  if (count <= 0) {
    return table;
  }
  // An empty file still needs somewhere to type, so its first row gets one cell.
  const width = Math.max(1, tableWidth(table));
  const index = Math.min(Math.max(0, at), table.rows.length);
  const made: CsvRow[] = [];
  for (let i = 0; i < count; i += 1) {
    made.push(blankRow(table.format, width));
  }
  return {
    rows: table.rows.slice(0, index).concat(made, table.rows.slice(index)),
    format: table.format,
  };
}

export function duplicateRows(table: CsvTable, targets: number[]): CsvTable {
  const set = indexSet(targets, table.rows.length);
  if (set.length === 0) {
    return table;
  }
  const rows: CsvRow[] = [];
  table.rows.forEach((row, index) => {
    rows.push(row);
    if (set.indexOf(index) !== -1) {
      // The copy keeps the original's raw: it serializes identically, so
      // duplicating a row rewrites nothing.
      rows.push({ cells: row.cells.slice(), quoted: row.quoted.slice(), raw: row.raw });
    }
  });
  return { rows, format: table.format };
}

export function deleteRows(table: CsvTable, targets: number[]): CsvTable {
  const set = indexSet(targets, table.rows.length);
  if (set.length === 0) {
    return table;
  }
  return {
    rows: table.rows.filter((_, index) => set.indexOf(index) === -1),
    format: table.format,
  };
}

export function insertColumn(table: CsvTable, at: number): CsvTable {
  if (at < 0) {
    return table;
  }
  const format = table.format;
  const rows = table.rows.map(row => {
    const next = padTo(row, at, format);
    next.cells.splice(at, 0, '');
    next.quoted.splice(at, 0, format.quoteAll);
    next.raw = null;
    return next;
  });
  return { rows, format };
}

export function deleteColumn(table: CsvTable, col: number): CsvTable {
  if (col < 0) {
    return table;
  }
  const rows = table.rows.map(row => {
    if (col >= row.cells.length) {
      return row;
    }
    const cells = row.cells.slice();
    const quoted = row.quoted.slice();
    cells.splice(col, 1);
    quoted.splice(col, 1);
    return { cells, quoted, raw: null };
  });
  return { rows, format: table.format };
}

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

export function compareValues(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function cellAt(row: CsvRow, col: number): string {
  return col >= 0 && col < row.cells.length ? row.cells[col] : '';
}

export function sortRows(
  table: CsvTable,
  col: number,
  direction: SortDirection,
  hasHeader: boolean
): CsvTable {
  const start = hasHeader && table.rows.length > 0 ? 1 : 0;
  const head = table.rows.slice(0, start);
  // Decorated with the original index so stability is a property of this code
  // rather than of the engine's sort.
  const data = table.rows.slice(start).map((row, index) => ({ row, index }));

  data.sort((a, b) => {
    const av = cellAt(a.row, col);
    const bv = cellAt(b.row, col);
    const aEmpty = av === '';
    const bEmpty = bv === '';
    if (aEmpty || bEmpty) {
      // Blanks sink in BOTH directions, so this branch is never negated.
      if (aEmpty && bEmpty) {
        return a.index - b.index;
      }
      return aEmpty ? 1 : -1;
    }
    const compared = compareValues(av, bv);
    if (compared !== 0) {
      return direction === 'desc' ? -compared : compared;
    }
    return a.index - b.index;
  });

  return { rows: head.concat(data.map(entry => entry.row)), format: table.format };
}

// Plain-substring replace of every occurrence. Hand-rolled because
// String.prototype.replaceAll is ES2021 and a RegExp would make the user's
// search text a pattern, which is explicitly out of scope for 1.32.0.
function replacePlain(value: string, find: string, replace: string, matchCase: boolean): string {
  const haystack = matchCase ? value : value.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) {
      return out + value.slice(i);
    }
    out += value.slice(i, at) + replace;
    i = at + needle.length;
  }
}

export function replaceAll(
  table: CsvTable,
  find: string,
  replace: string,
  col: number | undefined,
  matchCase: boolean,
  hasHeader: boolean
): CsvTable {
  if (find === '') {
    return table;
  }
  const format = table.format;
  const start = hasHeader && table.rows.length > 0 ? 1 : 0;
  let changedAny = false;

  const rows = table.rows.map((row, index) => {
    if (index < start) {
      return row;
    }
    const cells = row.cells.slice();
    const quoted = row.quoted.slice();
    let changed = false;
    for (let c = 0; c < cells.length; c += 1) {
      if (col !== undefined && c !== col) {
        continue;
      }
      const next = replacePlain(cells[c], find, replace, matchCase);
      if (next !== cells[c]) {
        cells[c] = next;
        quoted[c] = format.quoteAll || needsQuote(next, format.delimiter);
        changed = true;
      }
    }
    if (!changed) {
      return row;
    }
    changedAny = true;
    return { cells, quoted, raw: null };
  });

  return changedAny ? { rows, format } : table;
}

export function applyOp(table: CsvTable, op: CsvOp): CsvTable {
  switch (op.type) {
    case 'setCell':
      return setCell(table, op.row, op.col, op.value);
    case 'insertRows':
      return insertRows(table, op.at, op.count);
    case 'duplicateRows':
      return duplicateRows(table, op.rows);
    case 'deleteRows':
      return deleteRows(table, op.rows);
    case 'insertColumn':
      return insertColumn(table, op.at);
    case 'deleteColumn':
      return deleteColumn(table, op.col);
    case 'sort':
      return sortRows(table, op.col, op.direction, op.hasHeader);
    case 'replaceAll':
      return replaceAll(table, op.find, op.replace, op.col, op.matchCase, op.hasHeader);
    default:
      return table;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/model-test.ts`
Expected: PASS — 67 tests.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx jest src/modules/csv && npm run compile`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/csv/protocol.ts src/modules/csv/model.ts src/modules/csv/__tests__/model-test.ts
git commit -m "feat: add the CSV edit operations and the host/webview protocol" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 5: The webview shell and the provider's pure decisions

**Files:**
- Create: `src/modules/csv/shell.ts`
- Create: `src/modules/csv/editorLogic.ts`
- Test: `src/modules/csv/__tests__/shell-test.ts`
- Test: `src/modules/csv/__tests__/editorLogic-test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface CsvShellOptions { scriptUri: string; styleUri: string; cspSource: string; nonce: string; title: string }`
  - `function buildCsvShell(opts: CsvShellOptions): string`
  - `const MAX_GRID_BYTES: number` (`10 * 1024 * 1024`)
  - `const REMOTE_READ_ONLY_REASON: string`
  - `function isTooLarge(length: number, limit?: number): boolean`
  - `function isEcho(text: string, lastWritten: string | null): boolean`
  - `function isStaleOp(base: number, version: number): boolean`
  - `function readOnlyReasonFor(scheme: string, remoteScheme: string): string | undefined`

**Notes:**
- The shell is a pure function of its URIs for the same reason the PDF shell is: it can be unit-tested without the `vscode` module, and the same HTML can be written to disk and driven in headless Chrome (Task 10).
- The CSP is exactly the spec's: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource} 'unsafe-inline'`. A nonce authorises an *external* `<script src>` too, which is why the bundle's host does not need to appear in `script-src`. `'unsafe-inline'` for styles is required: virtual-scroll offsets and column widths are inline `style` attributes, and there is no nonce mechanism for those.
- `editorLogic.ts` exists so the three decisions that actually have edge cases — is the file too big, is this change our own echo, is this op stale — are tested, while `editor.ts` stays thin enough to be verified by `npm run compile` plus the Task 10 smoke test.

- [ ] **Step 1: Write the failing shell test**

Create `src/modules/csv/__tests__/shell-test.ts`:

```ts
import { buildCsvShell } from '../shell';

const OPTS = {
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/csv/csv.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/csv/csv.css',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  nonce: 'abc123',
  title: 'people.csv',
};

describe('buildCsvShell', () => {
  const html = buildCsvShell(OPTS);

  it('loads the bundle from the given script URI', () => {
    expect(html).toContain(`<script nonce="${OPTS.nonce}" src="${OPTS.scriptUri}"></script>`);
  });

  it('has exactly one script tag', () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });

  it('loads the stylesheet from the given style URI', () => {
    expect(html).toContain(`<link rel="stylesheet" href="${OPTS.styleUri}">`);
  });

  it('gives React somewhere to mount', () => {
    expect(html).toContain('<div id="root"></div>');
  });

  it('escapes the title', () => {
    const out = buildCsvShell({ ...OPTS, title: '<b>x</b> & "y"' });
    expect(out).toContain('<title>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</title>');
  });

  describe('the content security policy', () => {
    const csp = /content="([^"]+)"/.exec(html.split('Content-Security-Policy')[1])![1];

    it('refuses everything by default', () => {
      expect(csp).toContain(`default-src 'none'`);
    });

    // The grid renders a file that may have come off someone else's server.
    // No source in this policy can reach a network host.
    it('names no external host anywhere', () => {
      expect(csp).not.toMatch(/https?:\/\/(?!file\+\.vscode-resource)/);
      expect(csp).not.toMatch(/\bhttps?:(\s|;|$)/);
    });

    it('admits scripts only by nonce', () => {
      expect(csp).toContain(`script-src 'nonce-${OPTS.nonce}'`);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    });

    // Inline styles carry the virtual-scroll offsets and the column widths.
    it('admits the extension stylesheet and inline styles', () => {
      expect(csp).toContain(`style-src ${OPTS.cspSource} 'unsafe-inline'`);
    });

    it('has no img, font or connect source at all', () => {
      expect(csp).not.toContain('img-src');
      expect(csp).not.toContain('font-src');
      expect(csp).not.toContain('connect-src');
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/csv/__tests__/shell-test.ts`
Expected: FAIL — `Cannot find module '../shell'`.

- [ ] **Step 3: Write `src/modules/csv/shell.ts`**

```ts
// The CSV grid's webview page, as a pure function of the URIs it needs. Kept
// apart from editor.ts so it can be unit-tested without the vscode module,
// and so the same HTML can be written to disk and driven in headless Chrome.
//
// Everything the page does lives in the bundle Vite builds; this file only
// has to load it under a policy that lets it run and nothing else.

export interface CsvShellOptions {
  // Webview URI of media/csv/csv.js.
  scriptUri: string;
  // Webview URI of media/csv/csv.css.
  styleUri: string;
  // webview.cspSource, so the CSP admits the extension's own stylesheet.
  cspSource: string;
  // Per-panel nonce for the one script tag.
  nonce: string;
  // Document name, shown as the page title.
  title: string;
}

function escapeText(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCsvShell(opts: CsvShellOptions): string {
  // script-src is the nonce alone: a nonce authorises an external src too, so
  // the bundle loads without the policy naming any host. style-src needs
  // 'unsafe-inline' because virtual-scroll offsets and column widths are
  // inline style attributes, and there is no nonce for those. No img-src,
  // font-src or connect-src at all -- the grid loads nothing and fetches
  // nothing, and default-src 'none' refuses all three.
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${opts.nonce}'`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
  ].join('; ');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(opts.title)}</title>
<link rel="stylesheet" href="${opts.styleUri}">
</head>
<body>
<div id="root"></div>
<script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the shell test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/shell-test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Write the failing editorLogic test**

Create `src/modules/csv/__tests__/editorLogic-test.ts`:

```ts
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest src/modules/csv/__tests__/editorLogic-test.ts`
Expected: FAIL — `Cannot find module '../editorLogic'`.

- [ ] **Step 7: Write `src/modules/csv/editorLogic.ts`**

```ts
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
```

- [ ] **Step 8: Run the editorLogic test to verify it passes**

Run: `npx jest src/modules/csv/__tests__/editorLogic-test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 9: Run the whole suite and the typecheck**

Run: `npx jest src/modules/csv && npm run compile`
Expected: both green.

- [ ] **Step 10: Commit**

```bash
git add src/modules/csv/shell.ts src/modules/csv/editorLogic.ts src/modules/csv/__tests__/shell-test.ts src/modules/csv/__tests__/editorLogic-test.ts
git commit -m "feat: add the CSV webview shell and the editor's pure decisions" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 6: The editor provider, the command, and the VS Code contributions

**Files:**
- Create: `src/modules/csv/editor.ts`
- Create: `src/modules/editorTarget.ts` (moved from `src/modules/markdown/target.ts`)
- Delete: `src/modules/markdown/target.ts`
- Create: `src/commands/commandCsvOpenAsText.ts`
- Modify: `src/constants.ts` (one new line after `COMMAND_MARKDOWN_TO_PDF`)
- Modify: `src/commands/commandMarkdownOpenAsText.ts`, `src/commands/commandMarkdownToPdf.ts` (import path + call site)
- Modify: `src/extension.ts` (import + one `context.subscriptions.push`, ABOVE the `if (!workspaceFolders) return;`)
- Modify: `package.json` (`customEditors`, `activationEvents`, `commands`, three menus)
- Modify: `.vscodeignore`, `.gitignore`

**Interfaces:**
- Consumes: `detectFormat` (T2), `parseCsv` (T1), `serializeCsv` (T3), `applyOp`/`tableRows` (T4), `buildCsvShell` + all of `editorLogic` (T5), `REMOTE_SCHEME` from `src/constants.ts`.
- Produces:
  - `const CSV_EDITOR_ID = 'sftp.csvEditor'`
  - `class CsvEditorProvider implements vscode.CustomTextEditorProvider` with `static register(context: vscode.ExtensionContext): vscode.Disposable`
  - `function activeDocumentUri(arg: unknown): vscode.Uri | undefined` from `src/modules/editorTarget.ts`
  - `const COMMAND_CSV_OPEN_AS_TEXT = 'sftp.csv.openAsText'`

**Notes:**
- There is no unit test for `editor.ts`: it is `vscode` wiring end to end, and jest here has no VS Code host. Its testable parts were extracted in Task 5. The gates are `npm run compile` and the Task 10 smoke checklist.
- **One op in flight at a time** is enforced on the webview side (Task 7). The spec does not say how two ops issued between a keystroke and an ack are sequenced, and `base` is only meaningful if they are serialized — so the webview queues. The host stays exactly as the spec describes it.
- The provider does **not** set `enableFindWidget`. The spec gives `Ctrl/Cmd+F` to the grid's own search box, and VS Code's webview find widget would steal it.

- [ ] **Step 1: Move `target.ts` to `editorTarget.ts`**

```bash
git mv src/modules/markdown/target.ts src/modules/editorTarget.ts
```

Then rename the exported function and generalise the two comments that say "Markdown". Replace the whole file with:

```ts
import * as vscode from 'vscode';

// Resolve the file a command should act on from however it was invoked: a URI
// from the explorer or tab context menu, a custom editor's own toolbar (which
// passes its document URI), or nothing at all from the command palette -- in
// which case the active editor's document is the only sensible target.
//
// Shared by the Markdown commands and the CSV command: every one of them has
// the same three ways in.
export function activeDocumentUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const active = vscode.window.activeTextEditor;
  if (active) {
    return active.document.uri;
  }
  // A custom editor is not a TextEditor, so when a viewer or the grid is the
  // active tab there is no activeTextEditor. The tab API names the active
  // tab's input, and for a custom editor that input carries the URI.
  //
  // `window.tabGroups` arrived in VS Code 1.67, which is why package.json's
  // engine is `^1.67.0` and not lower: this is the only path that can find
  // the document when a custom editor is the active tab and a command arrives
  // with no argument (the command palette). An earlier draft claimed the API
  // was present on any host that could run the extension while the engine
  // still said 1.64 -- on 1.64-1.66 the palette command would have silently
  // answered "Open a Markdown file first" with the file open in front of the
  // user. The engine floor is the fix, not a runtime guard.
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  return input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
    ? input.uri
    : undefined;
}
```

- [ ] **Step 2: Point the two Markdown commands at the new home**

In `src/commands/commandMarkdownOpenAsText.ts` and `src/commands/commandMarkdownToPdf.ts`, change the import line

```ts
import { markdownTargetUri } from '../modules/markdown/target';
```

to

```ts
import { activeDocumentUri } from '../modules/editorTarget';
```

and in each file change the one call site `const uri = markdownTargetUri(arg);` to `const uri = activeDocumentUri(arg);`. Leave everything else, including the "Open a Markdown file first." messages, untouched.

- [ ] **Step 3: Verify the move compiles and breaks nothing**

Run: `npm run compile && npx jest src/modules/markdown`
Expected: compile green (a leftover reference to `markdownTargetUri` would fail here), Markdown tests green.

- [ ] **Step 4: Commit the move on its own**

```bash
git add -A src/modules/markdown/target.ts src/modules/editorTarget.ts src/commands/commandMarkdownOpenAsText.ts src/commands/commandMarkdownToPdf.ts
git commit -m "refactor: give the command target resolver one home outside markdown" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

- [ ] **Step 5: Add the command id to `src/constants.ts`**

Insert one line directly after `export const COMMAND_MARKDOWN_TO_PDF = 'sftp.markdown.toPdf';`:

```ts
export const COMMAND_CSV_OPEN_AS_TEXT = 'sftp.csv.openAsText';
```

- [ ] **Step 6: Create `src/commands/commandCsvOpenAsText.ts`**

No registration step: `src/initCommands.ts` finds every `src/commands/command*.ts` through `require.context`.

```ts
import * as vscode from 'vscode';
import { COMMAND_CSV_OPEN_AS_TEXT } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { activeDocumentUri } from '../modules/editorTarget';


export default checkCommand({
  id: COMMAND_CSV_OPEN_AS_TEXT,

  async handleCommand(arg?: unknown) {
    const uri = activeDocumentUri(arg);
    if (!uri) {
      vscode.window.showInformationMessage('Open a CSV file first.');
      return;
    }
    // `default` is VS Code's own identifier for the built-in text editor.
    // Same thing "Reopen Editor With... > Text Editor" does; the command
    // exists so it can sit in a menu under a plain name rather than behind a
    // picker.
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  },
});
```

- [ ] **Step 7: Create `src/modules/csv/editor.ts`**

```ts
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND_CSV_OPEN_AS_TEXT, REMOTE_SCHEME } from '../../constants';
import logger from '../../logger';
import { detectFormat } from './format';
import { parseCsv } from './parse';
import { serializeCsv } from './serialize';
import { applyOp, tableRows } from './model';
import { CsvOp, HostMessage, WebviewMessage } from './protocol';
import { CsvTable } from './types';
import {
  MAX_GRID_BYTES,
  isEcho,
  isStaleOp,
  isTooLarge,
  readOnlyReasonFor,
} from './editorLogic';
import { buildCsvShell } from './shell';

// The viewType in package.json's `customEditors` contribution. Referenced by
// the `activeCustomEditorId` when-clauses on the tab menus, so a change here
// must be mirrored there.
export const CSV_EDITOR_ID = 'sftp.csvEditor';

// What the provider keeps for one open document. Shared by every panel
// showing that document, and dropped when the last one closes.
interface DocumentModel {
  table: CsvTable;
  // The exact text of the host's last WorkspaceEdit, so the document-change
  // event it causes can be told apart from a real outside change.
  lastWritten: string | null;
  panels: number;
}

// The grid editor for *.csv and *.tsv, registered as their DEFAULT editor.
//
// CustomTEXTEditorProvider, not CustomEditorProvider: the file goes through
// VS Code's normal TextDocument, and every grid change becomes a
// WorkspaceEdit on it. That is what buys the dirty dot, Ctrl+S, one undo step
// per operation, "Reopen Editor With...", upload-on-save, encoding and BOM
// handling, and a side-by-side text editor that stays in sync -- none of
// which this file has to implement.
//
// The document is the truth; the webview is a view of it. Every operation is
// applied to the model here and written to the document, and the webview is
// told the new version. When the two disagree the webview is replaced, never
// the document.
export class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      CSV_EDITOR_ID,
      new CsvEditorProvider(context.extensionUri),
      {
        webviewOptions: {
          // Keep the grid, the scroll position, the selection and the search
          // when the tab is hidden. Rebuilding a 50,000-row grid on every tab
          // switch would be the single most annoying thing this editor could do.
          retainContextWhenHidden: true,
          // enableFindWidget is deliberately NOT set: Ctrl/Cmd+F belongs to
          // the grid's own search box, which filters rows rather than
          // searching the handful of rows that happen to be in the DOM.
        },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  private readonly models = new Map<string, DocumentModel>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    const assetRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'csv');
    panel.webview.options = {
      enableScripts: true,
      // Only the grid bundle. NOT the document's own directory: the rows
      // arrive by message, so the webview has no reason to be able to load
      // anything from wherever the file happened to live.
      localResourceRoots: [assetRoot],
    };

    const key = document.uri.toString();
    const model = this.acquire(key, document);
    const readOnlyReason = readOnlyReasonFor(document.uri.scheme, REMOTE_SCHEME);
    const nonce = crypto.randomBytes(16).toString('hex');

    panel.webview.html = buildCsvShell({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'csv.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'csv.css')).toString(),
      cspSource: panel.webview.cspSource,
      nonce,
      title: path.basename(document.uri.path),
    });

    const send = (message: HostMessage) => {
      panel.webview.postMessage(message);
    };

    const sendTable = () => {
      if (isTooLarge(document.getText().length)) {
        send({ type: 'tooLarge', bytes: document.getText().length, limit: MAX_GRID_BYTES });
        return;
      }
      send({
        type: 'table',
        revision: document.version,
        rows: tableRows(model.table),
        delimiter: model.table.format.delimiter,
        eol: model.table.format.eol,
        readOnly: readOnlyReason !== undefined,
        readOnlyReason,
      });
    };

    const reparse = () => {
      const text = document.getText();
      model.table = parseCsv(text, detectFormat(text, path.basename(document.uri.path)));
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== key) {
        return;
      }
      const text = event.document.getText();
      if (isEcho(text, model.lastWritten)) {
        // Our own edit coming back. One WorkspaceEdit produces exactly one of
        // these, so the mark is cleared: a later change that happens to
        // produce the same text -- a redo, say -- is a real change the grid
        // must be told about.
        model.lastWritten = null;
        return;
      }
      // Undo, redo, a side-by-side text editor, a download from the remote.
      reparse();
      sendTable();
    });

    const messageSub = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      try {
        if (!message || typeof message.type !== 'string') {
          return;
        }
        if (message.type === 'ready') {
          // Re-parse rather than trusting the model: a webview is recreated
          // on some theme and settings changes and sends `ready` again, and
          // the document may have moved on in between.
          reparse();
          sendTable();
          return;
        }
        if (message.type === 'openAsText') {
          vscode.commands.executeCommand(COMMAND_CSV_OPEN_AS_TEXT, document.uri);
          return;
        }
        if (message.type === 'op') {
          this.applyFromWebview(document, model, message.base, message.op, send, sendTable, readOnlyReason);
        }
      } catch (error) {
        logger.error(error as Error, 'csv editor message');
        send({ type: 'error', message: (error as Error).message });
        sendTable();
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
      this.release(key);
    });
  }

  private acquire(key: string, document: vscode.TextDocument): DocumentModel {
    const existing = this.models.get(key);
    if (existing) {
      existing.panels += 1;
      return existing;
    }
    const text = document.getText();
    const model: DocumentModel = {
      table: parseCsv(text, detectFormat(text, path.basename(document.uri.path))),
      lastWritten: null,
      panels: 1,
    };
    this.models.set(key, model);
    return model;
  }

  private release(key: string): void {
    const model = this.models.get(key);
    if (!model) {
      return;
    }
    model.panels -= 1;
    if (model.panels <= 0) {
      this.models.delete(key);
    }
  }

  private async applyFromWebview(
    document: vscode.TextDocument,
    model: DocumentModel,
    base: number,
    op: CsvOp,
    send: (message: HostMessage) => void,
    sendTable: () => void,
    readOnlyReason: string | undefined
  ): Promise<void> {
    if (readOnlyReason !== undefined) {
      send({ type: 'error', message: readOnlyReason });
      sendTable();
      return;
    }
    if (isStaleOp(base, document.version)) {
      // Something else changed the file between the keystroke and this
      // message. Drop the op and show the document as it actually is; saying
      // nothing is right, because the resync itself is the explanation.
      sendTable();
      return;
    }

    const next = applyOp(model.table, op);
    const text = serializeCsv(next);
    if (text === document.getText()) {
      // A no-op edit. Skipping the WorkspaceEdit avoids an undo step that
      // does nothing, and avoids arming lastWritten for a change event that
      // may never arrive.
      model.table = next;
      send({ type: 'ack', revision: document.version });
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      text
    );
    // Armed BEFORE applyEdit: the change event fires during it.
    model.lastWritten = text;
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      model.lastWritten = null;
      send({ type: 'error', message: 'This file could not be changed.' });
      sendTable();
      return;
    }
    model.table = next;
    send({ type: 'ack', revision: document.version });
  }
}
```

Two things to check as you type it in: `message.op` is narrowed to `CsvOp` only inside the `message.type === 'op'` branch, and `WebviewMessage` must stay imported (it types the `onDidReceiveMessage` callback) or `noUnusedLocals` will fail the build on the import instead.

- [ ] **Step 8: Register the provider in `src/extension.ts`**

Add the import beside the other two viewers:

```ts
import { CsvEditorProvider } from './modules/csv/editor';
```

and, directly after the `PdfViewerProvider.register(...)` push and **before** `const workspaceFolders = getWorkspaceFolders();`, add:

```ts
  // Same placement, same reason as the two viewers above: a .csv file needs
  // no sftp.json, so registering after the workspace-folder return would make
  // the grid silently absent in every workspace without a profile while
  // package.json still claimed the viewType.
  context.subscriptions.push(CsvEditorProvider.register(context));
```

- [ ] **Step 9: Add the `package.json` contributions**

Append to `contributes.customEditors` (after the `sftp.markdownViewer` entry):

```json
{
  "viewType": "sftp.csvEditor",
  "displayName": "CSV Editor",
  "selector": [
    { "filenamePattern": "*.csv" },
    { "filenamePattern": "*.tsv" }
  ],
  "priority": "default"
}
```

Add to `activationEvents`, after `"onCustomEditor:sftp.markdownViewer"`:

```json
"onCustomEditor:sftp.csvEditor",
"onCommand:sftp.csv.openAsText",
```

Append to `contributes.commands`, after the `sftp.markdown.toPdf` entry:

```json
{
  "command": "sftp.csv.openAsText",
  "title": "Open as Text",
  "category": "CSV",
  "icon": "$(code)"
}
```

Append to `contributes.menus["editor/title"]`:

```json
{
  "command": "sftp.csv.openAsText",
  "group": "navigation@3",
  "when": "activeCustomEditorId == sftp.csvEditor"
}
```

Append to `contributes.menus["editor/title/context"]`:

```json
{
  "command": "sftp.csv.openAsText",
  "group": "1_open@3",
  "when": "activeCustomEditorId == sftp.csvEditor"
}
```

Append to `contributes.menus["explorer/context"]`:

```json
{
  "command": "sftp.csv.openAsText",
  "group": "navigation@12",
  "when": "resourceExtname == .csv || resourceExtname == .tsv"
}
```

- [ ] **Step 10: Add the build output to both ignore files**

In `.vscodeignore`, add one line at the end, beside the other two media allowlist lines:

```
!media/csv/**/*
```

In `.gitignore`, add at the end, under the PDF.js line:

```
# CSV grid bundle built from webui/csv by vite
media/csv/
```

- [ ] **Step 11: Verify the JSON is still valid and the extension compiles**

Run: `node -e "const p=require('./package.json'); console.log(p.contributes.customEditors.length, p.activationEvents.length, p.contributes.commands.filter(c=>c.command.indexOf('sftp.csv')===0).length)" && npm run compile && npm test`
Expected: prints `3 8 1`; compile green; jest green except the one known baseline failure.

- [ ] **Step 12: Commit**

```bash
git add src/modules/csv/editor.ts src/commands/commandCsvOpenAsText.ts src/constants.ts src/extension.ts package.json .vscodeignore .gitignore
git commit -m "feat: open csv and tsv files in a grid editor backed by the text document" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 7: The Vite build and the webview's pure modules

**Files:**
- Create: `webui/csv/vite.config.ts`
- Create: `webui/csv/vscode.ts`
- Create: `webui/csv/search.ts`
- Create: `webui/csv/sortState.ts`
- Create: `webui/csv/tableState.ts`
- Create: `webui/csv/main.tsx`
- Create: `webui/csv/App.tsx` (a placeholder that only posts `ready`; Tasks 8–9 grow it)
- Create: `webui/csv/styles.css` (base only; Tasks 8–9 add to it)
- Test: `webui/csv/__tests__/search-test.ts`
- Test: `webui/csv/__tests__/sortState-test.ts`
- Test: `webui/csv/__tests__/tableState-test.ts`
- Modify: `package.json` (`scripts.build:csv`, `scripts.watch:csv`, `scripts.vscode:prepublish`)

**Interfaces:**
- Consumes: `CsvOp`, `SortDirection` from `../../src/modules/csv/protocol`; `applyOp` from `../../src/modules/csv/model`; `CsvFormat`, `CsvTable` from `../../src/modules/csv/types`.
- Produces:
  - `webui/csv/vscode.ts`: `function post(message: WebviewMessage): void`
  - `webui/csv/search.ts`: `interface MatchRange { start: number; end: number }`, `function matchCell(value: string, query: string, matchCase: boolean): boolean`, `function highlightRanges(value: string, query: string, matchCase: boolean): MatchRange[]`, `function filterRows(rows: string[][], query: string, matchCase: boolean, col: number | null, skipFirstRow: boolean): number[]`
  - `webui/csv/sortState.ts`: `interface SortState { col: number; direction: SortDirection }`, `function nextSortState(current: SortState | null, col: number): SortState | null`
  - `webui/csv/tableState.ts`: `function rowsWidth(rows: string[][]): number`, `function applyOpToRows(rows: string[][], op: CsvOp): string[][]`
  - `media/csv/csv.js` and `media/csv/csv.css`, built by `npm run build:csv`

**Notes:**
- `tableState.ts` does **not** reimplement the operations. It wraps `string[][]` in a throwaway `CsvTable` and runs the host's own `applyOp`, then reads the cells back. That is the only way to be certain the optimistic view lands on exactly the rows the host will produce — a second implementation would drift.
- `vscode.ts` calls `acquireVsCodeApi()` at module load (it may only be called once per page), so it is the one webui module that is **not** importable from a test. Nothing in `search.ts`, `sortState.ts` or `tableState.ts` may import it.
- The Vite build is a *library* build so the output is one plain IIFE with React inlined — a webview cannot load ES modules from an extension URI reliably, and there is no HTML entry: `shell.ts` writes the page.

- [ ] **Step 1: Write the failing tests**

Create `webui/csv/__tests__/search-test.ts`:

```ts
import { filterRows, highlightRanges, matchCell } from '../search';

describe('matchCell', () => {
  it('matches a substring case-insensitively by default', () => {
    expect(matchCell('Banana', 'nan', false)).toBe(true);
    expect(matchCell('BANANA', 'nan', false)).toBe(true);
  });
  it('respects case when asked', () => {
    expect(matchCell('BANANA', 'nan', true)).toBe(false);
    expect(matchCell('banana', 'nan', true)).toBe(true);
  });
  it('never matches an empty query', () => {
    expect(matchCell('anything', '', false)).toBe(false);
  });
  it('does not match an empty cell', () => {
    expect(matchCell('', 'a', false)).toBe(false);
  });
});

describe('highlightRanges', () => {
  it('finds one match', () => {
    expect(highlightRanges('banana', 'nan', false)).toEqual([{ start: 2, end: 5 }]);
  });
  it('finds every non-overlapping match', () => {
    expect(highlightRanges('aXaXa', 'a', false)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });
  it('finds matches in the other case when matchCase is off', () => {
    expect(highlightRanges('Cat cat', 'cat', false)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });
  it('finds nothing for an empty query', () => {
    expect(highlightRanges('banana', '', false)).toEqual([]);
  });
  it('finds nothing when there is no match', () => {
    expect(highlightRanges('banana', 'zz', false)).toEqual([]);
  });
});

describe('filterRows', () => {
  const ROWS = [
    ['name', 'city'],
    ['Ada', 'London'],
    ['Bob', 'Lyon'],
    ['Cy', 'Berlin'],
  ];

  it('returns every data row for an empty query', () => {
    expect(filterRows(ROWS, '', false, null, true)).toEqual([1, 2, 3]);
  });

  // With the header toggle on, row 0 is drawn as the header and is never a
  // search result.
  it('never returns row 0 when the first row is a header', () => {
    expect(filterRows(ROWS, 'name', false, null, true)).toEqual([]);
  });

  it('returns row 0 like any other row when the header toggle is off', () => {
    expect(filterRows(ROWS, 'name', false, null, false)).toEqual([0]);
  });

  it('returns rows with a match in any column', () => {
    expect(filterRows(ROWS, 'L', false, null, true)).toEqual([1, 2]);
  });

  it('scopes to one column when asked', () => {
    expect(filterRows(ROWS, 'Ly', false, 1, true)).toEqual([2]);
  });

  it('finds nothing in a column no row is that wide for', () => {
    expect(filterRows(ROWS, 'a', false, 9, true)).toEqual([]);
  });

  it('respects case', () => {
    expect(filterRows(ROWS, 'ADA', true, null, true)).toEqual([]);
    expect(filterRows(ROWS, 'Ada', true, null, true)).toEqual([1]);
  });

  it('returns document indices, not display positions', () => {
    expect(filterRows(ROWS, 'Berlin', false, null, true)).toEqual([3]);
  });
});
```

Create `webui/csv/__tests__/sortState-test.ts`:

```ts
import { nextSortState } from '../sortState';

describe('nextSortState', () => {
  it('starts a fresh column ascending', () => {
    expect(nextSortState(null, 2)).toEqual({ col: 2, direction: 'asc' });
  });
  it('goes ascending then descending on the same column', () => {
    expect(nextSortState({ col: 2, direction: 'asc' }, 2)).toEqual({ col: 2, direction: 'desc' });
  });
  // The third click clears the INDICATOR only. The file is already sorted, and
  // un-sorting it would need an order nobody recorded.
  it('clears on the third click', () => {
    expect(nextSortState({ col: 2, direction: 'desc' }, 2)).toBeNull();
  });
  it('starts over when a different column is clicked', () => {
    expect(nextSortState({ col: 2, direction: 'desc' }, 5)).toEqual({ col: 5, direction: 'asc' });
  });
});
```

Create `webui/csv/__tests__/tableState-test.ts`:

```ts
import { applyOpToRows, rowsWidth } from '../tableState';

describe('rowsWidth', () => {
  it('is the widest row', () => {
    expect(rowsWidth([['a'], ['a', 'b', 'c'], ['a', 'b']])).toBe(3);
  });
  it('is 0 with no rows', () => {
    expect(rowsWidth([])).toBe(0);
  });
});

// These mirror model-test one for one. The optimistic view has to land on
// exactly what the host will send back, or the grid flickers on every ack.
describe('applyOpToRows', () => {
  it('sets a cell', () => {
    expect(applyOpToRows([['a', 'b']], { type: 'setCell', row: 0, col: 1, value: 'z' })).toEqual([
      ['a', 'z'],
    ]);
  });

  it('pads a row when the column is beyond its end', () => {
    expect(applyOpToRows([['a']], { type: 'setCell', row: 0, col: 3, value: 'z' })).toEqual([
      ['a', '', '', 'z'],
    ]);
  });

  it('inserts blank rows of the table width', () => {
    expect(applyOpToRows([['a', 'b'], ['c', 'd']], { type: 'insertRows', at: 1, count: 2 })).toEqual([
      ['a', 'b'], ['', ''], ['', ''], ['c', 'd'],
    ]);
  });

  it('gives an empty table one cell to start from', () => {
    expect(applyOpToRows([], { type: 'insertRows', at: 0, count: 1 })).toEqual([['']]);
  });

  it('puts each duplicate directly after its original', () => {
    expect(applyOpToRows([['a'], ['b'], ['c']], { type: 'duplicateRows', rows: [0, 2] })).toEqual([
      ['a'], ['a'], ['b'], ['c'], ['c'],
    ]);
  });

  it('deletes rows', () => {
    expect(applyOpToRows([['a'], ['b'], ['c']], { type: 'deleteRows', rows: [0, 2] })).toEqual([['b']]);
  });

  it('inserts a column, padding short rows to the index first', () => {
    expect(applyOpToRows([['a', 'b', 'c'], ['x']], { type: 'insertColumn', at: 2 })).toEqual([
      ['a', 'b', '', 'c'],
      ['x', '', ''],
    ]);
  });

  it('deletes a column only from the rows that have it', () => {
    expect(applyOpToRows([['a', 'b', 'c'], ['x']], { type: 'deleteColumn', col: 2 })).toEqual([
      ['a', 'b'],
      ['x'],
    ]);
  });

  it('sorts, leaving the header where it is', () => {
    const rows = [['n'], ['10'], ['9'], ['100']];
    expect(applyOpToRows(rows, { type: 'sort', col: 0, direction: 'asc', hasHeader: true })).toEqual([
      ['n'], ['9'], ['10'], ['100'],
    ]);
  });

  it('sorts descending with empties still at the bottom', () => {
    const rows = [['k'], ['b'], [''], ['a']];
    expect(applyOpToRows(rows, { type: 'sort', col: 0, direction: 'desc', hasHeader: true })).toEqual([
      ['k'], ['b'], ['a'], [''],
    ]);
  });

  it('replaces in every data cell, leaving the header alone', () => {
    const rows = [['cat'], ['a cat'], ['no']];
    expect(
      applyOpToRows(rows, {
        type: 'replaceAll',
        find: 'cat',
        replace: 'fox',
        matchCase: true,
        hasHeader: true,
      })
    ).toEqual([['cat'], ['a fox'], ['no']]);
  });

  it('replaces within one column scope', () => {
    const rows = [['h1', 'h2'], ['cat', 'cat']];
    expect(
      applyOpToRows(rows, {
        type: 'replaceAll',
        find: 'cat',
        replace: 'fox',
        col: 1,
        matchCase: true,
        hasHeader: true,
      })
    ).toEqual([['h1', 'h2'], ['cat', 'fox']]);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [['a']];
    applyOpToRows(rows, { type: 'setCell', row: 0, col: 0, value: 'z' });
    expect(rows).toEqual([['a']]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest webui/csv`
Expected: FAIL — three suites, `Cannot find module '../search'`, `'../sortState'`, `'../tableState'`.

- [ ] **Step 3: Write `webui/csv/search.ts`**

```ts
// Pure search logic, kept out of the components so jest can reach it. The
// grid's search FILTERS rows rather than scrolling between hits, which is why
// this file returns row indices rather than a cursor.

export interface MatchRange {
  start: number;
  end: number;
}

function fold(value: string, matchCase: boolean): string {
  return matchCase ? value : value.toLowerCase();
}

export function matchCell(value: string, query: string, matchCase: boolean): boolean {
  if (query === '') {
    return false;
  }
  return fold(value, matchCase).indexOf(fold(query, matchCase)) !== -1;
}

export function highlightRanges(value: string, query: string, matchCase: boolean): MatchRange[] {
  const out: MatchRange[] = [];
  if (query === '') {
    return out;
  }
  const haystack = fold(value, matchCase);
  const needle = fold(query, matchCase);
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) {
      return out;
    }
    out.push({ start: at, end: at + needle.length });
    i = at + needle.length;
  }
}

// Document row indices of the rows to show. An empty query shows everything,
// so the caller can use one code path whether or not a search is running.
// `skipFirstRow` is the header toggle: with it on, row 0 is drawn as the
// header and is never a result.
export function filterRows(
  rows: string[][],
  query: string,
  matchCase: boolean,
  col: number | null,
  skipFirstRow: boolean
): number[] {
  const out: number[] = [];
  for (let r = skipFirstRow ? 1 : 0; r < rows.length; r += 1) {
    if (query === '') {
      out.push(r);
      continue;
    }
    const row = rows[r];
    if (col !== null) {
      if (col < row.length && matchCell(row[col], query, matchCase)) {
        out.push(r);
      }
      continue;
    }
    for (let c = 0; c < row.length; c += 1) {
      if (matchCell(row[c], query, matchCase)) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Write `webui/csv/sortState.ts`**

```ts
import { SortDirection } from '../../src/modules/csv/protocol';

export interface SortState {
  col: number;
  direction: SortDirection;
}

// Click a header: ascending, descending, then clear. Clearing removes the
// indicator only -- the rows are already in that order in the file, and
// putting them back would need an original order nobody recorded.
export function nextSortState(current: SortState | null, col: number): SortState | null {
  if (current === null || current.col !== col) {
    return { col, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { col, direction: 'desc' };
  }
  return null;
}
```

- [ ] **Step 5: Write `webui/csv/tableState.ts`**

```ts
import { applyOp } from '../../src/modules/csv/model';
import { CsvOp } from '../../src/modules/csv/protocol';
import { CsvFormat, CsvTable } from '../../src/modules/csv/types';

// The optimistic view must land on EXACTLY the rows the host will send back,
// so it runs the host's own operations rather than a second implementation of
// them. Quoting and raw text do not exist in a view of the data, so a
// throwaway format stands in for them and is thrown away again.
const VIEW_FORMAT: CsvFormat = {
  delimiter: ',',
  eol: '\n',
  finalNewline: true,
  quoteAll: false,
};

export function rowsWidth(rows: string[][]): number {
  let width = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].length > width) {
      width = rows[i].length;
    }
  }
  return width;
}

export function applyOpToRows(rows: string[][], op: CsvOp): string[][] {
  const table: CsvTable = {
    rows: rows.map(cells => ({
      cells: cells.slice(),
      quoted: cells.map(() => false),
      raw: null,
    })),
    format: VIEW_FORMAT,
  };
  return applyOp(table, op).rows.map(row => row.cells.slice());
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest webui/csv`
Expected: PASS — three suites, 36 tests.

- [ ] **Step 7: Write `webui/csv/vscode.ts`**

```ts
import { WebviewMessage } from '../../src/modules/csv/protocol';

// Provided by the VS Code webview host. Declared rather than imported: there
// is no module for it, and this bundle has no @types/vscode-webview.
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// May only be called once per page, so it happens here, at module load. That
// makes this the one module under webui/csv that a test must never import.
const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}
```

- [ ] **Step 8: Write `webui/csv/styles.css` (base)**

```css
/* VS Code CSS variables only, so the grid follows the user's theme without
   knowing anything about it. Every var has a fallback for the headless-Chrome
   check in Task 10, where no VS Code theme is present. */
:root {
  --csv-row-height: 24px;
  --csv-gutter: 56px;
  --csv-bg: var(--vscode-editor-background, #1e1e1e);
  --csv-fg: var(--vscode-editor-foreground, #ccc);
  --csv-muted: var(--vscode-descriptionForeground, #999);
  --csv-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  --csv-input-bg: var(--vscode-input-background, #3c3c3c);
  --csv-input-fg: var(--vscode-input-foreground, #ccc);
  --csv-btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
  --csv-btn-fg: var(--vscode-button-secondaryForeground, #ccc);
  --csv-btn-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
  --csv-primary-bg: var(--vscode-button-background, #0e639c);
  --csv-primary-fg: var(--vscode-button-foreground, #fff);
  --csv-focus: var(--vscode-focusBorder, #007fd4);
  --csv-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.13));
  --csv-active: var(--vscode-list-activeSelectionBackground, #094771);
  --csv-active-fg: var(--vscode-list-activeSelectionForeground, #fff);
  --csv-match: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  --csv-error: var(--vscode-errorForeground, #f48771);
}

html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--csv-bg);
  color: var(--csv-fg);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
}

#root {
  height: 100%;
}

.csv-app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.csv-screen {
  padding: 32px;
  max-width: 560px;
  margin: 0 auto;
  text-align: center;
}

.csv-screen h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 8px;
}

.csv-screen p {
  color: var(--csv-muted);
  margin: 0 0 16px;
}

.csv-button {
  background: var(--csv-btn-bg);
  color: var(--csv-btn-fg);
  border: 1px solid transparent;
  border-radius: 3px;
  height: 24px;
  padding: 0 10px;
  cursor: pointer;
  font: inherit;
}

.csv-button:hover:not(:disabled) {
  background: var(--csv-btn-hover);
}

.csv-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.csv-button.csv-primary {
  background: var(--csv-primary-bg);
  color: var(--csv-primary-fg);
}
```

- [ ] **Step 9: Write `webui/csv/App.tsx` (placeholder) and `webui/csv/main.tsx`**

`App.tsx` — replaced wholesale in Task 8; it exists now so the bundle builds:

```tsx
import * as React from 'react';
import { useEffect } from 'react';
import { post } from './vscode';

export default function App() {
  useEffect(() => {
    post({ type: 'ready' });
  }, []);
  return <div className="csv-screen">Loading…</div>;
}
```

`main.tsx`:

```tsx
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
```

- [ ] **Step 10: Write `webui/csv/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A LIBRARY build, unlike webui/vite.config.ts next door: there is no HTML
// entry here (src/modules/csv/shell.ts writes the page) and the output has to
// be one plain script the webview can load from an extension URI with a
// nonce. `iife` with React bundled in is the shape that satisfies both.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // Vite only substitutes this for an app build. React reads it on every
  // render, and without it the bundle throws on `process is not defined`.
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: '../../media/csv',
    emptyOutDir: true,
    // One stylesheet, named, so shell.ts can point a <link> at it.
    cssCodeSplit: false,
    lib: {
      entry: 'main.tsx',
      formats: ['iife'],
      name: 'SftpCsvGrid',
      fileName: () => 'csv.js',
    },
    rollupOptions: {
      output: { assetFileNames: 'csv.[ext]' },
    },
  },
});
```

- [ ] **Step 11: Add the build scripts to `package.json`**

In `scripts`, add these two after `"watch:webui"`:

```json
"build:csv": "vite build --config webui/csv/vite.config.ts",
"watch:csv": "vite build --config webui/csv/vite.config.ts --watch",
```

and change `vscode:prepublish` to:

```json
"vscode:prepublish": "npm run build:pdfjs && npm run build:webui && npm run build:csv && npm run compile",
```

- [ ] **Step 12: Build the bundle**

Run: `npm run build:csv && ls -la media/csv`
Expected: `media/csv/csv.js` and `media/csv/csv.css` both exist. `csv.js` is a few hundred KB (React is inlined) and starts with `(function(`.

Run: `grep -c "process.env.NODE_ENV" media/csv/csv.js || true`
Expected: `0` — the define replaced every one of them.

- [ ] **Step 13: Run the whole suite and the typecheck**

Run: `npm test && npm run compile`
Expected: jest green except the one known baseline failure; compile green.

- [ ] **Step 14: Commit**

```bash
git add webui/csv package.json
git commit -m "feat: build the CSV grid webview bundle with vite in library mode" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 8: The grid, the toolbar, and the real App

**Files:**
- Create: `webui/csv/useVirtualRows.ts`
- Create: `webui/csv/Grid.tsx`
- Create: `webui/csv/Toolbar.tsx`
- Modify: `webui/csv/App.tsx` (replace the placeholder wholesale)
- Modify: `webui/csv/styles.css` (append the grid and toolbar rules)
- Test: `webui/csv/__tests__/useVirtualRows-test.ts`

**Interfaces:**
- Consumes: `post` (T7), `filterRows`/`highlightRanges` (T7), `nextSortState`/`SortState` (T7), `applyOpToRows`/`rowsWidth` (T7), `CsvOp`/`HostMessage`/`delimiterLabel`/`eolLabel` (T4), `Delimiter`/`Eol` (T1), `fmtBytes` from `webui/src/format.ts`.
- Produces:
  - `webui/csv/useVirtualRows.ts`: `const ROW_HEIGHT = 24`, `interface VirtualWindow { start: number; end: number; padTop: number }`, `function virtualWindow(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, buffer: number): VirtualWindow`, `function useVirtualRows(ref, total): VirtualWindow`
  - `webui/csv/Grid.tsx`: `interface CellRef { row: number; col: number }`, default-exported `Grid` component with the `GridProps` below
  - `webui/csv/Toolbar.tsx`: default-exported `Toolbar` component taking `children`, so Task 9 can slot the search UI in without touching this file

**Notes:**
- Deviation from the brief's grouping, stated up front: the read-only banner, the `tooLarge` screen and the error toasts land here rather than in Task 9, because `Grid` needs `onError` and `App` needs a screen to render before the search UI exists. Task 9 is then purely additive: two new components and the menu state.
- One op in flight at a time (`pendingRef` + `inFlightRef`). The spec does not say how ops issued between a keystroke and its `ack` are sequenced, and `base` only means anything if they are serialized — otherwise the second of two fast edits is always rejected as stale and silently dropped. Queueing keeps the host exactly as specified.
- `useVirtualRows.ts` imports React, unlike the other `.ts` modules under `webui/csv/`. Its test imports only `virtualWindow`; React resolves under jest because it is an installed CommonJS package. If that ever stops being true, move `virtualWindow` and `ROW_HEIGHT` into a `webui/csv/virtual.ts` with no React import and re-point the test.

- [ ] **Step 1: Write the failing virtualisation test**

Create `webui/csv/__tests__/useVirtualRows-test.ts`:

```ts
import { ROW_HEIGHT, virtualWindow } from '../useVirtualRows';

describe('ROW_HEIGHT', () => {
  it('matches the --csv-row-height in styles.css', () => {
    expect(ROW_HEIGHT).toBe(24);
  });
});

describe('virtualWindow', () => {
  it('renders from the top with a buffer of nothing above it', () => {
    const view = virtualWindow(0, 240, 24, 1000, 5);
    expect(view.start).toBe(0);
    expect(view.padTop).toBe(0);
    expect(view.end).toBeGreaterThanOrEqual(10);
  });

  it('starts a buffer above the first visible row', () => {
    // 480px down is row 20; five rows of buffer means starting at 15.
    expect(virtualWindow(480, 240, 24, 1000, 5).start).toBe(15);
  });

  it('offsets the rendered block by exactly the skipped rows', () => {
    expect(virtualWindow(480, 240, 24, 1000, 5).padTop).toBe(15 * 24);
  });

  it('renders the viewport plus a buffer on both sides', () => {
    const view = virtualWindow(480, 240, 24, 1000, 5);
    // 10 rows visible + 5 above + 5 below + 1 partial row.
    expect(view.end - view.start).toBe(21);
  });

  it('never runs past the last row', () => {
    const view = virtualWindow(100000, 240, 24, 30, 5);
    expect(view.end).toBe(30);
    expect(view.start).toBeLessThanOrEqual(30);
  });

  it('renders nothing for an empty table', () => {
    expect(virtualWindow(0, 240, 24, 0, 5)).toEqual({ start: 0, end: 0, padTop: 0 });
  });

  it('survives a viewport that has not been measured yet', () => {
    expect(virtualWindow(0, 0, 24, 100, 5).end).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest webui/csv/__tests__/useVirtualRows-test.ts`
Expected: FAIL — `Cannot find module '../useVirtualRows'`.

- [ ] **Step 3: Write `webui/csv/useVirtualRows.ts`**

```ts
import { useEffect, useState } from 'react';

// Only the rows in view (plus a buffer) are in the DOM. The scroll container
// still gets the full height, so the scrollbar tells the truth about a
// 200,000-row file.
export const ROW_HEIGHT = 24;
const BUFFER_ROWS = 8;

export interface VirtualWindow {
  // First row index to render.
  start: number;
  // One past the last row index to render.
  end: number;
  // Pixels the rendered block is pushed down by.
  padTop: number;
}

export function virtualWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  buffer: number
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0 };
  }
  // Clamped to the last row: an over-scrolled container must not offset the
  // rendered block past the end of the list.
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight) - buffer),
    Math.max(0, total - 1)
  );
  // +1 for the row the viewport is only showing half of.
  const count = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + buffer * 2 + 1;
  return { start, end: Math.min(total, start + count), padTop: start * rowHeight };
}

export function useVirtualRows(
  ref: { current: HTMLElement | null },
  total: number
): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  // A sane guess until the element is measured; virtualWindow tolerates a
  // zero height, it just renders the buffer.
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setHeight(el.clientHeight);
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
    };
  }, [ref]);

  return virtualWindow(scrollTop, height, ROW_HEIGHT, total, BUFFER_ROWS);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest webui/csv/__tests__/useVirtualRows-test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write `webui/csv/Grid.tsx`**

```tsx
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightRanges } from './search';
import { SortState } from './sortState';
import { ROW_HEIGHT, useVirtualRows } from './useVirtualRows';

const GUTTER_WIDTH = 56;
const MIN_COL_WIDTH = 60;
const MAX_AUTO_COL_WIDTH = 320;
const CHAR_WIDTH = 7;
const CELL_PADDING = 16;
// Widths are guessed from the top of the file rather than all of it: scanning
// 200,000 rows to pick a column width would cost more than it is worth, and
// the user can drag any column that guesses wrong.
const AUTO_WIDTH_SAMPLE = 200;

export interface CellRef {
  row: number;
  col: number;
}

export interface GridProps {
  rows: string[][];
  width: number;
  // Document row indices to show, in display order. Search filters this list;
  // it never renumbers anything.
  visibleRows: number[];
  hasHeader: boolean;
  headers: string[];
  readOnly: boolean;
  sort: SortState | null;
  query: string;
  matchCase: boolean;
  selectedRows: number[];
  // Set by the header menu's Rename, cleared as soon as the grid has acted.
  editRequest: CellRef | null;
  onEditRequestHandled(): void;
  onSelectRows(rows: number[]): void;
  onSetCell(row: number, col: number, value: string): void;
  onHeaderClick(col: number): void;
  onRowMenu(row: number, x: number, y: number): void;
  onHeaderMenu(col: number, x: number, y: number): void;
  onError(message: string): void;
}

function cellValue(rows: string[][], row: number, col: number): string {
  const cells = rows[row];
  return cells && cells[col] !== undefined ? cells[col] : '';
}

function autoWidths(rows: string[][], headers: string[], width: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < width; c += 1) {
    let longest = headers[c] ? headers[c].length : 1;
    for (let r = 0; r < rows.length && r < AUTO_WIDTH_SAMPLE; r += 1) {
      const cell = rows[r][c];
      if (cell !== undefined && cell.length > longest) {
        longest = cell.length;
      }
    }
    out.push(
      Math.max(MIN_COL_WIDTH, Math.min(MAX_AUTO_COL_WIDTH, longest * CHAR_WIDTH + CELL_PADDING))
    );
  }
  return out;
}

function CellText(props: { value: string; query: string; matchCase: boolean }) {
  const ranges = highlightRanges(props.value, props.query, props.matchCase);
  if (ranges.length === 0) {
    return <>{props.value}</>;
  }
  const parts: any[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) {
      parts.push(props.value.slice(at, range.start));
    }
    parts.push(
      <mark className="csv-match" key={index}>
        {props.value.slice(range.start, range.end)}
      </mark>
    );
    at = range.end;
  });
  if (at < props.value.length) {
    parts.push(props.value.slice(at));
  }
  return <>{parts}</>;
}

export default function Grid(props: GridProps) {
  const { rows, width, visibleRows, headers, readOnly, sort, query, matchCase, selectedRows } = props;

  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [overrides, setOverrides] = useState<{ [col: number]: number }>({});

  const view = useVirtualRows(scrollRef, visibleRows.length);

  const widths = useMemo(() => {
    const auto = autoWidths(rows, headers, width);
    return auto.map((value, index) => (overrides[index] !== undefined ? overrides[index] : value));
  }, [rows, headers, width, overrides]);

  const totalWidth = widths.reduce((sum, value) => sum + value, GUTTER_WIDTH);

  const focusGrid = () => {
    if (gridRef.current) {
      gridRef.current.focus();
    }
  };

  const scrollRowIntoView = (position: number) => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const top = position * ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  };

  const moveTo = (position: number, col: number) => {
    if (visibleRows.length === 0 || width === 0) {
      return;
    }
    const p = Math.min(Math.max(0, position), visibleRows.length - 1);
    const c = Math.min(Math.max(0, col), width - 1);
    setSelected({ row: visibleRows[p], col: c });
    scrollRowIntoView(p);
  };

  const startEdit = (row: number, col: number, replace: boolean, seed?: string) => {
    if (readOnly) {
      return;
    }
    setSelected({ row, col });
    setEditing({
      row,
      col,
      value: replace ? (seed !== undefined ? seed : '') : cellValue(rows, row, col),
    });
  };

  const commitEditing = (
    current: { row: number; col: number; value: string },
    move: 'down' | 'left' | 'right' | 'none'
  ) => {
    setEditing(null);
    // A commit with an unchanged value sends nothing: an accidental Enter
    // should not put a row in the diff.
    if (current.value !== cellValue(rows, current.row, current.col)) {
      props.onSetCell(current.row, current.col, current.value);
    }
    const position = visibleRows.indexOf(current.row);
    if (move === 'down') {
      moveTo(position + 1, current.col);
    } else if (move === 'right') {
      moveTo(position, current.col + 1);
    } else if (move === 'left') {
      moveTo(position, current.col - 1);
    } else {
      moveTo(position, current.col);
    }
    focusGrid();
  };

  const copyCell = () => {
    if (!selected) {
      return;
    }
    const clipboard = (navigator as any).clipboard;
    if (!clipboard || !clipboard.writeText) {
      props.onError('The clipboard is not available here.');
      return;
    }
    clipboard
      .writeText(cellValue(rows, selected.row, selected.col))
      .catch(() => props.onError('Could not copy to the clipboard.'));
  };

  const pasteCell = () => {
    if (!selected || readOnly) {
      return;
    }
    const clipboard = (navigator as any).clipboard;
    if (!clipboard || !clipboard.readText) {
      props.onError('The clipboard is not available here.');
      return;
    }
    const target = selected;
    clipboard
      .readText()
      // One cell in, one cell out. Multi-cell paste is out of scope for
      // 1.32.0, and quietly rewriting the rows around the selection would be
      // the worst possible way to find that out.
      .then((text: string) => props.onSetCell(target.row, target.col, text))
      .catch(() => props.onError('Could not read the clipboard.'));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing || !selected) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const position = visibleRows.indexOf(selected.row);
    const key = event.key;

    if (key === 'ArrowDown') {
      event.preventDefault();
      moveTo(position + 1, selected.col);
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      moveTo(position - 1, selected.col);
      return;
    }
    if (key === 'ArrowRight') {
      event.preventDefault();
      moveTo(position, selected.col + 1);
      return;
    }
    if (key === 'ArrowLeft') {
      event.preventDefault();
      moveTo(position, selected.col - 1);
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      moveTo(mod ? 0 : position, 0);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      moveTo(mod ? visibleRows.length - 1 : position, width - 1);
      return;
    }
    if (mod && (key === 'c' || key === 'C')) {
      event.preventDefault();
      copyCell();
      return;
    }
    if (mod && (key === 'v' || key === 'V')) {
      event.preventDefault();
      pasteCell();
      return;
    }
    // Everything else with a modifier belongs to VS Code -- above all
    // Ctrl/Cmd+Z, which has to reach the custom text editor to undo.
    if (mod || readOnly) {
      return;
    }
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault();
      startEdit(selected.row, selected.col, false);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      props.onSetCell(selected.row, selected.col, '');
      return;
    }
    // A printable character starts an edit and REPLACES the value, the way a
    // spreadsheet does.
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      startEdit(selected.row, selected.col, true, key);
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditing(null);
      focusGrid();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEditing(editing, 'down');
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      commitEditing(editing, event.shiftKey ? 'left' : 'right');
    }
  };

  const onGutterMouseDown = (event: React.MouseEvent, row: number) => {
    if (event.shiftKey && selectedRows.length > 0) {
      const anchor = selectedRows[selectedRows.length - 1];
      const from = Math.min(anchor, row);
      const to = Math.max(anchor, row);
      const range: number[] = [];
      for (let r = from; r <= to; r += 1) {
        if (visibleRows.indexOf(r) !== -1) {
          range.push(r);
        }
      }
      props.onSelectRows(range);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      props.onSelectRows(
        selectedRows.indexOf(row) === -1
          ? selectedRows.concat([row])
          : selectedRows.filter(r => r !== row)
      );
      return;
    }
    props.onSelectRows([row]);
  };

  const beginResize = (event: React.MouseEvent, col: number, startWidth: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const onMove = (move: MouseEvent) => {
      setOverrides(current => {
        const next: { [col: number]: number } = { ...current };
        next[col] = Math.max(MIN_COL_WIDTH, startWidth + (move.clientX - startX));
        return next;
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (props.editRequest) {
      startEdit(props.editRequest.row, props.editRequest.col, false);
      props.onEditRequestHandled();
    }
  }, [props.editRequest]);

  if (width === 0) {
    return (
      <div className="csv-grid csv-grid-empty">
        <p className="csv-hint">This file is empty. Use <strong>Add Row</strong> to start it.</p>
      </div>
    );
  }

  return (
    <div className="csv-grid" ref={gridRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="csv-scroll" ref={scrollRef}>
        <div className="csv-table" style={{ width: totalWidth }}>
          <div className="csv-head" style={{ height: ROW_HEIGHT }}>
            <div className="csv-gutter csv-gutter-head" style={{ width: GUTTER_WIDTH }} />
            {widths.map((w, col) => (
              <div
                className="csv-header-cell"
                key={col}
                style={{ width: w }}
                onClick={() => props.onHeaderClick(col)}
                onContextMenu={event => {
                  event.preventDefault();
                  props.onHeaderMenu(col, event.clientX, event.clientY);
                }}
              >
                <span className="csv-header-label">{headers[col]}</span>
                {sort && sort.col === col ? (
                  <span className="csv-sort">{sort.direction === 'asc' ? '▲' : '▼'}</span>
                ) : null}
                <span
                  className="csv-resize"
                  onMouseDown={event => beginResize(event, col, w)}
                  onClick={event => event.stopPropagation()}
                />
              </div>
            ))}
          </div>

          <div className="csv-body" style={{ height: visibleRows.length * ROW_HEIGHT }}>
            <div
              className="csv-window"
              style={{ transform: `translateY(${view.padTop}px)` }}
            >
              {visibleRows.slice(view.start, view.end).map(row => (
                <div
                  className={
                    'csv-row' + (selectedRows.indexOf(row) !== -1 ? ' csv-row-selected' : '')
                  }
                  key={row}
                  style={{ height: ROW_HEIGHT }}
                >
                  <div
                    className="csv-gutter"
                    style={{ width: GUTTER_WIDTH }}
                    onMouseDown={event => onGutterMouseDown(event, row)}
                    onContextMenu={event => {
                      event.preventDefault();
                      if (selectedRows.indexOf(row) === -1) {
                        props.onSelectRows([row]);
                      }
                      props.onRowMenu(row, event.clientX, event.clientY);
                    }}
                  >
                    {row + 1}
                  </div>
                  {widths.map((w, col) => {
                    const isEditing = editing !== null && editing.row === row && editing.col === col;
                    const isSelected =
                      selected !== null && selected.row === row && selected.col === col;
                    return (
                      <div
                        className={'csv-cell' + (isSelected ? ' csv-cell-selected' : '')}
                        key={col}
                        style={{ width: w }}
                        onMouseDown={() => {
                          if (!isEditing) {
                            setSelected({ row, col });
                            focusGrid();
                          }
                        }}
                        onDoubleClick={() => startEdit(row, col, false)}
                      >
                        {isEditing ? (
                          <input
                            className="csv-input"
                            autoFocus
                            value={editing!.value}
                            onChange={event =>
                              setEditing({ row, col, value: event.target.value })
                            }
                            onKeyDown={onInputKeyDown}
                            onBlur={() => {
                              if (editing) {
                                commitEditing(editing, 'none');
                              }
                            }}
                          />
                        ) : (
                          <CellText
                            value={cellValue(rows, row, col)}
                            query={query}
                            matchCase={matchCase}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write `webui/csv/Toolbar.tsx`**

```tsx
import * as React from 'react';

export interface ToolbarProps {
  readOnly: boolean;
  hasHeader: boolean;
  canDeleteRows: boolean;
  canAddColumn: boolean;
  status: string;
  matchText: string;
  onAddRow(): void;
  onDeleteRows(): void;
  onAddColumn(): void;
  onToggleHeader(): void;
  onOpenAsText(): void;
  // The search and replace controls slot in here, so adding them does not
  // change this file.
  children?: any;
}

export default function Toolbar(props: ToolbarProps) {
  return (
    <div className="csv-toolbar">
      <button
        className="csv-button"
        disabled={props.readOnly}
        onClick={props.onAddRow}
        title="Insert a row after the selection, or at the end"
      >
        Add Row
      </button>
      <button
        className="csv-button"
        disabled={props.readOnly || !props.canDeleteRows}
        onClick={props.onDeleteRows}
      >
        Delete Rows
      </button>
      <button
        className="csv-button"
        disabled={props.readOnly || !props.canAddColumn}
        onClick={props.onAddColumn}
      >
        Add Column
      </button>
      <label className="csv-toggle" title="Show the first row as column headers">
        <input type="checkbox" checked={props.hasHeader} onChange={props.onToggleHeader} />
        Header row
      </label>

      {props.children}

      <span className="csv-spacer" />
      {props.matchText ? <span className="csv-match-count">{props.matchText}</span> : null}
      <span className="csv-status">{props.status}</span>
      <button className="csv-button" onClick={props.onOpenAsText} title="Open the raw text in the editor">
        Open as Text
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Replace `webui/csv/App.tsx`**

```tsx
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtBytes } from '../src/format';
import { CsvOp, HostMessage, delimiterLabel, eolLabel } from '../../src/modules/csv/protocol';
import { Delimiter, Eol } from '../../src/modules/csv/types';
import Grid, { CellRef } from './Grid';
import Toolbar from './Toolbar';
import { filterRows } from './search';
import { SortState, nextSortState } from './sortState';
import { applyOpToRows, rowsWidth } from './tableState';
import { post } from './vscode';

interface Toast {
  id: number;
  message: string;
}

export default function App() {
  const [screen, setScreen] = useState<'loading' | 'grid' | 'tooLarge'>('loading');
  const [rows, setRows] = useState<string[][]>([]);
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [eol, setEol] = useState<Eol>('\n');
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState('');
  const [tooLarge, setTooLarge] = useState({ bytes: 0, limit: 0 });
  const [hasHeader, setHasHeader] = useState(true);
  const [sort, setSort] = useState<SortState | null>(null);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [scopeCol, setScopeCol] = useState<number | null>(null);
  const [replaceText, setReplaceText] = useState('');
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [editRequest, setEditRequest] = useState<CellRef | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // The document version the next op will be based on. A ref, not state: it is
  // read when a message is posted, not when the component renders.
  const revisionRef = useRef(0);
  // One op in flight at a time. Two ops posted with the same `base` would make
  // the host reject the second as stale and silently drop the user's edit.
  const pendingRef = useRef<CsvOp[]>([]);
  const inFlightRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts(list => list.concat([{ id, message }]));
    window.setTimeout(() => setToasts(list => list.filter(toast => toast.id !== id)), 6000);
  }, []);

  const flush = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    const next = pendingRef.current.shift();
    if (!next) {
      return;
    }
    inFlightRef.current = true;
    post({ type: 'op', base: revisionRef.current, op: next });
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as HostMessage;
      if (!message || typeof message.type !== 'string') {
        return;
      }
      if (message.type === 'table') {
        // A full table always wins: the host is the document, and anything
        // queued here was made against a version that no longer exists.
        pendingRef.current = [];
        inFlightRef.current = false;
        revisionRef.current = message.revision;
        setRows(message.rows);
        setDelimiter(message.delimiter);
        setEol(message.eol);
        setReadOnly(message.readOnly);
        setReadOnlyReason(message.readOnlyReason || '');
        setSelectedRows([]);
        setScreen('grid');
        return;
      }
      if (message.type === 'ack') {
        revisionRef.current = message.revision;
        inFlightRef.current = false;
        flush();
        return;
      }
      if (message.type === 'tooLarge') {
        setTooLarge({ bytes: message.bytes, limit: message.limit });
        setScreen('tooLarge');
        return;
      }
      if (message.type === 'error') {
        pushToast(message.message);
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [flush, pushToast]);

  // Ctrl/Cmd+F belongs to the grid: the webview's find widget is off, because
  // searching the DOM would only ever find the rows that happen to be
  // rendered.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        if (searchRef.current) {
          searchRef.current.focus();
          searchRef.current.select();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const sendOp = useCallback(
    (op: CsvOp) => {
      if (readOnly) {
        return;
      }
      setRows(current => applyOpToRows(current, op));
      pendingRef.current.push(op);
      flush();
    },
    [readOnly, flush]
  );

  const width = rowsWidth(rows);

  const headers = useMemo(() => {
    const out: string[] = [];
    for (let c = 0; c < width; c += 1) {
      // Header toggle off: plain 1, 2, 3… and row 0 is an ordinary row.
      if (!hasHeader || rows.length === 0) {
        out.push(String(c + 1));
        continue;
      }
      out.push(rows[0][c] !== undefined ? rows[0][c] : '');
    }
    return out;
  }, [rows, hasHeader, width]);

  const visibleRows = useMemo(
    () => filterRows(rows, query, matchCase, scopeCol, hasHeader),
    [rows, query, matchCase, scopeCol, hasHeader]
  );

  const onHeaderClick = (col: number) => {
    const next = nextSortState(sort, col);
    setSort(next);
    // The third click clears the indicator only. The rows are already in that
    // order in the file, so there is nothing to send.
    if (next) {
      sendOp({ type: 'sort', col, direction: next.direction, hasHeader });
    }
  };

  const onAddRow = () => {
    const at = selectedRows.length > 0 ? Math.max.apply(null, selectedRows) + 1 : rows.length;
    sendOp({ type: 'insertRows', at, count: 1 });
  };

  const onReplaceAll = () => {
    if (query === '') {
      return;
    }
    sendOp({
      type: 'replaceAll',
      find: query,
      replace: replaceText,
      col: scopeCol === null ? undefined : scopeCol,
      matchCase,
      hasHeader,
    });
  };

  if (screen === 'loading') {
    return <div className="csv-screen">Loading…</div>;
  }

  if (screen === 'tooLarge') {
    return (
      <div className="csv-screen">
        <h2>This file is too large for the grid</h2>
        <p>
          {fmtBytes(tooLarge.bytes)} — the grid handles files up to {fmtBytes(tooLarge.limit)}.
        </p>
        <button className="csv-button csv-primary" onClick={() => post({ type: 'openAsText' })}>
          Open as Text
        </button>
      </div>
    );
  }

  const status = `${rows.length.toLocaleString()} rows × ${width} columns · ${delimiterLabel(
    delimiter
  )} · ${eolLabel(eol)}`;

  return (
    <div className="csv-app">
      <Toolbar
        readOnly={readOnly}
        hasHeader={hasHeader}
        canDeleteRows={selectedRows.length > 0}
        canAddColumn={rows.length > 0}
        status={status}
        matchText={query ? `${visibleRows.length} matching` : ''}
        onAddRow={onAddRow}
        onDeleteRows={() => {
          sendOp({ type: 'deleteRows', rows: selectedRows });
          setSelectedRows([]);
        }}
        onAddColumn={() => sendOp({ type: 'insertColumn', at: width })}
        onToggleHeader={() => setHasHeader(value => !value)}
        onOpenAsText={() => post({ type: 'openAsText' })}
      >
        {/* The search and replace controls are added here in Task 9. */}
      </Toolbar>

      {readOnly ? <div className="csv-banner">{readOnlyReason}</div> : null}

      <Grid
        rows={rows}
        width={width}
        visibleRows={visibleRows}
        hasHeader={hasHeader}
        headers={headers}
        readOnly={readOnly}
        sort={sort}
        query={query}
        matchCase={matchCase}
        selectedRows={selectedRows}
        editRequest={editRequest}
        onEditRequestHandled={() => setEditRequest(null)}
        onSelectRows={setSelectedRows}
        onSetCell={(row, col, value) => sendOp({ type: 'setCell', row, col, value })}
        onHeaderClick={onHeaderClick}
        onRowMenu={() => undefined}
        onHeaderMenu={() => undefined}
        onError={pushToast}
      />

      <div className="csv-toasts">
        {toasts.map(toast => (
          <div className="csv-toast" key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Two state values are declared but not yet read by any control: `setQuery`, `setMatchCase`, `setScopeCol`, `setReplaceText`, `onReplaceAll` and `searchRef` are wired to the search UI in Task 9. They are here now because `visibleRows`, the match count and the Ctrl+F handler already depend on them, and nothing under `webui/` is typechecked, so an unused setter is not a build error.

- [ ] **Step 8: Append the grid and toolbar rules to `webui/csv/styles.css`**

```css
/* ---- toolbar ---------------------------------------------------------- */
.csv-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid var(--csv-border);
  background: var(--csv-bg);
}

.csv-toolbar .csv-spacer {
  flex: 1;
}

.csv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--csv-muted);
  user-select: none;
}

.csv-status,
.csv-match-count {
  color: var(--csv-muted);
  white-space: nowrap;
}

.csv-banner {
  flex: 0 0 auto;
  padding: 6px 10px;
  color: var(--csv-muted);
  border-bottom: 1px solid var(--csv-border);
  background: var(--csv-hover);
}

/* ---- grid ------------------------------------------------------------- */
.csv-grid {
  flex: 1 1 auto;
  min-height: 0;
  outline: none;
}

.csv-grid:focus-visible {
  outline: 1px solid var(--csv-focus);
  outline-offset: -1px;
}

.csv-grid-empty {
  padding: 24px;
}

.csv-hint {
  color: var(--csv-muted);
}

.csv-scroll {
  height: 100%;
  overflow: auto;
}

.csv-table {
  position: relative;
}

.csv-head {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--csv-bg);
  border-bottom: 1px solid var(--csv-border);
}

.csv-header-cell {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 0 8px;
  font-weight: 600;
  cursor: pointer;
  border-right: 1px solid var(--csv-border);
  box-sizing: border-box;
  overflow: hidden;
}

.csv-header-cell:hover {
  background: var(--csv-hover);
}

.csv-header-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-sort {
  color: var(--csv-muted);
  font-size: 9px;
}

.csv-resize {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
}

.csv-body {
  position: relative;
}

.csv-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.csv-row {
  display: flex;
  box-sizing: border-box;
}

.csv-row:hover {
  background: var(--csv-hover);
}

.csv-row-selected {
  background: var(--csv-active);
  color: var(--csv-active-fg);
}

.csv-gutter {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px;
  box-sizing: border-box;
  color: var(--csv-muted);
  border-right: 1px solid var(--csv-border);
  cursor: pointer;
  user-select: none;
  position: sticky;
  left: 0;
  background: var(--csv-bg);
  z-index: 1;
}

.csv-gutter-head {
  z-index: 3;
}

.csv-cell {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 0 8px;
  box-sizing: border-box;
  border-right: 1px solid var(--csv-border);
  border-bottom: 1px solid var(--csv-border);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.csv-cell-selected {
  outline: 2px solid var(--csv-focus);
  outline-offset: -2px;
}

.csv-input {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  padding: 0;
  font: inherit;
  color: var(--csv-input-fg);
  background: var(--csv-input-bg);
}

.csv-match {
  background: var(--csv-match);
  color: inherit;
}

/* ---- toasts ----------------------------------------------------------- */
.csv-toasts {
  position: fixed;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 10;
}

.csv-toast {
  max-width: 360px;
  padding: 6px 10px;
  border: 1px solid var(--csv-border);
  border-left: 3px solid var(--csv-error);
  border-radius: 3px;
  background: var(--csv-bg);
}
```

- [ ] **Step 9: Build and check the bundle**

Run: `npm run build:csv && ls -la media/csv && grep -c "csv-toolbar" media/csv/csv.css`
Expected: both files present, `grep` prints `1`.

- [ ] **Step 10: Run the whole suite and the typecheck**

Run: `npm test && npm run compile`
Expected: jest green except the one known baseline failure; compile green.

- [ ] **Step 11: Commit**

```bash
git add webui/csv
git commit -m "feat: draw the CSV grid with virtual rows, in-place editing and a toolbar" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 9: Find & Replace, the context menus, and renaming a header

**Files:**
- Create: `webui/csv/FindReplace.tsx`
- Create: `webui/csv/ContextMenu.tsx`
- Modify: `webui/csv/App.tsx` (imports, menu state, two menu builders, two JSX slots)
- Modify: `webui/csv/Grid.tsx` (the header cell becomes an input while row 0 is being renamed)
- Modify: `webui/csv/styles.css` (append the find and menu rules)

**Interfaces:**
- Consumes: everything from Tasks 7–8.
- Produces:
  - `webui/csv/ContextMenu.tsx`: `interface MenuItem { label: string; run(): void }`, `interface ContextMenuProps { x: number; y: number; items: MenuItem[]; onClose(): void }`, default-exported `ContextMenu`
  - `webui/csv/FindReplace.tsx`: default-exported `FindReplace` with the props listed in Step 1

- [ ] **Step 1: Write `webui/csv/FindReplace.tsx`**

```tsx
import * as React from 'react';

export interface FindReplaceProps {
  query: string;
  onQuery(value: string): void;
  matchCase: boolean;
  onMatchCase(value: boolean): void;
  // null means every column.
  scopeCol: number | null;
  onScopeCol(value: number | null): void;
  headers: string[];
  replaceText: string;
  onReplaceText(value: string): void;
  onReplaceAll(): void;
  readOnly: boolean;
  inputRef: { current: HTMLInputElement | null };
}

export default function FindReplace(props: FindReplaceProps) {
  return (
    <span className="csv-find">
      <input
        ref={props.inputRef}
        className="csv-text"
        type="search"
        placeholder="Search (Ctrl F)"
        value={props.query}
        onChange={event => props.onQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onQuery('');
          }
        }}
      />
      <select
        className="csv-select"
        title="Which column to search"
        value={props.scopeCol === null ? 'all' : String(props.scopeCol)}
        onChange={event =>
          props.onScopeCol(event.target.value === 'all' ? null : Number(event.target.value))
        }
      >
        <option value="all">All columns</option>
        {props.headers.map((label, index) => (
          <option key={index} value={String(index)}>
            {label === '' ? String(index + 1) : label}
          </option>
        ))}
      </select>
      <button
        className={'csv-button csv-case' + (props.matchCase ? ' csv-on' : '')}
        title="Match case"
        onClick={() => props.onMatchCase(!props.matchCase)}
      >
        Aa
      </button>
      <input
        className="csv-text"
        type="text"
        placeholder="Replace"
        value={props.replaceText}
        disabled={props.readOnly}
        onChange={event => props.onReplaceText(event.target.value)}
      />
      {/* No confirmation: the match count is already on screen and undo is one
          keystroke. */}
      <button
        className="csv-button"
        disabled={props.readOnly || props.query === ''}
        title="Replace every match in scope, as one undoable change"
        onClick={props.onReplaceAll}
      >
        Replace All
      </button>
    </span>
  );
}
```

- [ ] **Step 2: Write `webui/csv/ContextMenu.tsx`**

```tsx
import * as React from 'react';
import { useEffect } from 'react';

export interface MenuItem {
  label: string;
  run(): void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export default function ContextMenu(props: ContextMenuProps) {
  useEffect(() => {
    // The right-click's own mousedown has already happened by the time this
    // listener is attached, so the menu does not close itself on open.
    const close = () => props.onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        props.onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [props.onClose]);

  return (
    <div
      className="csv-menu"
      style={{ left: props.x, top: props.y }}
      onMouseDown={event => event.stopPropagation()}
    >
      {props.items.map((item, index) => (
        <button
          className="csv-menu-item"
          key={index}
          onClick={() => {
            item.run();
            props.onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Let the header cell be renamed in place, in `webui/csv/Grid.tsx`**

Replace this line inside the header-cell JSX:

```tsx
                <span className="csv-header-label">{headers[col]}</span>
```

with:

```tsx
                {props.hasHeader && editing !== null && editing.row === 0 && editing.col === col ? (
                  // Rename edits row 0 itself, which with the header toggle on
                  // is drawn here rather than in the body.
                  <input
                    className="csv-input"
                    autoFocus
                    value={editing.value}
                    onChange={event => setEditing({ row: 0, col, value: event.target.value })}
                    onKeyDown={onInputKeyDown}
                    onBlur={() => {
                      if (editing) {
                        commitEditing(editing, 'none');
                      }
                    }}
                    onMouseDown={event => event.stopPropagation()}
                    onClick={event => event.stopPropagation()}
                  />
                ) : (
                  <span className="csv-header-label">{headers[col]}</span>
                )}
```

- [ ] **Step 4: Wire both components into `webui/csv/App.tsx`**

Add two imports beside the existing ones:

```tsx
import ContextMenu, { MenuItem } from './ContextMenu';
import FindReplace from './FindReplace';
```

Add one piece of state, directly after the `toasts` state:

```tsx
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
```

Add the two menu builders, directly after `onReplaceAll`:

```tsx
  const openRowMenu = (row: number, x: number, y: number) => {
    if (readOnly) {
      return;
    }
    // Act on the whole selection when the clicked row is part of it, and on
    // the clicked row alone when it is not.
    const targets = selectedRows.indexOf(row) !== -1 ? selectedRows : [row];
    setMenu({
      x,
      y,
      items: [
        { label: 'Insert Above', run: () => sendOp({ type: 'insertRows', at: row, count: 1 }) },
        { label: 'Insert Below', run: () => sendOp({ type: 'insertRows', at: row + 1, count: 1 }) },
        { label: 'Duplicate', run: () => sendOp({ type: 'duplicateRows', rows: targets }) },
        {
          label: 'Delete',
          run: () => {
            sendOp({ type: 'deleteRows', rows: targets });
            setSelectedRows([]);
          },
        },
      ],
    });
  };

  const openHeaderMenu = (col: number, x: number, y: number) => {
    if (readOnly) {
      return;
    }
    const items: MenuItem[] = [];
    // Rename edits the header CELL. With the toggle off there is no header
    // cell to edit -- the column is called "3" -- so the item is not offered.
    if (hasHeader && rows.length > 0) {
      items.push({ label: 'Rename', run: () => setEditRequest({ row: 0, col }) });
    }
    items.push({ label: 'Insert Left', run: () => sendOp({ type: 'insertColumn', at: col }) });
    items.push({ label: 'Insert Right', run: () => sendOp({ type: 'insertColumn', at: col + 1 }) });
    items.push({ label: 'Delete', run: () => sendOp({ type: 'deleteColumn', col }) });
    setMenu({ x, y, items });
  };
```

Replace the placeholder line inside `<Toolbar>`:

```tsx
        {/* The search and replace controls are added here in Task 9. */}
```

with:

```tsx
        <FindReplace
          query={query}
          onQuery={setQuery}
          matchCase={matchCase}
          onMatchCase={setMatchCase}
          scopeCol={scopeCol}
          onScopeCol={setScopeCol}
          headers={headers}
          replaceText={replaceText}
          onReplaceText={setReplaceText}
          onReplaceAll={onReplaceAll}
          readOnly={readOnly}
          inputRef={searchRef}
        />
```

Replace the two stub handlers on `<Grid>`:

```tsx
        onRowMenu={() => undefined}
        onHeaderMenu={() => undefined}
```

with:

```tsx
        onRowMenu={openRowMenu}
        onHeaderMenu={openHeaderMenu}
```

And render the menu, directly before the `<div className="csv-toasts">` block:

```tsx
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}
```

- [ ] **Step 5: Append the find and menu rules to `webui/csv/styles.css`**

```css
/* ---- find & replace --------------------------------------------------- */
.csv-find {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.csv-text,
.csv-select {
  background: var(--csv-input-bg);
  color: var(--csv-input-fg);
  border: 1px solid var(--csv-border);
  border-radius: 3px;
  height: 22px;
  padding: 0 6px;
  font: inherit;
  box-sizing: border-box;
}

.csv-text {
  width: 150px;
}

.csv-text:focus,
.csv-select:focus {
  outline: 1px solid var(--csv-focus);
  outline-offset: -1px;
}

.csv-select {
  max-width: 150px;
}

.csv-case {
  min-width: 28px;
  padding: 0 6px;
}

.csv-case.csv-on {
  background: var(--csv-primary-bg);
  color: var(--csv-primary-fg);
}

/* ---- context menu ----------------------------------------------------- */
.csv-menu {
  position: fixed;
  z-index: 20;
  min-width: 150px;
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  border: 1px solid var(--csv-border);
  border-radius: 4px;
  background: var(--vscode-menu-background, var(--csv-bg));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.csv-menu-item {
  background: none;
  border: none;
  color: var(--vscode-menu-foreground, var(--csv-fg));
  text-align: left;
  padding: 4px 12px;
  font: inherit;
  cursor: pointer;
}

.csv-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--csv-active));
  color: var(--vscode-menu-selectionForeground, var(--csv-active-fg));
}
```

- [ ] **Step 6: Build and check the bundle**

Run: `npm run build:csv && grep -c "csv-menu-item" media/csv/csv.css && grep -c "Replace All" media/csv/csv.js`
Expected: both `grep` commands print `1`.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npm test && npm run compile`
Expected: jest green except the one known baseline failure; compile green.

- [ ] **Step 8: Commit**

```bash
git add webui/csv
git commit -m "feat: add find and replace, row and column menus to the CSV grid" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

### Task 10: Verification, docs, and the 1.32.0 release

**Files:**
- Create: `scripts/verify-csv-grid.js`
- Modify: `README.md` (a `## CSV editor` section right after `## PDF viewer`)
- Modify: `CHANGELOG.md` (a `## 1.32.0 - 2026-09-02` entry at the top)
- Modify: `package.json` (`version` → `1.32.0`)

**Interfaces:**
- Consumes: the built `media/csv/csv.js` and `media/csv/csv.css` from Task 7, and every behaviour from Tasks 8–9.
- Produces: nothing other code depends on.

**Notes:**
- The page is served over HTTP by a few lines of Node rather than `python3 -m http.server`: `ws` is already a dependency, the server is torn down in the same `finally` as everything else, and there is no second process to reap on a machine with no `timeout` command. `file://` would not do — a page loaded from `file://` cannot be scripted the same way and `location.origin` is `null`.
- The stub `acquireVsCodeApi` records every `postMessage` on `window.__posted`, which is what the assertions read.

- [ ] **Step 1: Write `scripts/verify-csv-grid.js`**

```js
'use strict';

// Drives the built CSV grid bundle in headless Chrome over the DevTools
// protocol. A webview cannot be driven from a test, but the Chromium it runs
// on can -- the same technique the PDF viewer was verified with.
//
// Run: npm run build:csv && node scripts/verify-csv-grid.js
// Exit code 0 and a screenshot in the temp directory mean the grid renders,
// edits, searches and replaces, and sends the ops the host expects.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media', 'csv');
const HTTP_PORT = 8731;
const CDP_PORT = 9333;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="csv.css"></head>
<body><div id="root"></div>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) { window.__posted.push(message); },
      getState: function () { return undefined; },
      setState: function () {}
    };
  };
</script>
<script src="csv.js"></script>
</body></html>`;

const TABLE = {
  type: 'table',
  revision: 1,
  rows: [
    ['name', 'city', 'note'],
    ['Ada', 'London', 'first'],
    ['Bob', 'Lyon', 'second'],
    ['Cy', 'Berlin', 'third'],
  ],
  delimiter: ',',
  eol: '\n',
  readOnly: false,
};

function chromeCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

function findChrome() {
  const found = chromeCandidates().filter(candidate => fs.existsSync(candidate));
  if (found.length === 0) {
    throw new Error('No Chrome, Edge or Chromium found. Install one and run this again.');
  }
  return found[0];
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((request, response) => {
    const name = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    const file = path.join(dir, path.basename(name));
    if (!fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    response.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message.result);
      }
    });
  }
  send(method, params) {
    this.id += 1;
    const id = this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }
  async click(selector) {
    const box = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    if (!box) {
      throw new Error('no element for ' + selector);
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(box.x),
        y: Math.round(box.y),
        button: 'left',
        clickCount: 1,
      });
    }
    await wait(60);
  }
  async type(text) {
    for (const ch of text.split('')) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await wait(60);
  }
  async press(key, code, windowsVirtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    await wait(80);
  }
}

function check(label, condition, detail) {
  if (!condition) {
    throw new Error('FAILED: ' + label + (detail ? ' -- ' + detail : ''));
  }
  console.log('  ok  ' + label);
}

async function main() {
  if (!fs.existsSync(path.join(MEDIA, 'csv.js'))) {
    throw new Error('media/csv/csv.js is missing. Run `npm run build:csv` first.');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-verify-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-chrome-'));
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.copyFileSync(path.join(MEDIA, 'csv.js'), path.join(dir, 'csv.js'));
  fs.copyFileSync(path.join(MEDIA, 'csv.css'), path.join(dir, 'csv.css'));

  const server = await serve(dir);
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let socket;
  try {
    let targets = [];
    for (let attempt = 0; attempt < 50 && targets.length === 0; attempt += 1) {
      await wait(200);
      try {
        targets = (await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list')).filter(
          t => t.type === 'page'
        );
      } catch (error) {
        targets = [];
      }
    }
    if (targets.length === 0) {
      throw new Error('Chrome never opened a debuggable page.');
    }

    socket = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    const cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/index.html' });
    await wait(1500);

    console.log('the bundle loads and announces itself');
    check(
      'posts ready on load',
      (await cdp.evaluate('window.__posted.map(m => m.type).join(",")')) === 'ready'
    );

    console.log('the table renders');
    await cdp.evaluate(
      'window.postMessage(' + JSON.stringify(TABLE) + ', "*"), window.__posted.length = 0, true'
    );
    await wait(400);
    check(
      'draws three data rows',
      (await cdp.evaluate('document.querySelectorAll(".csv-row").length')) === 3
    );
    check(
      'draws the first row as headers',
      (await cdp.evaluate(
        'Array.from(document.querySelectorAll(".csv-header-label")).map(e => e.textContent).join(",")'
      )) === 'name,city,note'
    );
    check(
      'reports the size and the format',
      (await cdp.evaluate('document.querySelector(".csv-status").textContent')).indexOf(
        'Comma · LF'
      ) !== -1
    );

    console.log('editing a cell');
    await cdp.click('.csv-row:nth-child(1) .csv-cell:nth-child(2)');
    await cdp.type('Zed');
    await cdp.press('Enter', 'Enter', 13);
    const editOp = await cdp.evaluate('JSON.stringify(window.__posted[window.__posted.length - 1])');
    check(
      'sends one setCell op against the current revision',
      editOp ===
        JSON.stringify({
          type: 'op',
          base: 1,
          op: { type: 'setCell', row: 1, col: 0, value: 'Zed' },
        }),
      editOp
    );

    // The grid sends one op at a time and waits for the ack, so the host half
    // of that handshake has to be played back here or nothing else is sent.
    await cdp.evaluate('window.postMessage({ type: "ack", revision: 2 }, "*"), true');
    await wait(150);

    console.log('adding a row');
    await cdp.evaluate('window.__posted.length = 0, true');
    await cdp.click('.csv-toolbar .csv-button');
    const addOp = await cdp.evaluate('JSON.stringify(window.__posted[0])');
    check(
      'sends insertRows at the end against the acked revision',
      addOp ===
        JSON.stringify({ type: 'op', base: 2, op: { type: 'insertRows', at: 4, count: 1 } }),
      addOp
    );
    await cdp.evaluate('window.postMessage({ type: "ack", revision: 3 }, "*"), true');
    await wait(150);

    console.log('searching');
    await cdp.click('.csv-find .csv-text');
    await cdp.type('Lyon');
    await wait(300);
    check(
      'filters to the one matching row',
      (await cdp.evaluate('document.querySelectorAll(".csv-row").length')) === 1
    );
    check(
      'counts the matches',
      (await cdp.evaluate('document.querySelector(".csv-match-count").textContent')) === '1 matching'
    );
    check(
      'highlights the match',
      (await cdp.evaluate('document.querySelectorAll(".csv-match").length')) === 1
    );

    console.log('replacing');
    await cdp.evaluate('window.__posted.length = 0, true');
    await cdp.click('.csv-find .csv-text:nth-of-type(2)');
    await cdp.type('Lisbon');
    await cdp.evaluate(
      `(() => { const buttons = Array.from(document.querySelectorAll('.csv-find .csv-button'));
        buttons.filter(b => b.textContent === 'Replace All')[0].click(); return true; })()`
    );
    await wait(300);
    const replaceOp = await cdp.evaluate('JSON.stringify(window.__posted[0])');
    check(
      'sends one replaceAll op for the whole search',
      replaceOp.indexOf('"type":"replaceAll"') !== -1 &&
        replaceOp.indexOf('"base":3') !== -1 &&
        replaceOp.indexOf('"find":"Lyon"') !== -1 &&
        replaceOp.indexOf('"replace":"Lisbon"') !== -1,
      replaceOp
    );
    check(
      'sends exactly one op for Replace All, not one per cell',
      (await cdp.evaluate('window.__posted.length')) === 1
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(dir, 'csv-grid.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('\nscreenshot: ' + shotPath);
    console.log('all checks passed');
  } finally {
    if (socket) {
      socket.close();
    }
    chrome.kill('SIGKILL');
    server.close();
  }
}

main().catch(error => {
  console.error(String(error.message || error));
  process.exit(1);
});
```

- [ ] **Step 2: Run the headless check**

Run: `npm run build:csv && node scripts/verify-csv-grid.js`
Expected: every `ok` line prints, then `all checks passed` and a screenshot path. Open the screenshot and confirm by eye: a toolbar, three column headers, a row-number gutter, and readable rows.

If a check fails, the failure names the assertion and prints what the page actually sent — fix the component, rebuild, and run it again. Do not move on with a red check.

- [ ] **Step 3: Commit the verification script**

```bash
git add scripts/verify-csv-grid.js
git commit -m "test: drive the built CSV grid in headless chrome" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

- [ ] **Step 4: Run the real VS Code smoke checklist**

Press `F5` in VS Code to launch the Extension Development Host with this extension, then work through every line. Each one is pass/fail — record the result, and stop on a failure rather than continuing.

1. Copy `src/modules/csv/__tests__/__fixtures__/plain.csv` to a scratch folder and open it. **The grid opens by default**, the tab shows `plain.csv`, and the first row is the header.
2. Edit a cell and press `Enter`. **The tab shows the dirty dot.**
3. Press `Ctrl/Cmd+Z` **with focus in the grid**. The cell goes back to its old value and the grid shows it. This is the one interaction the spec flagged as needing end-to-end proof.
4. `Ctrl/Cmd+S`, then run `git diff` (or `diff` against a copy) on the file. **Exactly one line changed**, the line endings are unchanged, and there is no added or removed final newline.
5. Right-click the tab → **Reopen Editor With… → Text Editor**. The raw CSV opens. Put them side by side, type in the text editor, and watch the grid follow.
6. Click **Open as Text** on the toolbar — same result, one click.
7. Right-click `plain.csv` in the Explorer → **Open as Text** is on the menu.
8. Click a column header three times: ascending, descending, indicator cleared. After the first click the file itself is reordered — confirm with `Ctrl/Cmd+Z` that one undo puts it back.
9. `Ctrl/Cmd+F` **focuses the grid's search box** (not VS Code's find widget). Type a term: rows filter, the count appears, matches highlight. `Escape` clears it.
10. Type a replacement and click **Replace All**. One `Ctrl/Cmd+Z` undoes the whole replacement.
11. Right-click a row number: Insert Above / Insert Below / Duplicate / Delete all work. Right-click a header: Rename / Insert Left / Insert Right / Delete all work. Turn the **Header row** toggle off — **Rename is no longer offered** and row 0 becomes an ordinary row.
12. Open `tabs.tsv`, `semicolon.csv` and `crlf.csv` the same way. Each reports the right delimiter and line ending in the status text; edit one cell in each, save, and diff — **only that line changes**.
13. Open `empty.csv`. The grid says the file is empty; **Add Row** creates one cell; **Add Column** widens it.
14. With `sftp.downloadWhenOpenInRemoteExplorer` **off**, open a `.csv` from the Remote Explorer. **The read-only banner appears**, the toolbar's editing buttons are disabled, and typing in a cell does nothing. (Use a test host you already have configured — never a production host.)
15. Make a file larger than 10 MB (`node -e "require('fs').writeFileSync('/tmp/big.csv', 'a,b\n'.repeat(3000000))"`) and open it. The **too large** screen appears with the size, the limit, and a working **Open as Text** button.

**If step 3 fails** — `Ctrl/Cmd+Z` does not reach the editor — the spec names the fallback. Implement it exactly like this and re-run the checklist: add `| { type: 'undo' } | { type: 'redo' }` to `WebviewMessage` in `src/modules/csv/protocol.ts`; in `App.tsx`'s document `keydown` effect add

```tsx
      const target = event.target as HTMLElement;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT');
      if (!isInput && (event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        post({ type: event.shiftKey ? 'redo' : 'undo' });
      }
```

and in `editor.ts`'s message handler add

```ts
        if (message.type === 'undo' || message.type === 'redo') {
          vscode.commands.executeCommand(message.type);
          return;
        }
```

- [ ] **Step 5: Add the README section**

Insert directly **after** the `## PDF viewer` section (which ends with "…so a PDF cannot make it phone home.") and **before** `## Remote Explorer`:

````markdown
## CSV editor

Every `.csv` and `.tsv` file opens in a **grid** by default — sortable columns, a row-number
gutter, in-place editing, and search across the whole file rather than the part of it on screen.
The delimiter is detected when the file opens (comma, semicolon, tab or pipe; `.tsv` defaults to
tab) and the status line on the right shows what it found, along with the row and column count and
the line ending.

**Saving keeps the file the way you found it.** Same delimiter, same line endings, same quoting,
same trailing newline or lack of one — and every row you did not touch is written back
byte-for-byte, so editing one cell of a 10,000-row export is a one-line diff.

Editing: click a cell and type, or press `Enter` / `F2` to edit what is there. `Enter` commits and
moves down, `Tab` / `Shift+Tab` move across, `Escape` cancels, `Delete` clears a cell. Arrow keys,
`Home` / `End` and `Ctrl/Cmd+Home` / `Ctrl/Cmd+End` move around. `Ctrl/Cmd+C` and `Ctrl/Cmd+V` copy
and paste one cell. Right-click a row number for Insert Above / Insert Below / Duplicate / Delete,
or a column header for Rename / Insert Left / Insert Right / Delete. Drag a header edge to widen a
column.

`Ctrl/Cmd+F` focuses the grid's own search box. It filters to the rows that match — scoped to one
column if you pick one, case-sensitive if you press **Aa** — and highlights what matched.
**Replace All** replaces every match in that scope as a single change.

Clicking a header sorts the file: ascending, then descending, then the indicator clears. That
**rewrites the row order in the file**, because a CSV has no other place to keep it — it is an
ordinary edit, and `Ctrl/Cmd+Z` undoes it like any other.

Every change goes through VS Code's normal editor machinery, so the dirty dot, `Ctrl/Cmd+S`, undo
and redo, upload-on-save, and a side-by-side text editor that stays in sync all work exactly as
they do for any other file. **Open as Text** — on the toolbar, the tab's right-click menu, or the
Explorer's — opens the raw text; VS Code's own **Reopen Editor With…** works too.

**Not for you?** Put the plain text editor back as the default with one setting:

```json
"workbench.editorAssociations": { "*.csv": "default", "*.tsv": "default" }
```

The grid stays available under **Open With… → CSV Editor**.

Two limits worth knowing. A CSV opened from the **Remote Explorer** with
`sftp.downloadWhenOpenInRemoteExplorer` off is a preview with nothing to write to, so the grid
shows a read-only banner — download the file to edit it. And files over **10 MB** open as text
instead, with a button to do so, rather than putting a hundred megabytes of cells in a webview.
````

- [ ] **Step 6: Add the CHANGELOG entry**

Insert at the very top of `CHANGELOG.md`, above `## 1.31.1 - 2026-09-02`:

```markdown
## 1.32.0 - 2026-09-02
* New Feature : **CSV editor.** Every `.csv` and `.tsv` file now opens in a grid by default --
  sortable columns, a row-number gutter, in-place editing, row and column operations, and a search
  that filters the whole file rather than the rows on screen, with Replace All as one undoable
  change. The delimiter, line ending and quoting style are detected on open and preserved on save,
  and every row you did not touch is written back byte-for-byte, so a one-cell edit is a one-line
  diff. Every change goes through the normal text document, so the dirty dot, `Ctrl/Cmd+S`, undo,
  redo and upload-on-save all behave as they do for any other file. **Open as Text** (toolbar, tab
  right-click, Explorer right-click) opens the raw text. To make the text editor the default
  again: `"workbench.editorAssociations": { "*.csv": "default", "*.tsv": "default" }`. A remote
  preview opened with `downloadWhenOpenInRemoteExplorer` off is read-only, and files over 10 MB
  open as text.
```

- [ ] **Step 7: Bump the version**

In `package.json`, change `"version": "1.31.1"` to `"version": "1.32.0"`.

- [ ] **Step 8: Full gate**

Run: `npm test`
Expected: green except the one known baseline failure `transfer algorithm › sync › sync --update with time offset`.

Run: `npm run compile`
Expected: green.

Run: `npx vsce package`
Expected: `sftp-1.32.0.vsix` is written.

Run: `npx vsce ls | grep media/csv`
Expected: exactly two lines — `media/csv/csv.css` and `media/csv/csv.js`.

Run: `npx vsce ls | grep -c "src/modules/csv"`
Expected: `0` — the sources and the fixtures stay out of the package.

- [ ] **Step 9: Commit**

```bash
rm -f sftp-1.32.0.vsix
git add README.md CHANGELOG.md package.json
git commit -m "docs: describe the CSV editor and release 1.32.0" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JX38eYW7nETZBbATdy16jf"
```

---

## Self-review

Run after the last task, against the spec with fresh eyes.

### Spec coverage

| Spec section / bullet | Task |
| --- | --- |
| Goal: `.csv`/`.tsv` open in a grid by default | 6 (`customEditors`, `priority: "default"`) |
| Goal: Open as Text escape hatch | 6 (command + menus), 8 (toolbar button) |
| Goal: saving preserves delimiter, EOL, quoting; untouched rows byte-identical | 2, 3 (`raw`, round-trip corpus) |
| Decisions: `*.csv` and `*.tsv`, `.tsv` defaults to tab | 2 (`detectDelimiter` fallback), 6 (selector) |
| Decisions: cells, rows, columns, Find & Replace | 4 (ops), 8 (grid), 9 (find/replace, menus) |
| Decisions: sorting rewrites the file, undoable | 4 (`sortRows`), 8 (`onHeaderClick`), 10 (smoke step 8) |
| Decisions: header row default on with a toggle | 8 (`hasHeader`, Toolbar) |
| Architecture: CSV core, no VS Code imports, fully tested | 1–4 |
| Architecture: provider + shell | 5, 6 |
| Architecture: React grid in `webui/csv/` | 7–9 |
| Why a custom text editor | 6 (`editor.ts` doc comment + `WorkspaceEdit`) |
| Why React in a Vite lib build | 7 (`vite.config.ts` doc comment) |
| Data model `Delimiter`/`Eol`/`CsvFormat`/`CsvRow`/`CsvTable`, `width(table)` | 1 (types), 4 (`tableWidth`) |
| Format detection: delimiter scoring, EOL, finalNewline, quoteAll | 2 |
| Parsing: RFC 4180 tolerances, blank line, trailing EOL, `raw` | 1 |
| Serialization: raw rows verbatim, rebuild, join, final EOL | 3 |
| Round-trip guarantee as a fixture-corpus test | 3 |
| Quoting rule for changed cells | 2 (`needsQuote`), 4 (`setCell`, `replaceAll`) |
| Operations table, incl. which rows lose `raw` | 4 (`model-test.ts`) |
| Sort compare: numeric, localeCompare, empties last, stable, negated desc | 4 |
| Row indices are document indices; filter hides but never renumbers | 4 (notes), 7 (`filterRows`), 8 (`visibleRows`) |
| Message protocol both directions | 4 |
| Flow: ready → table/tooLarge; optimistic ops; ack; base mismatch → resync; echo suppression | 5 (`editorLogic`), 6 (`editor.ts`), 8 (`App.tsx`) |
| One model per document, discarded on last close | 6 (`acquire`/`release`) |
| `CSV_EDITOR_ID`, `retainContextWhenHidden`, `supportsMultipleEditorsPerDocument` | 6 |
| `localResourceRoots`, CSP | 5, 6 |
| Read-only on the `remote:` scheme, with the banner text | 5 (`readOnlyReasonFor`), 6, 8 (banner) |
| `MAX_GRID_BYTES` 10 MB → `tooLarge` with an Open as Text button | 5, 6, 8 |
| Full-range `WorkspaceEdit`, one per op | 6 |
| Webview file list | 7–9 |
| VS Code CSS variables only | 7–9 (`styles.css`) |
| Toolbar contents and the two status strings | 8, 9 |
| Grid: gutter, headers, virtual body, honest scrollbar | 8 |
| Status toasts, bottom-right, auto-dismiss | 8 |
| Select and move (arrows, Home/End, Ctrl+Home/End) | 8 |
| Edit (Enter/F2/printable, commit/move, Escape, blur, unchanged sends nothing) | 8 |
| Delete/Backspace clears | 8 |
| Copy/paste one cell | 8 |
| Rows: click, Shift-click, Ctrl-click, right-click menu, Add Row placement | 8, 9 |
| Columns: sort cycle, right-click menu, Rename hidden with the toggle off, auto width, drag resize | 8, 9 |
| Header toggle is view state for this tab | 8 |
| Search: filter, scope, case, highlight, row 0 rules, Ctrl+F, Escape | 7, 8, 9 |
| Replace All as one op with no confirmation | 4, 9 |
| Undo/redo not handled by the webview, verified end to end, with the spec's fallback | 8 (`if (mod ...) return`), 10 (smoke step 3 + fallback code) |
| Empty file: hint, Add Row, Add Column | 4 (`insertRows` width floor), 8 |
| `customEditors`, activation, command, menus, constants | 6 |
| `target.ts` → `src/modules/editorTarget.ts` as `activeDocumentUri` | 6 |
| Vite lib config, scripts, `.vscodeignore`, `.gitignore`, React bundled | 6, 7 |
| Error handling: parse never throws; failed edit → toast + resync; stale op → silent resync; host exceptions logged and reported | 1, 6, 8 |
| Testing: `format-test`, `parse-test`, `serialize-test`, `model-test`, `shell-test` | 1–5 |
| Testing: `search-test`, `sortState-test` | 7 |
| Testing: headless bundle check, then a real VS Code smoke test | 10 |
| `npm run compile` green | every task |
| Out of scope for 1.32.0 | nothing in this plan implements any of it; multi-cell paste is explicitly declined in `Grid.tsx` |
| Docs: README section, CHANGELOG entry, version 1.32.0 | 10 |

No spec bullet is left without a task.

### Ambiguities resolved (all recorded in the task that resolves them)

1. **Task order.** `format.ts` needs a parser for `quoteAll`, so `parse.ts` comes first.
2. **`parseCsv("\n")`** is one row with one empty cell, not zero rows. (Task 1)
3. **Delimiter scoring carries quote state across lines**, rather than resetting per line, so a file with newlines inside quoted fields is counted correctly. (Task 2)
4. **Mode ties break to the larger count.** (Task 2)
5. **`finalNewline` is "the text ends with a newline"**, which is identical to the spec's wording for any consistent file and safer for a mixed one. (Task 2)
6. **The round-trip guarantee is scoped to files with a consistent line ending**; mixed endings normalize, and Task 3 asserts that rather than hiding it.
7. **Ops are sent one at a time**, queued behind the outstanding `ack`, because `base` is only meaningful if they are serialized. (Task 8)
8. **"23 matching" counts matching rows**, since the search filters rows. (Task 8)
9. **Add Column appends** at the current width; it is disabled while the file has no rows, because the spec's empty-file flow is Add Row first. (Task 8)
10. **`replaceAll` with an empty search is a no-op** rather than an error. (Task 4)

### Placeholder scan

No "TBD", no "implement later", no "add error handling", no "similar to Task N", no test step without test code, no code step without code. Every type and function named in a later task is defined in an earlier one: `CsvFormat`/`CsvRow`/`CsvTable`/`Delimiter`/`Eol`/`DELIMITERS` (T1) → `parseCsv` (T1) → `detectFormat`/`needsQuote` (T2) → `serializeCsv` (T3) → `CsvOp`/`SortDirection`/`HostMessage`/`WebviewMessage`/`applyOp`/`tableRows`/`tableWidth` (T4) → `buildCsvShell`/`MAX_GRID_BYTES`/`isEcho`/`isStaleOp`/`isTooLarge`/`readOnlyReasonFor` (T5) → `CSV_EDITOR_ID`/`activeDocumentUri`/`COMMAND_CSV_OPEN_AS_TEXT` (T6) → `post`/`filterRows`/`highlightRanges`/`matchCell`/`nextSortState`/`SortState`/`applyOpToRows`/`rowsWidth` (T7) → `ROW_HEIGHT`/`virtualWindow`/`useVirtualRows`/`CellRef`/`Grid`/`Toolbar` (T8) → `MenuItem`/`ContextMenu`/`FindReplace` (T9).
