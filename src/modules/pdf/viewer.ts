import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { REMOTE_SCHEME } from '../../constants';
import { buildPdfShell } from './shell';

// The viewType in package.json's `customEditors` contribution.
export const PDF_VIEWER_ID = 'sftp.pdfViewer';

// How the provider reads a PDF that is not on the local disk -- a `remote:`
// URI from the Remote Explorer. Injected at registration rather than imported
// from the explorer module, so this module has no dependency on the SFTP
// machinery and can be registered before any workspace profile exists.
export interface PdfViewerDeps {
  readRemote(uri: vscode.Uri): Promise<Uint8Array>;
}

// A CustomDocument is the model half of a custom editor. For a read-only
// viewer it is nothing but the URI and the bytes: there is no edit state to
// track, no save to implement, and dispose() has nothing to release.
class PdfDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly bytes: Uint8Array
  ) {}
  dispose(): void {
    /* nothing held beyond what the GC reclaims */
  }
}

// A read-only rendered view of a PDF, registered as the DEFAULT editor for
// *.pdf. Replaces the standalone PDF-viewer extension the user had installed
// for this: VS Code's own answer to a PDF is "the file is not displayed in
// the text editor because it is either binary or uses an unsupported
// encoding", which is no answer at all.
//
// CustomREADONLYEditorProvider, not CustomTextEditorProvider: a PDF is
// binary, and VS Code would otherwise try to open it as a TextDocument first
// and choke on the encoding before this code ever ran.
//
// THE BYTES TRAVEL BY MESSAGE, NOT BY URL. The obvious design -- hand the
// webview a webview URI for the file and let PDF.js fetch it -- works only
// for `file:` URIs, and this extension's whole point is files that are not
// on the local disk. A PDF opened from the Remote Explorer has a `remote:`
// URI backed by a TextDocumentContentProvider, which a webview cannot fetch
// from at all. Reading the bytes here, through whichever provider the URI's
// scheme has, and posting them to the webview means one viewer serves every
// scheme the extension can read.
//
// THE COST, stated honestly: the bytes are held TWICE for the tab's whole
// life -- once on this document, once inside the retained webview -- not
// "for a moment". They are kept here deliberately: VS Code reloads a webview
// on some theme and settings changes, the shell then sends `ready` again,
// and serving that from memory is what keeps a remote PDF from being
// re-fetched over SFTP every time it happens. For the documents this
// extension is for (READMEs, invoices, reports) the duplication is a few MB
// and not worth a re-read path; a 300MB scan would feel it, and the right
// fix then is to re-read on reload rather than to hold on.
export class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static register(context: vscode.ExtensionContext, deps: PdfViewerDeps): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PDF_VIEWER_ID,
      new PdfViewerProvider(context.extensionUri, deps),
      {
        webviewOptions: {
          // Keep the rendered pages, zoom and scroll position when the tab
          // is hidden. A PDF re-parsing from scratch on every tab switch is
          // the single most annoying thing a PDF viewer can do.
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: PdfViewerDeps
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _context: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PdfDocument> {
    const bytes =
      uri.scheme === REMOTE_SCHEME
        ? await this.deps.readRemote(uri)
        : await vscode.workspace.fs.readFile(uri);
    return new PdfDocument(uri, bytes);
  }

  resolveCustomEditor(
    document: PdfDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    const assetRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs');
    panel.webview.options = {
      enableScripts: true,
      // Only the PDF.js assets. NOT the document's own directory: the bytes
      // arrive by message, so the webview has no reason to be able to load
      // anything from wherever the PDF happened to live.
      localResourceRoots: [assetRoot],
    };

    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildPdfShell({
      assetBase: `${panel.webview.asWebviewUri(assetRoot).toString()}/`,
      cspSource: panel.webview.cspSource,
      nonce,
      title: path.basename(document.uri.path),
    });

    // Post once the page's module script is listening. Posting before that
    // -- straight after setting html -- loses the message on the floor, and
    // the viewer sits on "Loading…" forever.
    const sub = panel.webview.onDidReceiveMessage((message: any) => {
      if (message && message.type === 'ready') {
        panel.webview.postMessage({ type: 'open', data: document.bytes });
      }
    });
    panel.onDidDispose(() => sub.dispose());
  }
}
