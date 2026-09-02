import { execFile } from 'child_process';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

// Where a Chromium-based browser lives on each platform, most-likely first.
//
// Chrome rather than a bundled engine because the alternatives are all worse
// for an extension: Puppeteer downloads ~150MB of Chromium into every install;
// a pure-JS PDF library has to lay HTML out itself and mangles tables and
// code blocks; and VS Code exposes no print-to-PDF API. Every machine that
// already opens this extension's Manage Server dashboard has Chrome, and
// `--headless --print-to-pdf` has shipped in it for years.
//
// Edge and Chromium are included because they run the same engine and the
// flags are identical -- a Windows machine with no Chrome installed almost
// always has Edge.
export function chromiumCandidates(platform: NodeJS.Platform, home: string): string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
    case 'win32': {
      const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
      return [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ];
    }
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
        '/usr/bin/brave-browser',
      ];
  }
}

// `exists` is injected so the search is testable without a filesystem, and so
// a caller can point it at a fake that "finds" a specific candidate.
export function findChromium(
  platform: NodeJS.Platform,
  home: string,
  exists: (p: string) => boolean
): string | null {
  for (const candidate of chromiumCandidates(platform, home)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// The headless print invocation. Each flag is here for a reason:
//
//   --headless=new        the current headless mode; the legacy one is
//                         removed in recent Chrome and prints differently.
//   --disable-gpu         harmless where unneeded, avoids a crash on some
//                         Windows/VM setups where headless GPU init fails.
//   --no-pdf-header-footer   Chrome otherwise stamps the date, the file:// URL
//                         and "1/3" on every page -- fine for a browser
//                         printout, wrong for a document to share.
//   --print-to-pdf=<out>  the whole point.
//   --no-first-run / --no-default-browser-check
//                         stop a machine where Chrome has never launched from
//                         opening a first-run flow instead of printing.
//   --user-data-dir=<tmp> a throwaway profile, so this never touches (or
//                         locks against) the user's real Chrome profile -- a
//                         running Chrome holds a lock on it, and a headless
//                         launch sharing that profile silently fails.
//
// The input is a file:// URL, not stdin: Chrome's print path wants a
// navigable URL, and a temp file is the only portable way to hand it one
// without a server.
export function pdfArgs(htmlPath: string, pdfPath: string, profileDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    toFileUrl(htmlPath),
  ];
}

// A file:// URL that Chrome accepts on every platform. Windows drive paths need
// the leading slash (`file:///C:/...`).
//
// Each path SEGMENT is encoded with encodeURIComponent and the segments are
// rejoined with `/`. Not encodeURI over the whole path: encodeURI leaves
// URL-reserved characters alone by design, and `#` is one of them -- so a
// folder called `notes #1` would produce a URL whose `#1/...` is a FRAGMENT.
// Chrome would load the path before the `#`, find nothing there, and print
// its 404 page as the PDF. A test caught exactly that.
export function toFileUrl(p: string): string {
  const normalised = path.resolve(p).replace(/\\/g, '/');
  const withSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;
  const encoded = withSlash
    .split('/')
    // A Windows drive letter (`C:`) is the one segment that must keep its
    // colon: `file:///C:/...` is the canonical form, and while Chrome does
    // tolerate `%3A` there, other consumers of the URL do not. It can only
    // ever be the first non-empty segment, and only when it is exactly a
    // letter and a colon.
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/');
  return `file://${encoded}`;
}

export interface PdfResult {
  ok: true;
  bytes: number;
}

// Whether the file at `p` is a PDF: present, non-empty, and beginning with the
// `%PDF-` magic every PDF starts with. Reading five bytes is the cheapest
// check that distinguishes a real export from an empty file, a truncated
// write, or an HTML error page that Chrome saved under a .pdf name. Exported
// for its tests; the size cap on the read is so a huge file is not pulled
// into memory to answer a five-byte question.
export function looksLikePdf(p: string): boolean {
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size < 5) {
      return false;
    }
    const fd = fs.openSync(p, 'r');
    try {
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      return head.toString('latin1') === '%PDF-';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Renders `html` to a PDF at `pdfPath` through headless Chrome. Throws with a
// message a user can act on -- naming the missing browser, or Chrome's own
// stderr -- rather than a bare exit code.
//
// Everything temporary (the HTML, the throwaway profile) lives under a
// per-call directory that is removed in a `finally`, including when Chrome
// fails: a leftover profile directory is 10-50MB, and one per failed export
// would accumulate in the user's temp folder indefinitely.
export async function renderPdf(
  html: string,
  pdfPath: string,
  opts: { chromium?: string; timeoutMs?: number } = {}
): Promise<PdfResult> {
  const chromium =
    opts.chromium || findChromium(process.platform, os.homedir(), p => fs.existsSync(p));
  if (!chromium) {
    throw new Error(
      'No Chromium-based browser was found. Converting Markdown to PDF uses Google Chrome, ' +
        'Microsoft Edge or Chromium in headless mode -- install one of them and try again.'
    );
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-md-pdf-'));
  const htmlPath = path.join(work, 'document.html');
  const profileDir = path.join(work, 'profile');
  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    fs.mkdirSync(profileDir);

    await new Promise<void>((resolve, reject) => {
      execFile(
        chromium,
        pdfArgs(htmlPath, pdfPath, profileDir),
        { timeout: opts.timeoutMs || 90000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }
          // A timeout is NOT proof the print failed. Headless Chrome writes
          // the PDF promptly and then, on some machines, hangs on the way out
          // -- a first launch populating a fresh profile, a lingering GPU
          // process, a crash-handler that waits on a socket. A reviewer hit
          // exactly this: the PDF was complete and correct on disk while the
          // process sat at the timeout and the export reported "failed".
          //
          // So on timeout, consult the one thing that actually answers the
          // question -- is there a real PDF where we asked for one? If so,
          // the export succeeded and the process being killed is Chrome's
          // problem, not the user's.
          const timedOut = (error as any).killed === true || /timed out|ETIMEDOUT/i.test(String(error.message));
          if (timedOut && looksLikePdf(pdfPath)) {
            resolve();
            return;
          }
          // Chrome's stderr is noisy even on success (DevTools banners,
          // GPU warnings), so it is only surfaced on failure, and only the
          // tail -- the actionable line is almost always the last one.
          const tail = String(stderr || '')
            .trim()
            .split('\n')
            .slice(-3)
            .join(' ');
          reject(new Error(`${path.basename(chromium)} failed to print the PDF: ${error.message}${tail ? ` -- ${tail}` : ''}`));
        }
      );
    });

    // Chrome can exit 0 without writing anything (a crash in the renderer
    // process is reported by the browser process as success). Do not tell the
    // user a file exists until it is on disk, non-empty, and actually a PDF.
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`${path.basename(chromium)} exited normally but produced no PDF.`);
    }
    if (!looksLikePdf(pdfPath)) {
      fs.unlinkSync(pdfPath);
      throw new Error(`${path.basename(chromium)} produced a file that is not a PDF.`);
    }
    return { ok: true, bytes: fs.statSync(pdfPath).size };
  } finally {
    try {
      // fs-extra rather than fs.rmSync: the latter is Node 14.14+, and this
      // repo pins @types/node at v9.
      fse.removeSync(work);
    } catch {
      /* a temp dir that would not delete is not worth failing the export over */
    }
  }
}
