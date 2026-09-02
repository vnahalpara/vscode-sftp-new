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
  // The tail of this document's op queue. Ops are chained onto it so only one
  // is ever between `applyOp` and its applyEdit; see the `op` branch below.
  inFlight: Promise<void>;
}

// A file the grid will refuse is not worth parsing -- the rows would be built
// only to be thrown away. The empty table keeps the model's shape while
// sendTable reports `tooLarge` instead of any of it.
function readTable(text: string, name: string): CsvTable {
  if (isTooLarge(text.length)) {
    return { rows: [], format: detectFormat('', name) };
  }
  return parseCsv(text, detectFormat(text, name));
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
        // One grid per file. A second panel on the same document would
        // register its own change handler, and whichever handler saw the echo
        // of a WorkspaceEdit first would clear `lastWritten` for both -- so
        // the other panel would either miss its own echo or mistake a real
        // change for one. With `false` VS Code reveals the existing tab
        // instead of opening a second. A side-by-side TEXT editor is not a
        // second custom editor and is unaffected.
        supportsMultipleEditorsPerDocument: false,
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
      const text = document.getText();
      if (isTooLarge(text.length)) {
        send({ type: 'tooLarge', bytes: text.length, limit: MAX_GRID_BYTES });
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
      model.table = readTable(text, path.basename(document.uri.path));
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

    const fail = (error: unknown) => {
      // A rejection is not necessarily an Error -- a thrown string from the
      // webview boundary would otherwise make `error.message` undefined and
      // the grid show an empty complaint.
      const e = error instanceof Error ? error : new Error(String(error));
      logger.error(e, 'csv editor message');
      send({ type: 'error', message: e.message });
      sendTable();
    };

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
          // Same reason as the op branch: the thenable is not awaited here, so
          // its rejection has to be caught on the chain rather than by the
          // surrounding try.
          vscode.commands
            .executeCommand(COMMAND_CSV_OPEN_AS_TEXT, document.uri)
            .then(undefined, fail);
          return;
        }
        if (message.type === 'op') {
          const { base, op } = message;
          // Queued, not called straight away. The webview already sends one op
          // at a time, but the invariant `base` rests on has to hold here too:
          // a second op arriving while the first applyEdit is still pending
          // would run `applyOp` against the pre-edit table and would overwrite
          // `lastWritten`, so the first edit's echo would be mistaken for an
          // outside change. Chained, an op sent before its ack simply carries a
          // stale `base` and is resynced -- the correct outcome.
          //
          // Not awaited -- onDidReceiveMessage is synchronous -- so the
          // surrounding try/catch cannot see a rejection from it. The catch has
          // to be chained on, or a failed applyEdit would surface as an
          // unhandled rejection and leave the grid waiting for its ack. It also
          // keeps the queue alive: a settled promise is what the next op waits
          // on.
          model.inFlight = model.inFlight
            .then(() =>
              this.applyFromWebview(
                document,
                model,
                base,
                op,
                send,
                sendTable,
                reparse,
                readOnlyReason
              )
            )
            .catch(fail);
        }
      } catch (error) {
        fail(error);
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
    const model: DocumentModel = {
      table: readTable(document.getText(), path.basename(document.uri.path)),
      lastWritten: null,
      panels: 1,
      inFlight: Promise.resolve(),
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
    reparse: () => void,
    readOnlyReason: string | undefined
  ): Promise<void> {
    if (isTooLarge(document.getText().length)) {
      // Defence in depth. A grid told `tooLarge` shows no rows and so should
      // never send an op, but the model behind an over-limit document is the
      // empty table readTable returns -- serializing that over the file would
      // erase it.
      sendTable();
      return;
    }
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
    if (document.getText() !== text) {
      // An outside change landed while applyEdit was in flight, so the document
      // is no longer the text this op produced. The document is the truth, and
      // the model must never be set from an op that no longer describes it:
      // keeping `next` here would quietly revert that change, because the next
      // op would pass isStaleOp against the new version and then be serialized
      // from this stale table.
      reparse();
      sendTable();
      return;
    }
    model.table = next;
    send({ type: 'ack', revision: document.version });
  }
}
