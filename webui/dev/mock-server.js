// Dev-only. Serves the built UI from media/webui with a synthetic API and SSE
// stream, so the interface can be exercised and screenshotted without VS Code
// or a real server. It deliberately mirrors the real payload shapes from
// src/modules/monitor/types.ts, including the nulls.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'media', 'webui');
const PORT = Number(process.env.PORT || 5199);
const CORES = 4;
let tick = 0;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const PROFILE = {
  id: 'devprofile000001',
  name: 'kewlab-cloudways-en248',
  host: '168.144.38.186',
  port: 22,
  username: 'master_swkqjgcbuc',
  protocol: 'sftp',
  remotePath: '/home/master/applications',
  workspace: '/dev/workspace',
  hasVpn: false,
  hasDatabase: true,
};

const FACTS = {
  hostname: '1624335.cloudwaysapps.com',
  prettyName: 'Debian GNU/Linux 12 (bookworm)',
  distroId: 'debian',
  cpuModel: 'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz',
  arch: 'x86_64',
  cores: CORES,
  pageSize: 4096,
  serverEpochMs: Date.now(),
  linux: true,
};

function wave(i, amp, base) {
  return base + Math.sin((tick + i * 7) / 6) * amp + Math.random() * 3;
}

function snapshot() {
  tick++;
  // The very first tick has a null cpu and null rates, exactly like the real
  // collector. Rendering must survive it.
  const first = tick === 1;
  return {
    at: Date.now(),
    cpu: first
      ? null
      : {
          total: Math.max(0, wave(0, 12, 20)),
          cores: Array.from({ length: CORES }, (_, i) => Math.max(0, wave(i, 20, 25))),
          breakdown: { user: 12, system: 6, nice: 0, iowait: 2, steal: 0.4 },
        },
    mem: {
      total: 16_769_552_384,
      used: 5_192_486_912,
      cached: 8_336_318_464,
      free: 3_240_747_008,
      usedPct: 30.96,
      cachedPct: 49.7,
      freePct: 19.3,
      swapTotal: 2_147_483_648,
      swapUsed: 104_857_600,
      swapPct: 4.9,
    },
    load: { one: 0.83, five: 0.5, fifteen: 0.3 },
    uptimeSec: 2040 + tick * 2,
    net: [
      {
        name: 'eth0',
        rxBps: first ? null : Math.max(0, wave(1, 40_000, 60_000)),
        txBps: first ? null : Math.max(0, wave(2, 90_000, 120_000)),
        rxTotal: 79_500_000,
        txTotal: 72_800_000,
        address: '168.144.38.186',
      },
      { name: 'lo', rxBps: first ? null : 100, txBps: first ? null : 100, rxTotal: 1, txTotal: 1 },
    ],
    disks: [
      {
        name: 'vda1',
        readBps: first ? null : 120_000,
        writeBps: first ? null : 340_000,
        readIops: first ? null : 12,
        writeIops: first ? null : 30,
        readLatencyMs: first ? null : 0.4,
        writeLatencyMs: first ? null : 1.2,
        readTotal: 1,
        writeTotal: 2,
      },
    ],
    procs: [
      { pid: 1, startTime: 1, comm: 'node', cpuPct: 141, rssBytes: 700_000_000, threads: 12, user: 'master' },
      { pid: 2, startTime: 2, comm: 'mysqld', cpuPct: 8.4, rssBytes: 1_200_000_000, threads: 40, user: 'mysql' },
      { pid: 3, startTime: 3, comm: 'php-fpm', cpuPct: 3.5, rssBytes: 220_000_000, threads: 1, user: 'www-data' },
      { pid: 4, startTime: 4, comm: 'nginx', cpuPct: null, rssBytes: 30_000_000, threads: 2, user: 'www-data' },
    ],
  };
}

const SLOW = {
  mounts: [
    { device: '/dev/vda1', deviceName: 'vda1', fstype: 'ext4', mount: '/', totalBytes: 252_000_000_000, usedBytes: 12_200_000_000 },
    { device: '/dev/vdb', deviceName: 'vdb', fstype: 'ext4', mount: '/var/log', totalBytes: 340_000_000, usedBytes: 307_600_000 },
  ],
  psRows: [],
  addrs: [{ name: 'eth0', address: '168.144.38.186' }],
};

function state() {
  return {
    id: PROFILE.id,
    profile: PROFILE,
    status: 'online',
    error: null,
    facts: FACTS,
    interval: 2000,
    lastSeen: Date.now(),
  };
}

http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/api/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...state(), capabilities: { services: false, webserver: false, logs: false, terminal: false, database: false } }));
      return;
    }
    if (url === '/api/host') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state()));
      return;
    }
    if (url === '/api/activity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entries: [{ at: Date.now(), label: 'restart nginx', command: 'systemctl restart nginx', code: 0, ms: 412, error: null }] }));
      return;
    }
    if (url === '/api/host/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('state', state());
      const history = [];
      const timer = setInterval(() => {
        const snap = snapshot();
        history.push({ at: snap.at, one: snap.load.one, five: snap.load.five, fifteen: snap.load.fifteen });
        send('tick', { snapshot: snap, history: history.slice(-1800) });
      }, 1000);
      const slowTimer = setInterval(() => send('slow', SLOW), 5000);
      send('slow', SLOW);
      req.on('close', () => {
        clearInterval(timer);
        clearInterval(slowTimer);
      });
      return;
    }

    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mock UI server on http://127.0.0.1:${PORT}/?t=dev`);
  });
