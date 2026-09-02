# CSV editor — design

Date: 2026-09-02. Ships as 1.32.0.

## Goal

Every `.csv` and `.tsv` file opens in a grid editor by default: readable, searchable, editable
in place, with an **Open as Text** escape hatch. Saving writes the file back in the same format it
was opened in — same delimiter, same line endings, same quoting, and untouched rows byte-identical.

## Decisions made with the user

| Question | Decision |
| --- | --- |
| File types | `*.csv` and `*.tsv`. Delimiter detected on open; `.tsv` defaults to tab. |
| Edit scope | Cells, rows, columns, and Find & Replace (Replace All). |
| Sorting | Clicking a header **rewrites the file order**. It is an ordinary, undoable edit. |
| Header row | First row shown as column headers by default, with a toolbar toggle. Off shows `1, 2, 3…`. |

## Architecture

Three parts, each with one job.

1. **CSV core** — `src/modules/csv/{format,parse,serialize,model,protocol}.ts`. Pure TypeScript,
   no VS Code imports, fully unit-tested. Detects the format, parses text into a table, applies
   edit operations, and writes the table back.
2. **Editor provider** — `src/modules/csv/editor.ts` + `shell.ts`. A `CustomTextEditorProvider`
   registered as the default editor for `*.csv` / `*.tsv`. Owns the document, runs the core on
   it, and talks to the webview by messages.
3. **Grid webview** — `webui/csv/` (React + TypeScript, built by Vite into `media/csv/csv.js`
   and `media/csv/csv.css`). Draws the table, handles selection, in-place editing, keyboard
   navigation, search/replace UI, context menus. Sends every change as an operation message and
   never touches the file.

The webview is a view. The document is the truth. All correctness-critical logic lives in the
core where jest can reach it.

### Why a custom **text** editor

The file goes through VS Code's normal `TextDocument`. Every grid change becomes a
`WorkspaceEdit` on that document. That gives, for free: the dirty dot on the tab, `Ctrl+S`,
`Ctrl+Z` / `Ctrl+Y` as single steps per operation, "Reopen Editor With…", upload-on-save, encoding
and BOM handling (VS Code strips the BOM from `getText()` and writes it back on save), and a live
side-by-side text editor that stays in sync.

### Why React in a Vite lib build, not a template-string script

The Markdown viewer's inline script works for a read-only page. An editable grid with
selection, editing overlays, keyboard navigation, virtual scrolling and find/replace would be
several hundred lines of untestable script inside a string. The repo already has Vite + React for
the Server Manager; a second Vite config in **library mode** produces one IIFE script and one
stylesheet with React bundled in, which the host loads by webview URI with a nonce — the same
loading pattern as the PDF viewer.

## Data model (core)

```ts
type Delimiter = ',' | ';' | '\t' | '|';
type Eol = '\n' | '\r\n';

interface CsvFormat {
  delimiter: Delimiter;
  eol: Eol;
  finalNewline: boolean;   // did the text end with an EOL
  quoteAll: boolean;       // does the file quote every non-empty cell
}

interface CsvRow {
  cells: string[];
  quoted: boolean[];       // per cell: was it / should it be written in quotes
  raw: string | null;      // the row's original text without EOL; null once edited
}

interface CsvTable {
  rows: CsvRow[];
  format: CsvFormat;
}
```

`width(table)` is the largest `cells.length` across rows. Ragged rows are allowed and preserved;
the grid pads them visually with empty cells.

### Format detection (`format.ts`)

- **Delimiter**: over the first 50 non-empty lines, count each candidate (`,` `;` `\t` `|`)
  outside quotes on each line. For each candidate take the most common per-line count (its
  mode); the candidate's score is the number of lines that have exactly that count, and a mode
  of 0 scores 0. Pick the highest score; tie → the higher mode; still tied → the order
  `,` `;` `\t` `|`. Every score 0: comma, or tab when the file name ends in `.tsv`.
- **EOL**: the first line ending found; `\n` if none.
- **finalNewline**: text ends with the EOL.
- **quoteAll**: every non-empty cell in the first 1000 rows is quoted (and there is at least one).

### Parsing (`parse.ts`)

RFC 4180 with the usual tolerance: quoted fields with `""` escapes; delimiters and newlines
inside quotes are literal; a quote inside an unquoted field is literal; text after a closing quote
before the next delimiter is appended to the field. A blank line is a row with one empty cell.
The trailing EOL (if any) does not produce a row. Each row records its exact original text in
`raw`.

### Serialization (`serialize.ts`)

