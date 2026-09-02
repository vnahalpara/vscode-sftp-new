import { chromiumCandidates, findChromium, pdfArgs, toFileUrl } from '../pdf';

describe('chromiumCandidates', () => {
  it('lists Chrome first on macOS', () => {
    const list = chromiumCandidates('darwin', '/Users/x');
    expect(list[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  // A Windows machine with no Chrome almost always has Edge, and the flags
  // are identical -- refusing to use it would fail users for no reason.
  it('falls back to Edge on Windows', () => {
    const list = chromiumCandidates('win32', 'C:\\Users\\x');
    expect(list.some(p => /msedge\.exe$/.test(p))).toBe(true);
  });

  it('includes the snap and distro chromium paths on linux', () => {
    const list = chromiumCandidates('linux', '/home/x');
    expect(list).toContain('/usr/bin/chromium');
    expect(list).toContain('/snap/bin/chromium');
  });

  it('checks a per-user macOS install too', () => {
    expect(chromiumCandidates('darwin', '/Users/x')).toContain(
      '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );
  });
});

describe('findChromium', () => {
  it('returns the first candidate that exists', () => {
    const found = findChromium('linux', '/h', p => p === '/usr/bin/chromium-browser');
    expect(found).toBe('/usr/bin/chromium-browser');
  });

  it('prefers an earlier candidate when several exist', () => {
    const found = findChromium('linux', '/h', () => true);
    expect(found).toBe('/usr/bin/google-chrome');
  });

  it('returns null when none exists', () => {
    expect(findChromium('darwin', '/h', () => false)).toBeNull();
  });
});

describe('pdfArgs', () => {
  const args = pdfArgs('/tmp/w/doc.html', '/out/doc.pdf', '/tmp/w/profile');

  it('runs headless and prints to the requested path', () => {
    expect(args).toContain('--headless=new');
    expect(args).toContain('--print-to-pdf=/out/doc.pdf');
  });

  // Chrome otherwise stamps the date, the file:// URL and a page count on
  // every page -- fine for a browser printout, wrong for a document to share.
  it('suppresses the browser header and footer', () => {
    expect(args).toContain('--no-pdf-header-footer');
  });

  // A running Chrome holds a lock on the real profile; a headless launch that
  // shared it would silently fail. A throwaway profile sidesteps that and
  // never touches the user's own browser state.
  it('uses a throwaway profile, never the real one', () => {
    expect(args).toContain('--user-data-dir=/tmp/w/profile');
  });

  it('suppresses first-run flows that would replace the print', () => {
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
  });

  it('passes the input as a file URL, last', () => {
    expect(args[args.length - 1]).toBe('file:///tmp/w/doc.html');
  });
});

describe('toFileUrl', () => {
  it('builds a file URL from an absolute POSIX path', () => {
    expect(toFileUrl('/tmp/a/b.html')).toBe('file:///tmp/a/b.html');
  });

  // A space or a `#` in a folder name would otherwise truncate the URL Chrome
  // sees, and it would print a 404 page instead of the document.
  it('percent-encodes characters that would break the URL', () => {
    expect(toFileUrl('/tmp/my docs/a#1.html')).toBe('file:///tmp/my%20docs/a%231.html');
  });

  it('keeps path separators', () => {
    expect(toFileUrl('/a/b/c.html').split('/').length).toBe(6);
  });
});
