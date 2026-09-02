import { buildPdfShell } from '../shell';

const OPTS = {
  assetBase: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/pdfjs/',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  nonce: 'abc123',
  title: 'report.pdf',
};

describe('buildPdfShell', () => {
  const html = buildPdfShell(OPTS);

  it('loads the core before the viewer module, from the asset base', () => {
    const core = html.indexOf(`from "${OPTS.assetBase}pdf.min.mjs"`);
    const viewer = html.indexOf(`from "${OPTS.assetBase}pdf_viewer.mjs"`);
    expect(core).toBeGreaterThan(-1);
    expect(viewer).toBeGreaterThan(core);
  });

  it('points the worker, cmaps and standard fonts at the asset base', () => {
    expect(html).toContain(`workerSrc = "${OPTS.assetBase}pdf.worker.min.mjs"`);
    expect(html).toContain(`cMapUrl: "${OPTS.assetBase}cmaps/"`);
    expect(html).toContain(`standardFontDataUrl: "${OPTS.assetBase}standard_fonts/"`);
  });

  it('tolerates an asset base without a trailing slash', () => {
    const out = buildPdfShell({ ...OPTS, assetBase: OPTS.assetBase.replace(/\/$/, '') });
    expect(out).toContain(`from "${OPTS.assetBase}pdf.min.mjs"`);
  });

  it('carries the nonce on the one inline script', () => {
    expect(html).toContain(`<script type="module" nonce="${OPTS.nonce}">`);
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });

  it('escapes the title', () => {
    const out = buildPdfShell({ ...OPTS, title: '<b>x</b> & "y"' });
    expect(out).toContain('<title>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</title>');
  });

  describe('the content security policy', () => {
    const csp = /content="([^"]+)"/.exec(html.split('Content-Security-Policy')[1])![1];

    it('refuses everything by default', () => {
      expect(csp).toContain(`default-src 'none'`);
    });

    // A PDF cannot make this page reach any host: no network source appears
    // anywhere in the policy.
    it('names no external host anywhere', () => {
      expect(csp).not.toMatch(/https?:\/\/(?!file\+\.vscode-resource)/);
      expect(csp).not.toMatch(/\bhttps?:(\s|;|$)/);
    });

    it('admits scripts only from the extension and the nonce', () => {
      expect(csp).toContain(`script-src ${OPTS.cspSource} 'nonce-${OPTS.nonce}'`);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    });

    it('admits the worker from the extension and blob', () => {
      expect(csp).toContain(`worker-src ${OPTS.cspSource} blob:`);
    });

    // PDF.js draws pages to canvases and extracts embedded fonts as blobs;
    // these are what let it render, and neither can reach the network.
    it('admits generated images and fonts', () => {
      expect(csp).toContain(`img-src ${OPTS.cspSource} data: blob:`);
      expect(csp).toContain(`font-src ${OPTS.cspSource} blob: data:`);
    });

    it('lets cmaps and standard fonts be fetched from the extension only', () => {
      const connect = /connect-src ([^;]*)/.exec(csp)![1].trim().split(/\s+/);
      // Exactly one source, and it is the extension's own. A bare `https:`
      // scheme source or a `*` here would let a PDF's script reach the
      // network -- and a first draft of this assertion wrongly flagged the
      // `https://` at the start of cspSource itself, so it now checks the
      // token list rather than pattern-matching the string.
      expect(connect).toEqual([OPTS.cspSource]);
    });
  });

  it('has the container structure PDF.js requires', () => {
    expect(html).toContain('id="viewerContainer"');
    expect(html).toContain('<div id="viewer" class="pdfViewer">');
  });

  it('opens documents from posted bytes, not from a URL', () => {
    expect(html).toContain("if (msg && msg.type === 'open') open(msg.data)");
    expect(html).toContain('getDocument({\n        data,');
    expect(html).not.toMatch(/getDocument\(\s*["'`]/);
  });

  it('announces readiness so the extension knows when to post the bytes', () => {
    expect(html).toContain("vscode.postMessage({ type: 'ready' })");
  });
});