`serialize(table)`:

- A row with `raw !== null` is written exactly as `raw`.
- Any other row is rebuilt: cells joined by the delimiter; a cell is written as
  `"` + value with `"` doubled + `"` when `quoted[i]` is true, otherwise verbatim.
- Rows joined by `format.eol`; a final EOL is appended when `format.finalNewline`.

**Round-trip guarantee**: `serialize(parse(text)) === text` for any input. This is a test over a
fixture corpus, not an aspiration.

### Quoting rule for changed cells

When a cell value is set: `quoted = format.quoteAll || needsQuote(value)`, where `needsQuote`
is true if the value contains the delimiter, `"`, `\r`, `\n`, or leading/trailing whitespace.
Cells the user did not change keep their original `quoted` flag.

### Operations (`model.ts`)

Every operation is a pure function `(table, op) => table`. It sets `raw = null` on exactly the
rows it changes.

| Operation | Effect | Rows rebuilt |
| --- | --- | --- |
| `setCell {row, col, value}` | pads the row with empty cells if `col` is beyond its end | that row |
| `insertRows {at, count}` | blank rows of `width` cells (quoted per `quoteAll`) | new rows only |
| `duplicateRows {rows}` | copies inserted directly after the originals; copies have `raw` set to the original's raw so they serialize identically | none |
| `deleteRows {rows}` | remove | none |
| `insertColumn {at}` | pads every row to `at` cells, inserts an empty cell | all |
| `deleteColumn {col}` | removes index `col` from every row that has it | all that had it |
| `sort {col, direction, hasHeader}` | stable sort of data rows; header row (row 0 when `hasHeader`) stays put; rows move with `raw` intact | none |
| `replaceAll {find, replace, col?, matchCase, hasHeader}` | plain-substring replace in every data cell that contains `find` (scoped to `col` when given); row 0 untouched when `hasHeader` | rows with a match |

Sort compare: both values numeric (`/^\s*-?\d+(\.\d+)?\s*$/`) → numeric compare; otherwise
`localeCompare` with `{ numeric: true, sensitivity: 'base' }`. **Empty cells always sort to the
bottom**, in both directions. Descending is the negated comparator under a stable sort.

Row indices in every operation are **document row indices** (row 0 is the header when the header
toggle is on). Because sorting rewrites file order, display order is always document order; the
search filter hides rows but never renumbers them.

## Message protocol (`protocol.ts`, shared by host and webview as types)

Webview → host:

```ts
{ type: 'ready' }
{ type: 'op', base: number, op: CsvOp }      // base = document version the op was made against
{ type: 'openAsText' }
```

Host → webview:

```ts
{ type: 'table', revision: number, rows: string[][], delimiter: Delimiter, eol: Eol,
  readOnly: boolean, readOnlyReason?: string }
{ type: 'ack', revision: number }          // op applied; document now at this version
{ type: 'tooLarge', bytes: number, limit: number }
{ type: 'error', message: string }
```

Flow:

- On `ready` the host parses the document and sends a full `table` (or `tooLarge`).
- The webview applies each op **optimistically** to its own copy and sends it with the current
  revision as `base`. The host applies the op to its model, replaces the document text with one
  `WorkspaceEdit`, and answers `ack` with the new `document.version`.
- If `base` does not match the host's current version, the op is rejected and a full `table`
  is sent instead. The webview replaces its copy. Same on any `WorkspaceEdit` failure.
- `onDidChangeTextDocument` for this URI: if the new text equals what the host last wrote, it is
  the echo of our own edit — ignore. Otherwise (undo, redo, a side-by-side text editor, a
  download from the remote) re-parse and send a full `table`.

The host keeps one model per open document, discarded when the last editor for it closes.

## Editor provider (`editor.ts`)

- `CSV_EDITOR_ID = 'sftp.csvEditor'`. `retainContextWhenHidden: true`,
  `supportsMultipleEditorsPerDocument: false` — one grid per file. VS Code moves the existing
  tab rather than opening a second, which is what keeps the host's echo mark (below) sound; a
  side-by-side text editor is not a custom editor and is unaffected.
- `localResourceRoots: [media/csv]`. CSP: `default-src 'none'; script-src 'nonce-…';
  style-src ${cspSource} 'unsafe-inline'`. No external host anywhere. Inline styles are needed
  for virtual-scroll offsets and column widths.
