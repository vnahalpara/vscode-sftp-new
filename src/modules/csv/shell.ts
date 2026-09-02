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
