'use strict';

// Drives the built CSV grid bundle in headless Chrome over the DevTools
// protocol. A webview cannot be driven from a test, but the Chromium it runs
// on can -- the same technique the PDF viewer was verified with.
//
// Run: npm run build:csv && node scripts/verify-csv-grid.js
// Exit code 0 and a screenshot in the temp directory mean the grid renders,
// edits, searches and replaces, and sends the ops the host expects.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media', 'csv');
const HTTP_PORT = 8731;
const CDP_PORT = 9333;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="csv.css"></head>
<body><div id="root"></div>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) { window.__posted.push(message); },
      getState: function () { return undefined; },
      setState: function () {}
    };
  };
</script>
<script src="csv.js"></script>
</body></html>`;

const TABLE = {
  type: 'table',
  revision: 1,
  rows: [
    ['name', 'city', 'note'],
    ['Ada', 'London', 'first'],
    ['Bob', 'Lyon', 'second'],
    ['Cy', 'Berlin', 'third'],
  ],
  delimiter: ',',
  eol: '\n',
  readOnly: false,
};

function chromeCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

function findChrome() {
  const found = chromeCandidates().filter(candidate => fs.existsSync(candidate));
  if (found.length === 0) {
    throw new Error('No Chrome, Edge or Chromium found. Install one and run this again.');
  }
  return found[0];
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((request, response) => {
    const name = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    const file = path.join(dir, path.basename(name));
    if (!fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    response.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message.result);
      }
    });
  }
  send(method, params) {
    this.id += 1;
    const id = this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }
  async click(selector) {
    const box = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    if (!box) {
      throw new Error('no element for ' + selector);
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(box.x),
        y: Math.round(box.y),
        button: 'left',
        clickCount: 1,
      });
    }
    await wait(60);
  }
  async type(text) {
    for (const ch of text.split('')) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await wait(60);
  }
  async press(key, code, windowsVirtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    await wait(80);
  }
}

function check(label, condition, detail) {
  if (!condition) {
    throw new Error('FAILED: ' + label + (detail ? ' -- ' + detail : ''));
  }
  console.log('  ok  ' + label);
}

async function main() {
  if (!fs.existsSync(path.join(MEDIA, 'csv.js'))) {
    throw new Error('media/csv/csv.js is missing. Run `npm run build:csv` first.');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-verify-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-chrome-'));
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.copyFileSync(path.join(MEDIA, 'csv.js'), path.join(dir, 'csv.js'));
  fs.copyFileSync(path.join(MEDIA, 'csv.css'), path.join(dir, 'csv.css'));

  const server = await serve(dir);
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let socket;
  try {
    let targets = [];
    for (let attempt = 0; attempt < 50 && targets.length === 0; attempt += 1) {
      await wait(200);
      try {
        targets = (await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list')).filter(
          t => t.type === 'page'
        );
      } catch (error) {
        targets = [];
      }
    }
    if (targets.length === 0) {
      throw new Error('Chrome never opened a debuggable page.');
    }

    socket = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    const cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/index.html' });
    await wait(1500);

    console.log('the bundle loads and announces itself');
    check(
      'posts ready on load',
      (await cdp.evaluate('window.__posted.map(m => m.type).join(",")')) === 'ready'
    );

    console.log('the table renders');
    await cdp.evaluate(
      'window.postMessage(' + JSON.stringify(TABLE) + ', "*"), window.__posted.length = 0, true'
    );
    await wait(400);
    check(
      'draws three data rows',
      (await cdp.evaluate('document.querySelectorAll(".csv-row").length')) === 3
    );
    check(
      'draws the first row as headers',
      (await cdp.evaluate(
        'Array.from(document.querySelectorAll(".csv-header-label")).map(e => e.textContent).join(",")'
      )) === 'name,city,note'
    );
    check(
      'reports the size and the format',
      (await cdp.evaluate('document.querySelector(".csv-status").textContent')).indexOf(
        'Comma · LF'
      ) !== -1
    );

    console.log('editing a cell');
    await cdp.click('.csv-row:nth-child(1) .csv-cell:nth-child(2)');
    await cdp.type('Zed');
    await cdp.press('Enter', 'Enter', 13);
    const editOp = await cdp.evaluate('JSON.stringify(window.__posted[window.__posted.length - 1])');
    check(
      'sends one setCell op against the current revision',
      editOp ===
        JSON.stringify({
          type: 'op',
          base: 1,
          op: { type: 'setCell', row: 1, col: 0, value: 'Zed' },
        }),
      editOp
    );

    // The grid sends one op at a time and waits for the ack, so the host half
    // of that handshake has to be played back here or nothing else is sent.
    await cdp.evaluate('window.postMessage({ type: "ack", revision: 2 }, "*"), true');
    await wait(150);

    console.log('adding a row');
    await cdp.evaluate('window.__posted.length = 0, true');
    await cdp.click('.csv-toolbar .csv-button');
    const addOp = await cdp.evaluate('JSON.stringify(window.__posted[0])');
    check(
      'sends insertRows at the end against the acked revision',
      addOp ===
        JSON.stringify({ type: 'op', base: 2, op: { type: 'insertRows', at: 4, count: 1 } }),
      addOp
    );
    await cdp.evaluate('window.postMessage({ type: "ack", revision: 3 }, "*"), true');
    await wait(150);

    console.log('searching');
    await cdp.click('.csv-find .csv-text');
    await cdp.type('Lyon');
    await wait(300);
    check(
      'filters to the one matching row',
      (await cdp.evaluate('document.querySelectorAll(".csv-row").length')) === 1
    );
    check(
      'counts the matches',
      (await cdp.evaluate('document.querySelector(".csv-match-count").textContent')) === '1 matching'
    );
    check(
      'highlights the match',
      (await cdp.evaluate('document.querySelectorAll(".csv-match").length')) === 1
    );

    console.log('replacing');
    await cdp.evaluate('window.__posted.length = 0, true');
    await cdp.click('.csv-find .csv-text:nth-of-type(2)');
    await cdp.type('Lisbon');
    await cdp.evaluate(
      `(() => { const buttons = Array.from(document.querySelectorAll('.csv-find .csv-button'));
        buttons.filter(b => b.textContent === 'Replace All')[0].click(); return true; })()`
    );
    await wait(300);
    const replaceOp = await cdp.evaluate('JSON.stringify(window.__posted[0])');
    check(
      'sends one replaceAll op for the whole search',
      replaceOp.indexOf('"type":"replaceAll"') !== -1 &&
        replaceOp.indexOf('"base":3') !== -1 &&
        replaceOp.indexOf('"find":"Lyon"') !== -1 &&
        replaceOp.indexOf('"replace":"Lisbon"') !== -1,
      replaceOp
    );
    check(
      'sends exactly one op for Replace All, not one per cell',
      (await cdp.evaluate('window.__posted.length')) === 1
    );

    // Escape in the search box clears the search. Without this the screenshot
    // below would be of a grid still filtered to a term nothing matches any
    // more -- an empty body, which is no use for the by-eye check.
    console.log('clearing the search');
    await cdp.click('.csv-find .csv-text');
    await cdp.press('Escape', 'Escape', 27);
    await wait(300);
    check(
      'Escape clears the search and brings every row back',
      (await cdp.evaluate('document.querySelectorAll(".csv-row").length')) === 4,
      await cdp.evaluate('document.querySelectorAll(".csv-row").length + " rows"')
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(dir, 'csv-grid.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('\nscreenshot: ' + shotPath);
    console.log('all checks passed');
  } finally {
    if (socket) {
      socket.close();
    }
    chrome.kill('SIGKILL');
    server.close();
  }
}

main().catch(error => {
  console.error(String(error.message || error));
  process.exit(1);
});