- Read-only when `document.uri.scheme === 'remote'` (a Remote Explorer preview with
  `downloadWhenOpenInRemoteExplorer` off). The grid shows a banner: "Remote preview — read-only.
  Download the file to edit it." Every edit affordance is disabled. Editing a remote file with
  the download setting on works normally, because that opens the local copy.
- Files larger than `MAX_GRID_BYTES = 10 MB` (by `getText().length`) get `tooLarge`: the webview
  shows the size, the limit, and an **Open as Text** button.
- Document edit: replace the full range with the serialized text. One `WorkspaceEdit` per op,
  so one undo step per op.

## Grid webview (`webui/csv/`)

Files: `main.tsx`, `App.tsx`, `Grid.tsx`, `Toolbar.tsx`, `FindReplace.tsx`, `ContextMenu.tsx`,
`useVirtualRows.ts`, `search.ts` (pure: match/filter/highlight), `sortState.ts` (pure),
`vscode.ts` (acquireVsCodeApi wrapper), `styles.css`, `vite.config.ts`. Pure modules under
`webui/csv/` get jest tests in `webui/csv/__tests__/`.

Styled with VS Code CSS variables only (`--vscode-editor-*`, `--vscode-list-*`,
`--vscode-input-*`, `--vscode-button-*`, `--vscode-focusBorder`,
`--vscode-editor-findMatchHighlightBackground`), so it follows the user's theme.

### Layout

- **Toolbar** (sticky): Add Row · Delete Rows (enabled when rows selected) · Add Column ·
  Header row toggle · search box · column-scope dropdown (All columns / each header) · "Aa"
  match-case toggle · replace box · Replace All · Open as Text. Right side: status "1,204 rows ×
  8 columns · Comma · LF", and "23 matching" while a search is active.
- **Grid**: row-number gutter, header cells, body. Only the rows in view (plus a buffer) are in
  the DOM; the scroll container has the full height so the scrollbar is honest.
- **Status toasts** for `error` messages, bottom-right, auto-dismiss.

### Interactions

- **Select** a cell by click. Arrow keys move. `Home`/`End` go to first/last column;
  `Ctrl+Home`/`Ctrl+End` to first/last row.
- **Edit**: `Enter`, `F2`, or typing a printable character starts editing (typing replaces the
  value; `Enter`/`F2` keeps it). `Enter` commits and moves down; `Tab`/`Shift+Tab` commit and
  move right/left; `Escape` cancels. Clicking elsewhere commits. A commit with an unchanged
  value sends nothing.
- **Delete/Backspace** on a selected (not editing) cell clears it.
- **Copy/paste**: `Ctrl/Cmd+C` on a selected cell copies its value; `Ctrl/Cmd+V` on a selected
  cell sets it to the clipboard text. Multi-cell paste is out of scope.
- **Rows**: click a row number to select the row; `Shift`-click for a range; `Ctrl/Cmd`-click to
  toggle. Right-click a row number: Insert Above, Insert Below, Duplicate, Delete. Toolbar
  **Add Row** inserts after the last selected row, or at the end.
- **Columns**: click a header to sort ascending; click again for descending; a third click
  clears the indicator (order stays as sorted — it is already in the file). Right-click a header:
  Rename, Insert Left, Insert Right, Delete. Rename edits the header cell in place (header on) —
  with the header toggle off, Rename is not offered. Column widths: auto from content, capped;
  drag the header edge to resize (view only).
- **Header toggle** is view state for this tab only. Off: headers show `1, 2, 3…` and row 0 is
  an ordinary row.
- **Search** filters to rows with a matching cell (case-insensitive unless "Aa"), scoped by the
  dropdown, and highlights the matched text. With the header toggle on, row 0 is always shown
  and never matched or replaced; with it off, row 0 is an ordinary row. `Ctrl/Cmd+F` focuses
  the search box — the CSV panel does **not** enable VS Code's own webview find widget, so the
  grid owns that key. `Escape` in the search box clears it.
- **Replace All** replaces the search text with the replace text in every matching cell within
  the current scope, as one op (one undo step). It asks nothing: the match count is already on
  screen, and undo is one keystroke.
- **Undo/redo**: `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` outside a cell input are not
  handled by the webview, so VS Code's own undo reaches the custom text editor. The implementer
  must verify this end to end; if a host does not forward the keybinding, the fallback is a
  `{ type: 'undo' | 'redo' }` message that the host turns into the `undo` / `redo` command.
- **Empty file**: a grid with no rows and a hint. Add Row creates row 0 with one empty cell;
  Add Column widens it.

## VS Code contributions (`package.json`)

