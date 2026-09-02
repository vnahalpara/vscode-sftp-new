// Copies the PDF.js assets the built-in PDF viewer needs out of node_modules
// and into media/pdfjs/, where the extension can hand them to a webview.
//
// Run as `npm run build:pdfjs`, and by `vscode:prepublish` so a packaged
// VSIX always carries the assets. media/pdfjs/ is git-ignored: it is a build
// output, and committing ~4.5MB of vendored minified JS would bloat every
// clone for no benefit -- the version is pinned by package.json.
//
// What ships, and why each piece is here:
//   build/pdf.min.mjs          the core (parser, renderer). Publishes
//                              globalThis.pdfjsLib for the viewer module.
//   build/pdf.worker.min.mjs   the parsing worker. Runs off the UI thread,
//                              which is what keeps a 200-page PDF scrollable.
//   web/pdf_viewer.mjs + .css  the viewer component library (PDFViewer,
//                              EventBus, LinkService, FindController).
//   web/images/                cursor/annotation sprites the CSS references.
//   cmaps/                     character maps for CJK and other non-Latin
//                              encodings. Without these a Japanese or
//                              Chinese PDF renders as boxes.
//   standard_fonts/            the 14 standard Type 1 fonts as substitutes,
//                              for PDFs that reference them without
//                              embedding -- common in generated invoices.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'media', 'pdfjs');

const FILES = [
  ['build/pdf.min.mjs', 'pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['web/pdf_viewer.mjs', 'pdf_viewer.mjs'],
  ['web/pdf_viewer.css', 'pdf_viewer.css'],
];
const DIRS = [
  ['web/images', 'images'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(a, b);
    } else {
      fs.copyFileSync(a, b);
    }
  }
}

if (!fs.existsSync(src)) {
  console.error('pdfjs-dist is not installed; run npm install first.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const [from, to] of FILES) {
  fs.copyFileSync(path.join(src, from), path.join(dest, to));
}
for (const [from, to] of DIRS) {
  copyDir(path.join(src, from), path.join(dest, to));
}

const version = require(path.join(src, 'package.json')).version;
fs.writeFileSync(path.join(dest, 'VERSION'), `pdfjs-dist ${version}\n`);
console.log(`media/pdfjs: pdfjs-dist ${version}`);
