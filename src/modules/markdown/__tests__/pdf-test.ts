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

  // `%` is the one character whose mishandling is silent: a raw `%2F` in a
  // folder name must reach Chrome as `%252F`, or it decodes to a slash and
  // the URL points at a different, nonexistent path.
  it('encodes a literal percent sign so it is not decoded as an escape', () => {
    expect(toFileUrl('/tmp/100%/x.html')).toBe('file:///tmp/100%25/x.html');
  });

  it('percent-encodes unicode', () => {
    expect(toFileUrl('/tmp/café/x.html')).toBe('file:///tmp/caf%C3%A9/x.html');
  });
});

// The Windows branch cannot run through path.resolve on macOS -- resolve would
// treat `C:\\...` as a relative name and prepend the cwd -- so it is exercised
// on the pure transformation that follows resolve, by feeding an already-
// absolute, already-forward-slashed Windows path. What this pins is the
// leading-slash rule: Chrome wants `file:///C:/...` (three slashes), and the
// drive-letter colon must survive encoding as a colon.
describe('toFileUrl on a Windows-shaped path', () => {
  const realResolve = require('path').resolve;
  beforeAll(() => {
    require('path').resolve = (p: string) => p;
  });
  afterAll(() => {
    require('path').resolve = realResolve;
  });

  it('adds the leading slash a drive-letter path needs and keeps the colon', () => {
    expect(toFileUrl('C:\\Users\\x\\doc.html')).toBe('file:///C:/Users/x/doc.html');
  });

  // Only a REAL drive letter keeps its colon. A first segment that merely
  // contains one is a folder name and is encoded like any other.
  it('still encodes a colon that is not a drive letter', () => {
    expect(toFileUrl('/a:b/x.html')).toBe('file:///a%3Ab/x.html');
  });
});

describe('looksLikePdf', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { looksLikePdf } = require('../pdf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looks-like-pdf-'));

  afterAll(() => {
    require('fs-extra').removeSync(dir);
  });

  it('accepts a file that starts with the PDF magic', () => {
    const p = path.join(dir, 'real.pdf');
    fs.writeFileSync(p, '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj');
    expect(looksLikePdf(p)).toBe(true);
  });

  // Chrome can save its own error page under a .pdf name; the magic check is
  // what stops that being reported as a successful export.
  it('rejects an HTML error page saved with a .pdf name', () => {
    const p = path.join(dir, 'fake.pdf');
    fs.writeFileSync(p, '<!doctype html><title>404</title>');
    expect(looksLikePdf(p)).toBe(false);
  });

  it('rejects an empty file and a missing file', () => {
    const p = path.join(dir, 'empty.pdf');
    fs.writeFileSync(p, '');
    expect(looksLikePdf(p)).toBe(false);
    expect(looksLikePdf(path.join(dir, 'nope.pdf'))).toBe(false);
  });

  it('rejects a file shorter than the magic', () => {
    const p = path.join(dir, 'short.pdf');
    fs.writeFileSync(p, '%PD');
    expect(looksLikePdf(p)).toBe(false);
  });
});
