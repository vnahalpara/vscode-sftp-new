import MarkdownIt = require('markdown-it');

// One renderer, configured once. `html: false` is deliberate and load-bearing:
// the output lands in a VS Code webview and in a headless browser, and a
// README fetched from a remote server is not trusted content. Raw HTML in the
// source is escaped and shown as text rather than executed. `linkify` turns
// bare URLs into links, which is what a reader expects of a rendered document.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

// The body only -- no <html>, no styles. This is what the webview re-renders
// on every keystroke in the underlying document, so it is kept as small as the
// renderer allows.
export function renderMarkdownBody(source: string): string {
  return md.render(source || '');
}

// Escapes the pieces of a document that come from the FILE rather than from
// the renderer: the title in <title>, and nothing else, because markdown-it
// already escapes everything that reaches the body. Not a general-purpose
// HTML escaper -- it is used in exactly one attribute-free text position.
export function escapeText(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Styling shared by the viewer and the PDF, expressed against CSS custom
// properties so the two can differ only in what those resolve to. The viewer
// maps them to VS Code's own theme variables (so it follows light/dark); the
// PDF pins them to a print palette. Everything a reader would call "the
// document's look" -- type scale, code blocks, tables, blockquotes -- lives
// here once.
export const DOCUMENT_CSS = `
:root {
  --md-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --md-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.md-body {
  font-family: var(--md-font);
  font-size: 15px;
  line-height: 1.6;
  color: var(--md-fg);
  background: var(--md-bg);
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 40px 64px;
  word-wrap: break-word;
}
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
  margin: 1.4em 0 0.6em; line-height: 1.25; font-weight: 600;
}
.md-body h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid var(--md-rule); }
.md-body h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid var(--md-rule); }
.md-body h3 { font-size: 1.25em; }
.md-body h4 { font-size: 1.05em; }
.md-body p, .md-body ul, .md-body ol, .md-body blockquote, .md-body pre, .md-body table { margin: 0 0 1em; }
.md-body ul, .md-body ol { padding-left: 2em; }
.md-body li + li { margin-top: .25em; }
.md-body a { color: var(--md-link); text-decoration: none; }
.md-body a:hover { text-decoration: underline; }
.md-body code {
  font-family: var(--md-mono); font-size: .9em;
  background: var(--md-code-bg); padding: .15em .35em; border-radius: 4px;
}
.md-body pre {
  background: var(--md-code-bg); padding: 14px 16px; border-radius: 6px;
  overflow-x: auto; line-height: 1.45;
}
.md-body pre code { background: none; padding: 0; font-size: .875em; }
.md-body blockquote {
  border-left: 4px solid var(--md-rule); padding: 0 1em; color: var(--md-muted);
}
.md-body table { border-collapse: collapse; width: auto; max-width: 100%; display: block; overflow-x: auto; }
.md-body th, .md-body td { border: 1px solid var(--md-rule); padding: 6px 13px; }
.md-body th { font-weight: 600; background: var(--md-code-bg); }
.md-body tr:nth-child(2n) td { background: var(--md-row-alt); }
.md-body hr { border: 0; border-top: 1px solid var(--md-rule); margin: 1.5em 0; }
.md-body img { max-width: 100%; }
.md-body input[type=checkbox] { margin-right: .4em; }
`;

// The viewer's palette: VS Code's own theme variables, so the document follows
// whatever theme the editor is in, including high-contrast.
export const VIEWER_THEME_CSS = `
:root {
  --md-fg: var(--vscode-editor-foreground);
  --md-bg: var(--vscode-editor-background);
  --md-muted: var(--vscode-descriptionForeground);
  --md-link: var(--vscode-textLink-foreground);
  --md-rule: var(--vscode-panel-border, rgba(128,128,128,0.35));
  --md-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
  --md-row-alt: rgba(128,128,128,0.06);
}
body { margin: 0; }
`;

// The PDF's palette: pinned to print values regardless of the editor theme. A
// document exported from a dark editor must not arrive as white-on-black.
export const PRINT_THEME_CSS = `
:root {
  --md-fg: #1f2328;
  --md-bg: #ffffff;
  --md-muted: #59636e;
  --md-link: #0969da;
  --md-rule: #d1d9e0;
  --md-code-bg: #f6f8fa;
  --md-row-alt: #f6f8fa;
}
@page { margin: 18mm 16mm; }
body { margin: 0; }
.md-body { max-width: none; padding: 0; font-size: 11.5pt; }
.md-body pre, .md-body blockquote, .md-body table, .md-body img { break-inside: avoid; }
.md-body h1, .md-body h2, .md-body h3 { break-after: avoid; }
`;

// A complete, self-contained HTML document -- what headless Chrome prints. No
// external resources: the PDF renderer runs with no network expectation, and
// the viewer's CSP forbids them anyway.
export function renderPrintDocument(source: string, title: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeText(title)}</title>`,
    `<style>${DOCUMENT_CSS}${PRINT_THEME_CSS}</style>`,
    '</head><body>',
    `<article class="md-body">${renderMarkdownBody(source)}</article>`,
    '</body></html>',
  ].join('\n');
}
