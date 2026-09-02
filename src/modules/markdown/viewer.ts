import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { COMMAND_MARKDOWN_OPEN_AS_TEXT, COMMAND_MARKDOWN_TO_PDF } from '../../constants';
import { DOCUMENT_CSS, VIEWER_THEME_CSS, escapeText, renderMarkdownBody } from './render';

// The viewType in package.json's `customEditors` contribution. Referenced by
// the `activeCustomEditorId` when-clauses on the tab-context menu items, so a
// change here must be mirrored there.
export const MARKDOWN_VIEWER_ID = 'sftp.markdownViewer';

// A read-only rendered view of a Markdown file, registered as the DEFAULT
// editor for *.md.
//
// CustomTextEditorProvider rather than a webview panel driven by a command:
// this is the one shape VS Code gives an extension that (a) opens
// automatically when the user opens a file, (b) shows the file's own name on
// the tab, (c) gets "Reopen Editor With..." and the `vscode.openWith` command
// for free, and (d) keeps the underlying TextDocument alive so the text
// editor can be opened beside it without a second read from disk.
//
// Read-only on purpose. The user asked for a VIEWER with "open as normal" for
// editing; a WYSIWYG Markdown editor is a different, much larger feature and
// would make the text editor's role ambiguous. The document is watched, so an
// edit made in the text editor (or by a formatter, or by a pull from the
// remote) re-renders here live.
export class MarkdownViewerProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MARKDOWN_VIEWER_ID,
      new MarkdownViewerProvider(),
      {
        webviewOptions: {
          // Keep the rendered DOM when the tab is hidden. Without this, every
          // tab switch away and back re-creates the webview from scratch --
          // a visible flash, a lost scroll position, and a full re-render of
          // a long document. The cost is memory per hidden viewer, which for
          // a rendered README is small.
          retainContextWhenHidden: true,
        },
        // One provider instance can serve every open document; it holds no
        // per-document state that is not on the panel itself.
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    panel.webview.options = {
      enableScripts: true,
      // No local resource roots: the document is rendered as inline HTML with
      // inline styles, and markdown-it is configured with html:false, so
      // there is nothing to load and nothing to expose.
      localResourceRoots: [],
    };

    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = this.shell(panel.webview, document.fileName, nonce);

    const push = () => {
      panel.webview.postMessage({ type: 'render', html: renderMarkdownBody(document.getText()) });
    };

    // Re-render on every change to the underlying document -- typing in a
    // side-by-side text editor, a formatter, a Download from the remote.
    // Filtered by URI so a change to any OTHER document does not re-render
    // this one.
    const changeSub = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) {
        push();
      }
    });

    const messageSub = panel.webview.onDidReceiveMessage((message: any) => {
      // The webview asks for the initial render once its script has run,
      // rather than the extension pushing before the listener exists and
      // losing the message.
      if (message && message.type === 'ready') {
        push();
        return;
      }
      if (message && message.type === 'openAsText') {
        vscode.commands.executeCommand(COMMAND_MARKDOWN_OPEN_AS_TEXT, document.uri);
        return;
      }
      if (message && message.type === 'exportPdf') {
        vscode.commands.executeCommand(COMMAND_MARKDOWN_TO_PDF, document.uri);
        return;
      }
      // http(s) only, re-validated here rather than trusting the webview's
      // own filter: the webview runs the file's rendered content, and a link
      // with any other scheme (javascript:, file:, vscode:) must never reach
      // openExternal from it.
      if (message && message.type === 'openLink' && /^https?:\/\//i.test(String(message.href || ''))) {
        vscode.env.openExternal(vscode.Uri.parse(String(message.href)));
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });
  }

  // The static shell: CSP, styles, a small toolbar, and the script that
  // swaps rendered HTML into the article. The document body itself arrives
  // by postMessage so the shell never has to be rebuilt.
  //
  // CSP: no `unsafe-inline` for scripts (the one script carries the nonce),
  // no external hosts for anything but images, and `img-src` limited to
  // https: and data: so a README's badges still show while nothing can be
  // fetched from an arbitrary scheme.
  //
  // Two things about that policy are deliberate trade-offs, not oversights:
  //
  //   - `img-src https:` means a remote image in the file IS fetched when the
  //     document is viewed, so a `![](https://example/pixel.png)` can tell
  //     its host that someone opened the file. VS Code's own Markdown preview
  //     behaves the same way, and blocking remote images would break every
  //     README badge. Documented in the README under the feature.
  //
  //   - Inline STYLES are allowed because the document is styled by an inline
  //     <style> block. With html:false the file cannot inject a <style> tag
  //     or a style attribute of its own -- the ONLY style attribute markdown-it
  //     emits is `text-align` on table cells, from the `:---:` column syntax,
  //     with three fixed values. That is not a vector.
  private shell(webview: vscode.Webview, fileName: string, nonce: string): string {
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeText(fileName)}</title>
<style>
${VIEWER_THEME_CSS}
${DOCUMENT_CSS}
.md-toolbar {
  position: sticky; top: 0; z-index: 1;
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
  padding: 6px 12px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--md-rule);
  font-family: var(--vscode-font-family); font-size: 12px;
}
.md-toolbar button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px; padding: 3px 10px; cursor: pointer; font: inherit;
}
.md-toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.md-toolbar .primary {
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
.md-toolbar .primary:hover { background: var(--vscode-button-hoverBackground); }
.md-toolbar .hint { margin-right: auto; color: var(--md-muted); }
</style>
</head>
<body>
<div class="md-toolbar">
  <span class="hint">Rendered view — read-only</span>
  <button id="openAsText" title="Open the raw Markdown in the text editor">Open as Text</button>
  <button id="exportPdf" class="primary" title="Convert this document to PDF">Export PDF</button>
</div>
<article id="content" class="md-body"></article>
<script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();
    var content = document.getElementById('content');
    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg && msg.type === 'render') {
        // Preserve scroll across re-renders so live editing beside the viewer
        // does not snap the reader back to the top on every keystroke.
        var y = window.scrollY;
        content.innerHTML = msg.html;
        window.scrollTo(0, y);
      }
    });
    document.getElementById('openAsText').addEventListener('click', function () {
      vscode.postMessage({ type: 'openAsText' });
    });
    document.getElementById('exportPdf').addEventListener('click', function () {
      vscode.postMessage({ type: 'exportPdf' });
    });
    // Links inside the document: let VS Code handle http(s) via its own
    // link opener rather than navigating the webview away from the article.
    content.addEventListener('click', function (event) {
      var a = event.target && event.target.closest ? event.target.closest('a') : null;
      if (a && /^https?:/i.test(a.getAttribute('href') || '')) {
        event.preventDefault();
        vscode.postMessage({ type: 'openLink', href: a.getAttribute('href') });
      }
    });
    vscode.postMessage({ type: 'ready' });
  })();
</script>
</body>
</html>`;
  }
}