- `customEditors`: `{ viewType: "sftp.csvEditor", displayName: "CSV Editor",
  selector: [ {filenamePattern: "*.csv"}, {filenamePattern: "*.tsv"} ], priority: "default" }`.
- Activation: `onCustomEditor:sftp.csvEditor`, `onCommand:sftp.csv.openAsText`.
- Command `sftp.csv.openAsText` ("Open as Text", category "CSV", icon `$(code)`), implemented by
  `src/commands/commandCsvOpenAsText.ts` as `vscode.openWith uri 'default'`.
- Menus: `editor/title` and `editor/title/context` when `activeCustomEditorId == sftp.csvEditor`;
  `explorer/context` when `resourceExtname == .csv || resourceExtname == .tsv`.
- Constants: `COMMAND_CSV_OPEN_AS_TEXT`.
- The Markdown `target.ts` becomes `src/modules/editorTarget.ts` exporting `activeDocumentUri`,
  used by both Markdown and CSV commands. Same code, one home.

## Build and packaging

- `webui/csv/vite.config.ts`: `build.lib` with `formats: ['iife']`, entry `main.tsx`, output
  `media/csv/csv.js` and `media/csv/csv.css` (`cssCodeSplit: false`, fixed asset name),
  `define: { 'process.env.NODE_ENV': '"production"' }`, `emptyOutDir: true`.
- Scripts: `build:csv`; `vscode:prepublish` runs `build:pdfjs && build:webui && build:csv &&
  compile`.
- `.vscodeignore`: `!media/csv/**/*`. `.gitignore`: `media/csv/`.
- `react` / `react-dom` are already devDependencies and are bundled; nothing new ships from
  `node_modules`.

## Error handling

- Parse never throws: the tolerant parser produces some table for any text.
- A failed `WorkspaceEdit` (read-only document, closed document) → `error` toast + full `table`
  resync, so the grid never shows a state the file does not have.
- A stale op (`base` mismatch) → silent full resync; the user's change is dropped and the grid
  shows the document as it is. This only happens when something else changed the file between
  the user's keystroke and the host's reply.
- Host exceptions in message handling are caught, logged via the extension logger, and reported
  as an `error` toast.

## Testing

Jest, in `src/modules/csv/__tests__/`:

- `format-test.ts`: delimiter detection for comma/semicolon/tab/pipe files, quoted delimiters
  ignored, `.tsv` default, CRLF vs LF, final newline present/absent, quoteAll on/off.
- `parse-test.ts`: quoted fields, `""` escapes, embedded newlines (LF and CRLF), ragged rows,
  blank lines, trailing delimiter (empty last cell), text after a closing quote, empty input,
  input with only a newline, `raw` captured per row.
- `serialize-test.ts`: **round-trip corpus** — every fixture in `__fixtures__/*.csv|tsv` parses
  and serializes byte-identical. Quoting rule table for changed cells. Rebuilt row with a mix of
  changed and unchanged cells keeps unchanged cells' quoting.
- `model-test.ts`: each op's effect and exactly which rows lose `raw`; sort stability, numeric
  vs text compare, empties last, header pinned; replaceAll scope, matchCase, header untouched;
  duplicate keeps `raw`; column ops on ragged rows.
- `shell-test.ts`: CSP has no external host, one nonce'd script, asset URIs from the base.

Jest, in `webui/csv/__tests__/`: `search-test.ts` (filter, scope, case, highlight ranges),
`sortState-test.ts` (asc → desc → clear cycle).

Manual/headless: the built bundle is loaded in headless Chrome over the DevTools protocol (as
was done for the PDF viewer) with a fixture table posted as a `table` message; edit a cell, add
a row, run a search and Replace All; assert the `op` messages sent and take a screenshot. Then a
real VS Code smoke test: open a CSV, edit, `Ctrl+Z`, save, diff against the original — and the
same on a remote preview to confirm the read-only banner.

`npm run compile` must be green (jest does not typecheck).

## Out of scope for 1.32.0

Regex search, multi-cell paste, drag-to-reorder columns, persisted column widths or header
setting, cell types/formatting, other quoting dialects (single quotes, backslash escapes),
multi-character delimiters, `.txt` files, an "Open in CSV Editor" command from the text editor
(VS Code's "Reopen Editor With…" covers it).

## Docs

README gets a "CSV editor" section (what opens, what's preserved, Open as Text, the
`workbench.editorAssociations` opt-out, the read-only remote rule, the 10 MB limit). CHANGELOG
gets a 1.32.0 entry. Version bumps to 1.32.0.
