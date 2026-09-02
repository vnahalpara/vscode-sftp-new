// The PDF viewer's webview page, as a pure function of the URIs it needs.
// Kept apart from viewer.ts so it can be unit-tested without the vscode
// module, and so the same HTML can be written to disk and opened in headless
// Chrome to prove the viewer actually renders -- a webview cannot be driven
// from a test, but the Chromium it runs on can.

export interface PdfShellOptions {
  // Base URL (webview URI, trailing slash) under which media/pdfjs/ is served.
  assetBase: string;
  // webview.cspSource, so the CSP admits the extension's own resources.
  cspSource: string;
  // Per-panel nonce for the one inline script.
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

// The viewer chrome: toolbar with page navigation, zoom, find and a
// "download" affordance; a sidebar-free page container PDF.js's PDFViewer
// draws into. Deliberately small. The full pdf.js viewer app (sidebar,
// thumbnails, properties dialog, presentation mode) is not shipped in the npm
// package, and re-creating it wholesale would be a second project; this
// covers what a person reading a PDF inside an editor actually reaches for.
export function buildPdfShell(opts: PdfShellOptions): string {
  const base = opts.assetBase.endsWith('/') ? opts.assetBase : `${opts.assetBase}/`;
  // CSP. Each source is here for one reason:
  //   script-src   the two PDF.js modules from our own assets, plus the one
  //                inline bootstrap by nonce. Nothing else.
  //   worker-src   the parsing worker, from our assets. `blob:` because
  //                PDF.js may wrap the worker script in a Blob URL on some
  //                engines.
  //   style-src    pdf_viewer.css from assets, plus inline: PDF.js sets
  //                inline styles on every page/text-layer element it lays
  //                out, and there is no nonce mechanism for those.
  //   img-src      the sprite images from assets, plus data:/blob: for the
  //                canvases and annotation icons PDF.js generates at runtime.
  //   font-src     the standard_fonts substitutes, and blob: for embedded
  //                fonts PDF.js extracts from the document itself.
  //   connect-src  the cmaps and standard_fonts fetched on demand.
  //   default-src  'none' -- everything not listed above is refused,
  //                including any network host. A PDF cannot make this page
  //                phone home.
  const csp = [
    `default-src 'none'`,
    `script-src ${opts.cspSource} 'nonce-${opts.nonce}'`,
    `worker-src ${opts.cspSource} blob:`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `img-src ${opts.cspSource} data: blob:`,
    `font-src ${opts.cspSource} blob: data:`,
    `connect-src ${opts.cspSource}`,
  ].join('; ');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(opts.title)}</title>
<link rel="stylesheet" href="${base}pdf_viewer.css">
<style>
  :root {
    --toolbar-h: 36px;
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #ccc);
    --muted: var(--vscode-descriptionForeground, #999);
    --border: var(--vscode-panel-border, rgba(128,128,128,.35));
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-fg: var(--vscode-button-secondaryForeground, #ccc);
    --btn-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
    --accent: var(--vscode-focusBorder, #007fd4);
  }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 12px; overflow: hidden; }
  #toolbar { position: fixed; inset: 0 0 auto 0; height: var(--toolbar-h); display: flex; align-items: center;
    gap: 6px; padding: 0 10px; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 10; }
  #toolbar button { background: var(--btn-bg); color: var(--btn-fg); border: 1px solid transparent; border-radius: 3px;
    height: 24px; min-width: 26px; padding: 0 8px; cursor: pointer; font: inherit; }
  #toolbar button:hover { background: var(--btn-hover); }
  #toolbar button:disabled { opacity: .45; cursor: default; }
  #toolbar input, #toolbar select { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border);
    border-radius: 3px; height: 22px; font: inherit; padding: 0 6px; }
  #toolbar input:focus, #toolbar select:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
  #pageNumber { width: 44px; text-align: right; }
  #findInput { width: 160px; }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); }
  #findStatus { min-width: 70px; }
  #viewerContainer { position: absolute; top: var(--toolbar-h); left: 0; right: 0; bottom: 0; overflow: auto;
    background: var(--vscode-editorPane-background, #252526); }
  /* PDF.js requires the container to be absolutely positioned and the
     viewer inside to have this class; it sizes pages relative to it. */
  #viewer { }
  #status { position: absolute; top: var(--toolbar-h); left: 0; right: 0; padding: 24px; text-align: center; }
  #status.hidden { display: none; }
  .error { color: var(--vscode-errorForeground, #f48771); white-space: pre-wrap; text-align: left;
    max-width: 720px; margin: 0 auto; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="prev" title="Previous page (←)">‹</button>
  <button id="next" title="Next page (→)">›</button>
  <input id="pageNumber" type="number" min="1" value="1" title="Page">
  <span class="muted">/ <span id="pageCount">–</span></span>
  <span class="sep"></span>
  <button id="zoomOut" title="Zoom out (Ctrl -)">−</button>
  <select id="zoomSelect" title="Zoom">
    <option value="auto">Auto</option>
    <option value="page-fit">Page fit</option>
    <option value="page-width">Page width</option>
    <option value="0.5">50%</option>
    <option value="0.75">75%</option>
    <option value="1">100%</option>
    <option value="1.25">125%</option>
    <option value="1.5">150%</option>
    <option value="2">200%</option>
    <option value="3">300%</option>
  </select>
  <button id="zoomIn" title="Zoom in (Ctrl +)">+</button>
  <span class="sep"></span>
  <input id="findInput" type="search" placeholder="Find (Ctrl F)">
  <button id="findPrev" title="Previous match">↑</button>
  <button id="findNext" title="Next match (Enter)">↓</button>
  <span id="findStatus" class="muted"></span>
  <span class="spacer"></span>
  <button id="rotate" title="Rotate">⟳</button>
</div>
<div id="viewerContainer" tabindex="0">
  <div id="viewer" class="pdfViewer"></div>
</div>
<div id="status"><span class="muted">Loading…</span></div>
<script type="module" nonce="${opts.nonce}">
  import * as pdfjsLib from "${base}pdf.min.mjs";
  // pdf_viewer.mjs has no imports of its own; it reads globalThis.pdfjsLib,
  // which pdf.min.mjs publishes. Order matters and is enforced by the two
  // imports being sequential in this one module.
  import * as pdfjsViewer from "${base}pdf_viewer.mjs";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "${base}pdf.worker.min.mjs";

  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const status = $('status');
  const showError = text => {
    status.classList.remove('hidden');
    status.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'error';
    pre.textContent = text;
    status.appendChild(pre);
  };

  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({ eventBus, externalLinkTarget: pdfjsViewer.LinkTarget.BLANK });
  const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
  const viewer = new pdfjsViewer.PDFViewer({
    container: $('viewerContainer'),
    viewer: $('viewer'),
    eventBus,
    linkService,
    findController,
    textLayerMode: 2,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  linkService.setViewer(viewer);

  let pdf = null;

  // ---- toolbar wiring
  const setPage = n => { if (pdf) viewer.currentPageNumber = Math.min(Math.max(1, n | 0), pdf.numPages); };
  $('prev').onclick = () => setPage(viewer.currentPageNumber - 1);
  $('next').onclick = () => setPage(viewer.currentPageNumber + 1);
  $('pageNumber').onchange = e => setPage(Number(e.target.value));
  $('zoomIn').onclick = () => { viewer.currentScale = Math.min(viewer.currentScale * 1.1, 10); };
  $('zoomOut').onclick = () => { viewer.currentScale = Math.max(viewer.currentScale / 1.1, 0.1); };
  $('zoomSelect').onchange = e => { viewer.currentScaleValue = e.target.value; };
  $('rotate').onclick = () => { viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; };

  const find = (again, previous) => {
    const query = $('findInput').value;
    eventBus.dispatch('find', { source: null, type: again ? 'again' : '', query, caseSensitive: false,
      entireWord: false, highlightAll: true, findPrevious: !!previous, matchDiacritics: false });
  };
  $('findInput').oninput = () => find(false, false);
  $('findInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); find(true, e.shiftKey); } };
  $('findNext').onclick = () => find(true, false);
  $('findPrev').onclick = () => find(true, true);

  eventBus.on('pagechanging', e => { $('pageNumber').value = e.pageNumber; });
  eventBus.on('scalechanging', e => {
    const sel = $('zoomSelect');
    const preset = [...sel.options].find(o => o.value === String(e.presetValue));
    sel.value = preset ? preset.value : (Math.abs(Number(sel.value) - e.scale) < 0.001 ? sel.value : sel.value);
  });
  eventBus.on('updatefindmatchescount', e => {
    const c = e.matchesCount || {};
    $('findStatus').textContent = c.total ? (c.current + ' of ' + c.total) : ($('findInput').value ? 'No matches' : '');
  });
  eventBus.on('updatefindcontrolstate', e => {
    if (e.state === pdfjsViewer.FindState.NOT_FOUND) $('findStatus').textContent = 'No matches';
  });

  // Keyboard: the editor's own shortcuts do not reach a webview, so the
  // basics are re-implemented here. Ctrl/Cmd is accepted for both.
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'f') { e.preventDefault(); $('findInput').focus(); $('findInput').select(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('zoomIn').click(); return; }
    if (mod && e.key === '-') { e.preventDefault(); $('zoomOut').click(); return; }
    if (mod && e.key === '0') { e.preventDefault(); viewer.currentScaleValue = 'auto'; return; }
    if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); $('prev').click(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); $('next').click(); }
    if (e.key === 'Home') { e.preventDefault(); setPage(1); }
    if (e.key === 'End') { e.preventDefault(); if (pdf) setPage(pdf.numPages); }
  });

  // ---- document loading. The bytes arrive from the extension by message,
  // never by URL: that is what lets the same viewer show a PDF from the local
  // disk, from an SFTP remote, or from any other scheme the extension can
  // read, without the webview needing to reach any of them itself.
  async function open(data) {
    try {
      pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: "${base}cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "${base}standard_fonts/",
      }).promise;
      viewer.setDocument(pdf);
      linkService.setDocument(pdf, null);
      $('pageCount').textContent = pdf.numPages;
      $('pageNumber').max = pdf.numPages;
      status.classList.add('hidden');
      // Once the first page has laid out, fit to width -- the sensible
      // default in a side panel. Set after 'pagesinit' or PDF.js ignores it.
      eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; }, { once: true });
      vscode.setState({ page: viewer.currentPageNumber });
    } catch (err) {
      showError('Could not open this PDF.\\n\\n' + (err && err.message ? err.message : String(err)));
    }
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg && msg.type === 'open') open(msg.data);
    if (msg && msg.type === 'error') showError(msg.message);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
