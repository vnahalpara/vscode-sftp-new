import { monitorHtml, escapeHtml } from '../html';

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
  });

  it('escapes quotes so it is safe inside an attribute', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });

  it('renders null and undefined as an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('monitorHtml', () => {
  const html = monitorHtml('vscode-webview://abc');

  it('declares a content security policy scoped to the webview source', () => {
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('vscode-webview://abc');
    expect(html).toContain("default-src 'none'");
  });

  it('loads no external resources', () => {
    expect(/(src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
  });

  it('contains a container for every milestone-1 card', () => {
    [
      'id="gauges"',
      'id="cpu"',
      'id="load"',
      'id="mem"',
      'id="net"',
      'id="storage"',
      'id="procs"',
    ].forEach(id => expect(html).toContain(id));
  });

  it('takes its colours from vscode theme variables', () => {
    expect(html).toContain('var(--vscode-foreground)');
    expect(html).toContain('var(--vscode-editor-background)');
  });

  it('exposes the interactive controls', () => {
    ['id="pause"', 'id="ivl"', 'id="procfilter"', 'id="reconnect"'].forEach(id =>
      expect(html).toContain(id)
    );
  });

  it('acquires the vscode api and posts a ready message', () => {
    expect(html).toContain('acquireVsCodeApi()');
    expect(html).toContain("type: 'ready'");
  });

  it('renders an em dash for null rates', () => {
    expect(html).toContain("'—'");
  });

  it('handles every inbound message type the panel sends', () => {
    ['init', 'tick', 'slow', 'state', 'connection', 'error'].forEach(t =>
      expect(html).toContain("'" + t + "'")
    );
  });

  it('posts every outbound message the panel handles', () => {
    ['pause', 'resume', 'setInterval', 'reconnect'].forEach(t =>
      expect(html).toContain("type: '" + t + "'")
    );
  });

  it('emits a client script that actually parses', () => {
    // The script is assembled inside a template literal, so an escaping slip
    // produces broken JS that no substring assertion would catch. Compiling it
    // parses without executing (there is no DOM here).
    const m = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(m).not.toBe(null);
    expect(() => new Function(m![1])).not.toThrow();
  });

  it('keeps the regex escapes intact through the template literal', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    // Must be \.0+$ (escaped dot), not .0+$ (any character).
    expect(script).toContain('/\\.0+$/');
    expect(script).toContain('▾'); // the sort arrow survived as a character
  });
});
