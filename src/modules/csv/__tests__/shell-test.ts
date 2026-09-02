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
