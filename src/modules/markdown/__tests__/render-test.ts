import {
  DOCUMENT_CSS,
  PRINT_THEME_CSS,
  VIEWER_THEME_CSS,
  escapeText,
  renderMarkdownBody,
  renderPrintDocument,
} from '../render';

describe('renderMarkdownBody', () => {
  it('renders headings, emphasis and lists', () => {
    const html = renderMarkdownBody('# Title\n\nSome *emphasis*.\n\n- one\n- two\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdownBody('```js\nconst a = 1;\n```\n');
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain('const a = 1;');
  });

  it('renders a GFM-style table', () => {
    const html = renderMarkdownBody('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  // The load-bearing property. The output lands in a webview and in a
  // headless browser, and a README pulled from a remote server is not trusted
  // content. Raw HTML in the source must be shown as text, never executed.
  it('escapes raw HTML rather than passing it through', () => {
    const html = renderMarkdownBody('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('linkifies a bare URL', () => {
    expect(renderMarkdownBody('see https://example.com today')).toContain(
      '<a href="https://example.com">https://example.com</a>'
    );
  });

  it('handles an empty or missing document', () => {
    expect(renderMarkdownBody('')).toBe('');
    expect(renderMarkdownBody(undefined as any)).toBe('');
  });
});

describe('escapeText', () => {
  it('escapes the three characters that matter in a text node', () => {
    expect(escapeText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('renderPrintDocument', () => {
  it('produces a complete self-contained document', () => {
    const html = renderPrintDocument('# Hi', 'readme');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>readme</title>');
    expect(html).toContain('<article class="md-body"><h1>Hi</h1>');
  });

  // The PDF is for sharing, so it must not depend on anything that is not in
  // the file: no external stylesheet, no font URL, no script.
  it('references no external resources', () => {
    const html = renderPrintDocument('# Hi', 't');
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/url\(/);
  });

  it('escapes the title', () => {
    expect(renderPrintDocument('', '<b>x</b>')).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
  });

  // A document exported from a dark editor must arrive as a print document,
  // not white-on-black. The print palette is pinned, not inherited.
  it('pins a light print palette rather than inheriting the editor theme', () => {
    const html = renderPrintDocument('', 't');
    expect(html).toContain(PRINT_THEME_CSS);
    expect(html).not.toContain(VIEWER_THEME_CSS);
    expect(html).not.toContain('--vscode-');
  });
});

describe('the shared stylesheet', () => {
  // Both consumers style through the same custom properties; a colour that
  // is hard-coded in the shared block would look right in one and wrong in
  // the other.
  it('uses only custom properties for colour', () => {
    expect(DOCUMENT_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(DOCUMENT_CSS).not.toMatch(/\brgb\(/);
  });

  it('defines every property the shared block consumes, in both palettes', () => {
    const used = Array.from(new Set(DOCUMENT_CSS.match(/--md-[a-z-]+/g) || []))
      .filter(name => name !== '--md-font' && name !== '--md-mono');
    for (const name of used) {
      expect(VIEWER_THEME_CSS).toContain(`${name}:`);
      expect(PRINT_THEME_CSS).toContain(`${name}:`);
    }
  });

  it('avoids page breaks inside a code block or table when printing', () => {
    expect(PRINT_THEME_CSS).toContain('break-inside: avoid');
  });
});
