// Dev-only. Serves the built UI from media/webui with a synthetic API and SSE
// stream, so the interface can be exercised and screenshotted without VS Code
// or a real server. It deliberately mirrors the real payload shapes from
// src/modules/monitor/types.ts, including the nulls, plus the Services and
// Web server tabs' shapes from src/modules/serverManager/{routes,ops/services,
// ops/webserver}.ts.
//
// The fixtures here are deliberately awkward, not tidy: a failed unit, a
// not-found unit, a templated `@` unit, multi-space descriptions, a
// certificate 5 days from expiry, a certificate that fails to parse, a
// certificate we never even attempted to inspect, and a `?fail=sudo` /
// `?fail=1` escape hatch on the mutating endpoints so the sudo-hint path is
// something a human can actually look at in a browser, not just pin in a
// unit test.
//
// Cloudflare card fail modes: `?fail=cf` fails BOTH Cloudflare routes (the
// zone lookup errors, so the card renders its zone-error banner with Retry,
// and the purge falls back to the zone id in its confirmation);
// `?fail=cfpurge` lets the zone read succeed and fails only the purge, which
// is the far more common real failure and the only way to see the purge
// result banner's error state.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..', '..', 'media', 'webui');
const PORT = Number(process.env.PORT || 5199);
// 16, not 4: 4 sits exactly on SERIES' colour-cycle boundary (SERIES has 4
// slots), so a 4-core mock could never show the per-core chart's old
// cycle-at-4 bug — the smallest case hid it from the visual review pass that
// approved that milestone. 16 forces any regression back to per-slot cycling
// to be visible again.
const CORES = 16;
let tick = 0;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Every identity below is deliberately fake. This fixture once carried a real
// server's name, IP and hostname, copied from a live profile -- which made a
// screenshot of the mock indistinguishable from a screenshot of production,
// right down to a "restart nginx" confirm dialog naming a real host. The
// addresses here are reserved: 192.0.2.0/24 is TEST-NET-1 (RFC 5737) and
// .invalid is reserved (RFC 6761), so neither can ever resolve to a real
// machine. Keep it that way -- never reseed this from a real profile.
const PROFILE = {
  id: 'devprofile000001',
  name: 'mock-fixture-host',
  host: '192.0.2.1',
  port: 22,
  username: 'mockuser',
  protocol: 'sftp',
  remotePath: '/home/master/applications',
  workspace: '/dev/workspace',
  hasVpn: false,
  hasDatabase: true,
  // Gates the Task 3 Cloudflare card the same way RedactedProfile.hasCloudflare
  // gates it for real (registry.ts) -- both CLOUDFLARE_ZONE_ID and
  // CLOUDFLARE_API_TOKEN present on the profile, never surfaced as anything
  // but this boolean. Toggle to `false` only to screenshot the card's absence,
  // then revert -- see this file's own fake-identity discipline above.
  hasCloudflare: true,
  // Matches CF_ZONE.id below. The card falls back to this for its
  // confirmation copy whenever the zone-name lookup failed, so `?fail=cf`
  // must have something to render here -- that is the point of the field
  // (registry.ts). A zone id is identity, not a credential, but this one is
  // still fake; see the fixture discipline above.
  cloudflareZoneId: 'zone123',
};

const FACTS = {
  hostname: 'mock-fixture-host.invalid',
  prettyName: 'Debian GNU/Linux 12 (bookworm)',
  distroId: 'debian',
  cpuModel: 'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz',
  arch: 'x86_64',
  cores: CORES,
  pageSize: 4096,
  serverEpochMs: Date.now(),
  linux: true,
};

// Mirrors routes.ts's CAPABILITIES now that Tasks 1-5 have wired the seven
// routes up for real — a mock that still greyed these out would make Tasks 7
// and 8 unbuildable against it. `logs: true` here is this mock's own dev
// fixture flag, not src/modules/serverManager/routes.ts's real
// CAPABILITIES.logs (still false there until that route wiring lands for
// real — see routes.ts's own comment) — flipping THIS one is what lets the
// Logs tab actually be exercised against the mock.
//
// `database: true` is the same kind of ahead-of-real flip: the DB routes and
// this Task 8 UI are both done, but routes.ts's own CAPABILITIES.database
// flip is a separate one-line change owned by someone else. Flipping THIS
// one is what lets the Database tab actually be exercised against the mock
// in the meantime — see the Database section below for its fixtures.
const CAPABILITIES = { services: true, webserver: true, logs: true, terminal: true, database: true };

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
        address: '192.0.2.1',
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
  addrs: [{ name: 'eth0', address: '192.0.2.1' }],
};

function state(status) {
  return {
    id: PROFILE.id,
    profile: PROFILE,
    status: status || 'online',
    error: null,
    facts: FACTS,
    interval: 2000,
    lastSeen: Date.now(),
  };
}

/* ------------------------------------------------------------- services -- */
// Shaped exactly like ServiceRow (src/modules/serverManager/ops/services.ts)
// — this mock returns already-merged/sorted rows, not raw systemctl text,
// because /api/services is the one place the real route does the
// list-units/list-unit-files merge itself before the client ever sees it.
//
// Sorted the same way sortServices does: active first, then failed, then
// everything else, alphabetical within each group — so the failed unit an
// operator opened this tab to find lands at the top, same as production.
const SERVICES_RAW = [
  { unit: 'apache2.service', name: 'apache2', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'The Apache HTTP Server' },
  { unit: 'cron.service', name: 'cron', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'Regular   background program processing daemon' },
  { unit: 'fail2ban.service', name: 'fail2ban', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'Fail2Ban Service' },
  { unit: 'memcached.service', name: 'memcached', load: 'loaded', active: 'active', sub: 'running', enabled: 'disabled', description: 'memcached daemon' },
  { unit: 'mysql.service', name: 'mysql', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'MySQL Community Server' },
  { unit: 'nginx.service', name: 'nginx', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'A high performance web server and reverse proxy server' },
  {
    unit: 'php8.2-fpm@www.service',
    name: 'php8.2-fpm@www',
    load: 'loaded',
    active: 'active',
    sub: 'running',
    enabled: 'enabled',
    description: 'The PHP 8.2 FastCGI Process Manager (www pool)',
  },
  { unit: 'postfix.service', name: 'postfix', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'Postfix Mail Transport Agent' },
  { unit: 'rsyslog.service', name: 'rsyslog', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', description: 'System Logging Service' },
  // The one an operator opened this tab to find. Sorts to the top.
  { unit: 'sshd.service', name: 'sshd', load: 'loaded', active: 'failed', sub: 'failed', enabled: 'enabled', description: 'OpenSSH server daemon' },
  { unit: 'redis-server.service', name: 'redis-server', load: 'loaded', active: 'inactive', sub: 'dead', enabled: 'disabled', description: 'Advanced key-value store' },
  // A unit file that has vanished (an old transient/generated unit) but
  // systemd still reports a stub line for it — no description, no unit file
  // entry to merge an `enabled` state from.
  { unit: 'bogus.service', name: 'bogus', load: 'not-found', active: 'inactive', sub: 'dead', enabled: 'unknown', description: '-' },
];

function activeRank(row) {
  if (row.active === 'active') {
    return 0;
  }
  if (row.active === 'failed') {
    return 1;
  }
  return 2;
}

const SERVICES = SERVICES_RAW.slice().sort((a, b) => {
  const rankDiff = activeRank(a) - activeRank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
});

function findService(unit) {
  return SERVICES.find(row => row.unit === unit) || {
    unit,
    name: unit.replace(/\.service$/, ''),
    load: 'loaded',
    active: 'active',
    sub: 'running',
    enabled: 'enabled',
    description: 'Unknown unit',
  };
}

function sudoHintText() {
  const user = PROFILE.username;
  const host = PROFILE.host;
  return (
    `${user}@${host} cannot run this command with sudo without a password. ` +
    `Add a sudoers rule on ${host}, for example: ` +
    `${user} ALL=(ALL) NOPASSWD: /bin/systemctl, /usr/sbin/nginx, /usr/sbin/apache2ctl`
  );
}

// Systemctl mutations are usually silent on success — that IS the realistic
// output for most of these. nginx gets a daemon-reload warning instead, so
// Task 7 also has to render a non-empty success output at least once.
function serviceActionOutput(unit, action) {
  if (unit === 'nginx.service' && (action === 'restart' || action === 'reload-or-restart')) {
    return 'Warning: The unit file, source configuration file, or drop-ins of nginx.service changed on disk. Run \'systemctl daemon-reload\' to reload units.';
  }
  return '';
}

function genericActionFailure(unit, action) {
  return (
    `Job for ${unit} failed because the control process exited with error code.\n` +
    `See "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.`
  );
}

function serviceStatusText(unit) {
  const row = findService(unit);
  const bullet = row.active === 'failed' ? '●' : row.active === 'active' ? '●' : '○';
  const loadedLine = `     Loaded: ${row.load} (/lib/systemd/system/${unit}; ${row.enabled}; vendor preset: enabled)`;

  if (row.active === 'failed') {
    return [
      `${bullet} ${unit} - ${row.description}`,
      loadedLine,
      '     Active: failed (Result: exit-code) since Sun 2026-08-17 04:12:09 UTC; 1min 8s ago',
      '       Docs: man:sshd(8)',
      '             man:sshd_config(5)',
      '    Process: 1188 ExecStartPre=/usr/sbin/sshd -t (code=exited, status=1/FAILURE)',
      '   Main PID: 1188 (code=exited, status=1/FAILURE)',
      '',
      'Aug 17 04:12:09 mock-fixture-host sshd[1188]: /etc/ssh/sshd_config line 42: Bad configuration option: PermitRootLogins',
      'Aug 17 04:12:09 mock-fixture-host systemd[1]: sshd.service: Control process exited, code=exited, status=1/FAILURE',
      'Aug 17 04:12:09 mock-fixture-host systemd[1]: sshd.service: Failed with result \'exit-code\'.',
      'Aug 17 04:12:09 mock-fixture-host systemd[1]: Failed to start OpenSSH server daemon.',
    ].join('\n');
  }

  if (row.active === 'inactive' && row.load !== 'not-found') {
    return [
      `○ ${unit} - ${row.description}`,
      loadedLine,
      '     Active: inactive (dead) since Sat 2026-08-16 22:03:41 UTC; 6h ago',
      '',
      'Aug 16 22:03:41 mock-fixture-host systemd[1]: Stopped Advanced key-value store.',
    ].join('\n');
  }

  if (row.load === 'not-found') {
    return `Unit ${unit} could not be found.`;
  }

  return [
    `${bullet} ${unit} - ${row.description}`,
    loadedLine,
    '     Active: active (running) since Wed 2026-08-12 03:14:22 UTC; 5 days ago',
    '   Main PID: 845 (' + row.name.split('@')[0] + ')',
    '      Tasks: 3 (limit: 4665)',
    '     Memory: 5.7M',
    '        CPU: 812ms',
    `     CGroup: /system.slice/${unit}`,
    `             └─845 ${row.name.split('@')[0]}`,
    '',
    `Aug 17 09:00:01 mock-fixture-host systemd[1]: Started ${row.description}.`,
  ].join('\n');
}

/* ----------------------------------------------------------- web server -- */
// Shaped like parseDetect()'s return in ops/webserver.ts: both nginx and
// apache detected, each with its own unit/version/active/enabled, plus the
// raw `listening` lines a vhost tab would show under "ports in use".
const WEBSERVER_DETECT = {
  servers: [
    { kind: 'nginx', unit: 'nginx', version: 'nginx version: nginx/1.18.0 (Ubuntu)', active: 'active', enabled: 'enabled' },
    { kind: 'apache', unit: 'apache2', version: 'Server version: Apache/2.4.41 (Ubuntu)', active: 'active', enabled: 'disabled' },
  ],
  listening: [
    'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=845,fd=6))',
    'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=845,fd=7))',
    'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("apache2",pid=1032,fd=4))',
  ],
};

/* ------------------------------------------------------------ cloudflare -- */
// Shaped like GET /api/cloudflare/zone's 200 body -- `{ id, name }`, the
// return type of ops/cloudflare.ts's zoneInfo(). `zone123` and the
// `.invalid` hostname keep this fixture inside the same reserved-namespace
// discipline as the rest of this file (see the header comment): a zone id
// is never a secret the way CLOUDFLARE_API_TOKEN is, but it is still real
// infrastructure identity, so it stays fake here too.
const CF_ZONE = { id: 'zone123', name: 'mock-fixture-host.invalid' };

// The `?fail=cf` text for both Cloudflare routes -- shaped like
// cloudflareError()'s own fixed-vocabulary output (ops/cloudflare.ts), never
// anything resembling a raw Cloudflare response body or a token. Distinct
// per route only so a screenshot of either failure state is recognisably
// about the request that produced it.
const CF_ZONE_FAILURE = 'Cloudflare zone not found -- check CLOUDFLARE_ZONE_ID. [Cloudflare error 1001]';
const CF_PURGE_FAILURE =
  'Cloudflare rejected the request: the CLOUDFLARE_API_TOKEN is invalid or lacks a required ' +
  'permission. Reading the zone name needs Zone > Zone > Read; purging needs Zone > Cache Purge. ' +
  '[Cloudflare error 10000]';

// `?fail=cfpurge` -- the zone reads fine, the PURGE fails. This is the
// combination a real user hits most: Cloudflare rate-limits purge_everything
// far harder than it rate-limits a zone read, so a 429 on purge with a
// perfectly healthy zone lookup is the ordinary failure, not an exotic one.
// `?fail=cf` cannot reach it -- it fails both routes, and with the zone
// erroring the purge-failure banner is a state you have to get to another
// way. Kept as its own mode rather than folded into `?fail=cf` so both
// states stay screenshot-able.
const CF_PURGE_RATE_LIMIT_FAILURE =
  'Cloudflare rate limited this request. Cloudflare limits purge_everything far more tightly than ' +
  'targeted purges, so this can happen even under light use. [Cloudflare error 10000]';

// `daysFromNow` is computed against wall-clock time at request time (plus a
// half-day buffer so a slow request never rounds down a day), not a fixed
// calendar date — so the 44-day and 5-day fixtures stay exactly 44 and 5
// days out no matter when this dev server happens to be started.
function certEntry(certPath, daysFromNow, subject, issuer) {
  const expires = new Date(Date.now() + daysFromNow * 86400000 + 12 * 3600000);
  return {
    path: certPath,
    expires: expires.toISOString(),
    daysLeft: daysFromNow,
    subject,
    issuer,
    error: null,
  };
}

const NGINX_VHOSTS = [
  {
    file: '/etc/nginx/sites-enabled/example.conf',
    serverName: 'example.com',
    aliases: null,
    listen: ['80'],
    ssl: false,
    root: '/var/www/example',
    certificate: null,
    accessLog: '/var/log/nginx/example-access.log',
    errorLog: '/var/log/nginx/example-error.log',
    proxyPass: null,
  },
  {
    file: '/etc/nginx/sites-enabled/secure.conf',
    serverName: 'secure.example.com',
    aliases: null,
    listen: ['443 ssl http2'],
    ssl: true,
    root: '/var/www/secure',
    certificate: '/etc/ssl/certs/secure.example.com.pem',
    accessLog: '/var/log/nginx/secure-access.log',
    errorLog: '/var/log/nginx/secure-error.log',
    proxyPass: null,
  },
  // The one the warning tone exists for.
  {
    file: '/etc/nginx/sites-enabled/urgent.conf',
    serverName: 'urgent.example.com',
    aliases: null,
    listen: ['443 ssl'],
    ssl: true,
    root: '/var/www/urgent',
    certificate: '/etc/ssl/certs/urgent.example.com.pem',
    accessLog: '/var/log/nginx/urgent-access.log',
    errorLog: '/var/log/nginx/urgent-error.log',
    proxyPass: null,
  },
  {
    file: '/etc/nginx/sites-enabled/api.conf',
    serverName: 'api.example.com',
    aliases: null,
    listen: ['80'],
    ssl: false,
    root: null,
    certificate: null,
    accessLog: '/var/log/nginx/api-access.log',
    errorLog: '/var/log/nginx/api-error.log',
    proxyPass: 'http://127.0.0.1:4000',
  },
  // A certificate that is present but fails to parse — a different failure
  // shape from "never inspected at all" (see legacy.conf below).
  {
    file: '/etc/nginx/sites-enabled/broken-cert.conf',
    serverName: 'broken.example.com',
    aliases: null,
    listen: ['443 ssl'],
    ssl: true,
    root: '/var/www/broken',
    certificate: '/etc/ssl/certs/broken.example.com.pem',
    accessLog: '/var/log/nginx/broken-access.log',
    errorLog: '/var/log/nginx/broken-error.log',
    proxyPass: null,
  },
  // A certificate we never even attempted to inspect (e.g. sudo failed
  // partway, or the path itself was rejected) — lands in `skipped`, not
  // `certificates`.
  {
    file: '/etc/nginx/sites-enabled/legacy.conf',
    serverName: 'legacy.example.com',
    aliases: null,
    listen: ['443 ssl'],
    ssl: true,
    root: '/var/www/legacy',
    certificate: '/etc/ssl/private/legacy-nopermission.pem',
    accessLog: '/var/log/nginx/legacy-access.log',
    errorLog: '/var/log/nginx/legacy-error.log',
    proxyPass: null,
  },
];

const NGINX_CERTIFICATES = [
  certEntry('/etc/ssl/certs/secure.example.com.pem', 44, 'CN = secure.example.com', 'CN = R3'),
  certEntry('/etc/ssl/certs/urgent.example.com.pem', 5, 'CN = urgent.example.com', 'CN = R3'),
  {
    path: '/etc/ssl/certs/broken.example.com.pem',
    expires: null,
    daysLeft: null,
    subject: null,
    issuer: null,
    error:
      'unable to load certificate\n' +
      "140245123456:error:0909006C:PEM routines:get_name:no start line:pem_lib.c:745:Expecting: TRUSTED CERTIFICATE",
  },
];
const NGINX_SKIPPED = ['/etc/ssl/private/legacy-nopermission.pem'];

const APACHE_VHOSTS = [
  {
    file: '/etc/apache2/sites-enabled/example.conf',
    serverName: 'example.com',
    aliases: 'www.example.com',
    listen: ['*:80'],
    ssl: false,
    root: '/var/www/example',
    certificate: null,
    accessLog: '/var/log/apache2/example-access.log combined',
    errorLog: '/var/log/apache2/example-error.log',
    proxyPass: '/api http://127.0.0.1:4000/',
  },
  {
    file: '/etc/apache2/sites-enabled/secure.conf',
    serverName: 'secure.example.com',
    aliases: null,
    listen: ['*:443'],
    ssl: true,
    root: '/var/www/secure',
    certificate: '/etc/ssl/certs/apache-secure.example.com.pem',
    accessLog: '/var/log/apache2/secure-access.log combined',
    errorLog: '/var/log/apache2/secure-error.log',
    proxyPass: null,
  },
  {
    file: '/etc/apache2/sites-enabled/urgent.conf',
    serverName: 'urgent-apache.example.com',
    aliases: null,
    listen: ['*:443'],
    ssl: true,
    root: '/var/www/urgent-apache',
    certificate: '/etc/ssl/certs/apache-urgent.example.com.pem',
    accessLog: '/var/log/apache2/urgent-access.log combined',
    errorLog: '/var/log/apache2/urgent-error.log',
    proxyPass: null,
  },
  {
    file: '/etc/apache2/sites-enabled/api.conf',
    serverName: 'api-apache.example.com',
    aliases: null,
    listen: ['*:80'],
    ssl: false,
    root: null,
    certificate: null,
    accessLog: '/var/log/apache2/api-access.log combined',
    errorLog: '/var/log/apache2/api-error.log',
    proxyPass: '/ http://127.0.0.1:5000/',
  },
  {
    file: '/etc/apache2/sites-enabled/legacy.conf',
    serverName: 'legacy-apache.example.com',
    aliases: null,
    listen: ['*:443'],
    ssl: true,
    root: '/var/www/legacy-apache',
    certificate: '/etc/ssl/private/apache-legacy-nopermission.pem',
    accessLog: '/var/log/apache2/legacy-access.log combined',
    errorLog: '/var/log/apache2/legacy-error.log',
    proxyPass: null,
  },
];

const APACHE_CERTIFICATES = [
  certEntry('/etc/ssl/certs/apache-secure.example.com.pem', 44, 'CN = secure.example.com', 'CN = R3'),
  certEntry('/etc/ssl/certs/apache-urgent.example.com.pem', 5, 'CN = urgent-apache.example.com', 'CN = R3'),
];
const APACHE_SKIPPED = ['/etc/ssl/private/apache-legacy-nopermission.pem'];

// GET /api/file content, keyed by every path a vhost listing above hands
// back — the vhost "View" button only ever asks for a path it was just
// shown.
const FILE_CONTENTS = {
  '/etc/nginx/sites-enabled/example.conf': [
    'server {',
    '    listen 80;',
    '    server_name example.com;',
    '    root /var/www/example;',
    '',
    '    access_log /var/log/nginx/example-access.log;',
    '    error_log /var/log/nginx/example-error.log;',
    '',
    '    location / {',
    '        try_files $uri $uri/ =404;',
    '    }',
    '}',
  ].join('\n'),
  '/etc/nginx/sites-enabled/secure.conf': [
    'server {',
    '    listen 443 ssl http2;',
    '    server_name secure.example.com;',
    '    root /var/www/secure;',
    '',
    '    ssl_certificate /etc/ssl/certs/secure.example.com.pem;',
    '    ssl_certificate_key /etc/ssl/private/secure.example.com.key;',
    '',
    '    access_log /var/log/nginx/secure-access.log;',
    '    error_log /var/log/nginx/secure-error.log;',
    '}',
  ].join('\n'),
  '/etc/nginx/sites-enabled/urgent.conf': [
    'server {',
    '    listen 443 ssl;',
    '    server_name urgent.example.com;',
    '    root /var/www/urgent;',
    '',
    '    ssl_certificate /etc/ssl/certs/urgent.example.com.pem;',
    '    ssl_certificate_key /etc/ssl/private/urgent.example.com.key;',
    '',
    '    access_log /var/log/nginx/urgent-access.log;',
    '    error_log /var/log/nginx/urgent-error.log;',
    '}',
  ].join('\n'),
  '/etc/nginx/sites-enabled/api.conf': [
    'server {',
    '    listen 80;',
    '    server_name api.example.com;',
    '',
    '    access_log /var/log/nginx/api-access.log;',
    '    error_log /var/log/nginx/api-error.log;',
    '',
    '    location / {',
    '        proxy_pass http://127.0.0.1:4000;',
    '        proxy_set_header Host $host;',
    '    }',
    '}',
  ].join('\n'),
  '/etc/nginx/sites-enabled/broken-cert.conf': [
    'server {',
    '    listen 443 ssl;',
    '    server_name broken.example.com;',
    '    root /var/www/broken;',
    '',
    '    ssl_certificate /etc/ssl/certs/broken.example.com.pem;',
    '    ssl_certificate_key /etc/ssl/private/broken.example.com.key;',
    '}',
  ].join('\n'),
  '/etc/nginx/sites-enabled/legacy.conf': [
    'server {',
    '    listen 443 ssl;',
    '    server_name legacy.example.com;',
    '    root /var/www/legacy;',
    '',
    '    ssl_certificate /etc/ssl/private/legacy-nopermission.pem;',
    '    ssl_certificate_key /etc/ssl/private/legacy-nopermission.key;',
    '}',
  ].join('\n'),
  '/etc/apache2/sites-enabled/example.conf': [
    '<VirtualHost *:80>',
    '    ServerName example.com',
    '    ServerAlias www.example.com',
    '    DocumentRoot /var/www/example',
    '    ProxyPass /api http://127.0.0.1:4000/',
    '    CustomLog /var/log/apache2/example-access.log combined',
    '    ErrorLog /var/log/apache2/example-error.log',
    '</VirtualHost>',
  ].join('\n'),
  '/etc/apache2/sites-enabled/secure.conf': [
    '<VirtualHost *:443>',
    '    ServerName secure.example.com',
    '    DocumentRoot /var/www/secure',
    '    SSLEngine on',
    '    SSLCertificateFile /etc/ssl/certs/apache-secure.example.com.pem',
    '    CustomLog /var/log/apache2/secure-access.log combined',
    '    ErrorLog /var/log/apache2/secure-error.log',
    '</VirtualHost>',
  ].join('\n'),
  '/etc/apache2/sites-enabled/urgent.conf': [
    '<VirtualHost *:443>',
    '    ServerName urgent-apache.example.com',
    '    DocumentRoot /var/www/urgent-apache',
    '    SSLEngine on',
    '    SSLCertificateFile /etc/ssl/certs/apache-urgent.example.com.pem',
    '    CustomLog /var/log/apache2/urgent-access.log combined',
    '    ErrorLog /var/log/apache2/urgent-error.log',
    '</VirtualHost>',
  ].join('\n'),
  '/etc/apache2/sites-enabled/api.conf': [
    '<VirtualHost *:80>',
    '    ServerName api-apache.example.com',
    '    ProxyPass / http://127.0.0.1:5000/',
    '    ProxyPassReverse / http://127.0.0.1:5000/',
    '    CustomLog /var/log/apache2/api-access.log combined',
    '    ErrorLog /var/log/apache2/api-error.log',
    '</VirtualHost>',
  ].join('\n'),
  '/etc/apache2/sites-enabled/legacy.conf': [
    '<VirtualHost *:443>',
    '    ServerName legacy-apache.example.com',
    '    DocumentRoot /var/www/legacy-apache',
    '    SSLEngine on',
    '    SSLCertificateFile /etc/ssl/private/apache-legacy-nopermission.pem',
    '    CustomLog /var/log/apache2/legacy-access.log combined',
    '    ErrorLog /var/log/apache2/legacy-error.log',
    '</VirtualHost>',
  ].join('\n'),
};

/* ------------------------------------------------------------------ logs -- */
// Shaped like GET /api/logs's response (routes.ts): { files: LogFile[],
// units: string[] }, LogFile = { path, bytes: number | null } (ops/logs.ts).
// Deliberately awkward, matching this file's own stated fixture philosophy
// (see the header comment): a null byte size (stat raced a logrotate rename
// -- see logDiscoveryCommand's own comment on that exact race), a genuine
// zero-byte file, a rotated log, a rotated-AND-compressed log, and a binary
// login-accounting log (`wtmp`) that `tail`/`sed` render as garbage --
// exactly the shapes Task 7's picker has to deprioritise rather than
// present as ordinary tailable text.
const LOG_FILES = [
  { path: '/var/log/syslog', bytes: 2_384_912 },
  { path: '/var/log/auth.log', bytes: 184_204 },
  { path: '/var/log/nginx/access.log', bytes: 942_112 },
  // Genuinely empty -- must render "0 B", never the em dash `bytes: null`
  // gets. See format.ts's fmtBytes / the Task 7 brief's hard requirement 3.
  { path: '/var/log/nginx/error.log', bytes: 0 },
  // `stat` raced `logrotate` between `find` listing this file and
  // `stat -c%s` reading it -- `sz` came back empty, so this is `null`, not
  // `0`. Must render as an em dash, never `0`.
  { path: '/var/log/mysql/slow-query.log', bytes: null },
  // Rotated.
  { path: '/var/log/syslog.1', bytes: 1_884_002 },
  // Rotated AND compressed.
  { path: '/var/log/syslog.2.gz', bytes: 384_213 },
  // Binary login-accounting log.
  { path: '/var/log/wtmp', bytes: 292_872 },
];

const LOG_UNITS = ['ssh.service', 'nginx.service', 'cron.service'];

// GET /api/file content for the LOG_FILES paths above, merged into the
// existing /api/file handler alongside FILE_CONTENTS (the vhost config
// viewer's own map) below. readFileCommand (ops/command.ts) is
// `sed -n '1,Np'` -- the FIRST N lines of the file, not the last N -- so
// this is written head-first, matching what a real host actually returns
// from this route (Task 7's snapshot view), not what the name "tail" would
// suggest. See the Task 7 report for that conflict between the brief's
// wording and the route's real behaviour.
const LOG_FILE_CONTENTS = {
  '/var/log/syslog': [
    'Aug 17 08:58:01 mock-fixture-host CRON[1401]: (root) CMD (/usr/lib/php/sessionclean)',
    'Aug 17 08:59:12 mock-fixture-host systemd[1]: Starting Daily apt download activities...',
    'Aug 17 08:59:14 mock-fixture-host systemd[1]: apt-daily.service: Deactivated successfully.',
    'Aug 17 09:00:01 mock-fixture-host CRON[1522]: (mysql) CMD (/etc/mysql/debian-start.sh)',
    'Aug 17 09:00:03 mock-fixture-host sshd[1601]: Accepted publickey for mockuser from 192.0.2.44 port 51422 ssh2',
    'Aug 17 09:00:03 mock-fixture-host sshd[1601]: pam_unix(sshd:session): session opened for user mockuser',
    'Aug 17 09:01:47 mock-fixture-host kernel: [123456.789012] eth0: link becomes ready',
    'Aug 17 09:02:10 mock-fixture-host systemd[1]: Started Session 42 of user mockuser.',
  ].join('\n'),
  '/var/log/auth.log': [
    'Aug 17 09:00:03 mock-fixture-host sshd[1601]: Accepted publickey for mockuser from 192.0.2.44 port 51422 ssh2',
    'Aug 17 09:00:03 mock-fixture-host sshd[1601]: pam_unix(sshd:session): session opened for user mockuser by (uid=0)',
    'Aug 17 08:41:19 mock-fixture-host sudo: mockuser : TTY=pts/0 ; PWD=/home/mockuser ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx',
    'Aug 17 08:12:07 mock-fixture-host sshd[1188]: Failed password for invalid user admin from 192.0.2.77 port 40110 ssh2',
    'Aug 17 08:12:11 mock-fixture-host sshd[1188]: Connection closed by invalid user admin 192.0.2.77 port 40110 [preauth]',
  ].join('\n'),
  '/var/log/nginx/access.log': [
    '192.0.2.10 - - [17/Aug/2026:09:00:01 +0000] "GET / HTTP/1.1" 200 1843',
    '192.0.2.11 - - [17/Aug/2026:09:00:02 +0000] "GET /api/status HTTP/1.1" 200 87',
    '192.0.2.12 - - [17/Aug/2026:09:00:04 +0000] "GET /favicon.ico HTTP/1.1" 404 571',
    '192.0.2.13 - - [17/Aug/2026:09:00:06 +0000] "POST /api/login HTTP/1.1" 401 112',
    '192.0.2.14 - - [17/Aug/2026:09:00:09 +0000] "GET /health HTTP/1.1" 200 15',
  ].join('\n'),
  // Genuinely empty.
  '/var/log/nginx/error.log': '',
  '/var/log/mysql/slow-query.log': [
    '# Time: 2026-08-17T08:41:03.112233Z',
    '# User@Host: appuser[appuser] @ localhost []',
    '# Query_time: 4.812340  Lock_time: 0.000102 Rows_sent: 1  Rows_examined: 890213',
    'SELECT * FROM orders WHERE customer_id = 44201 ORDER BY created_at DESC;',
  ].join('\n'),
  '/var/log/syslog.1': [
    'Aug 16 23:58:41 mock-fixture-host systemd[1]: Starting Daily apt-get upgrade and clean activities...',
    'Aug 16 23:59:02 mock-fixture-host systemd[1]: apt-daily-upgrade.service: Deactivated successfully.',
    'Aug 17 00:00:01 mock-fixture-host CRON[998]: (root) CMD (/usr/lib/php/sessionclean)',
  ].join('\n'),
  // Rotated AND gzip-compressed -- a real `sed -n '1,Np'` against a `.gz`
  // file emits the compressed bytes verbatim, not decompressed text. This
  // string is not meant to be a byte-exact gzip stream, only to visibly NOT
  // look like a log line, the same way real compressed-log garbage doesn't.
  '/var/log/syslog.2.gz': '\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03\x8d\x91\x4dN\x830\x10\x86\xef\x00\x00\xecY\xf3\x1a\x00\x00\xb1\x8c',
  // Binary login-accounting log -- same reasoning as the `.gz` entry above.
  '/var/log/wtmp': '\x00\x00\x00\x02\x00\x00tty1\x00\x00\x00\x00reboot\x00\x00\x00\x00system boot  5.15.0-91-generic\x00\x00\x00\x00',
};

const LOG_FOLLOW_REFUSAL = 'That file was not returned by a log discovery scan for this session.';

let logSeq = 0;

// "Aug 17 09:03:41"-shaped -- close enough to syslog's own timestamp format
// for a dev fixture, not trying to be byte-exact.
function syslogStamp() {
  return new Date().toString().slice(4, 24).replace(/ \d{4}$/, '');
}

function nextSyslogLine() {
  logSeq++;
  const procs = ['CRON', 'systemd', 'sshd', 'kernel'];
  const proc = procs[logSeq % procs.length];
  return `${syslogStamp()} mock-fixture-host ${proc}[${1000 + (logSeq % 500)}]: tick ${logSeq}`;
}

function nextAccessLine() {
  logSeq++;
  const paths = ['/', '/health', '/api/status', '/favicon.ico'];
  const p = paths[logSeq % paths.length];
  return `192.0.2.${1 + (logSeq % 200)} - - [${new Date().toISOString()}] "GET ${p} HTTP/1.1" 200 ${100 + (logSeq % 900)}`;
}

function nextJournalLine(unit) {
  logSeq++;
  return `${syslogStamp()} mock-fixture-host ${unit.replace(/\.service$/, '')}[${2000 + (logSeq % 500)}]: heartbeat ${logSeq}`;
}

// nginx's access.log is deliberately the "busy" fixture here -- fast enough
// (every 4ms) that Task 7's client-side buffer cap (2000 rendered lines) is
// reachable within a few seconds of Follow, the same way a real
// high-traffic access log would exhaust it in practice. Every other file
// and unit follows at a pace a human can actually watch scroll.
const FOLLOW_INTERVAL_MS = {
  '/var/log/nginx/access.log': 4,
};

// A dev-only twin of logFollow.ts's bridge (see handleTerminalSocket above
// for the same pattern on /ws/terminal): streams synthetic lines for a
// requested `path=`/`unit=`, and honours the SAME two-code close convention
// (1000 clean stop, 1011 any failure, with a reason) logFollow.ts's own
// teardown() uses, so Terminal.jsx's/Logs.jsx's close-code handling is
// exercised identically against either mock.
//
// `?fail=` on the socket URL mirrors this file's existing convention
// (handleTerminalSocket's `?fail=1`, the HTTP routes' `?fail=sudo`), so
// every failure/refusal shape is reachable without editing this file:
//   `fail=refuse` -- the exact "not in this session's allowlist" reason
//                    logFollow.ts's buildCommand refuses an unauthorized
//                    path with (routes.ts's isLogPathAllowed check).
//   `fail=unit`   -- the exact "Unsafe unit name." refusal.
//   any other truthy `fail` -- a generic 1011 failure.
// With no `fail`, a path/unit not in LOG_FILES/LOG_UNITS is refused the
// same way a real stale/forged request would be -- the picker itself never
// offers such a target, so reaching this without `?fail=` would mean the
// client asked for something it was never shown.
function handleLogsSocket(ws, req) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const fail = query.get('fail');
  if (fail === 'refuse') {
    ws.close(1011, LOG_FOLLOW_REFUSAL);
    return;
  }
  if (fail === 'unit') {
    ws.close(1011, 'Unsafe unit name.');
    return;
  }
  if (fail) {
    ws.close(1011, 'mock: failed to open log stream (ssh exec error)');
    return;
  }

  const path = query.get('path');
  const unit = query.get('unit');

  if (path) {
    if (!LOG_FILES.some(f => f.path === path)) {
      ws.close(1011, LOG_FOLLOW_REFUSAL);
      return;
    }
    const interval = FOLLOW_INTERVAL_MS[path] || 500;
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      const line = path === '/var/log/nginx/access.log' ? nextAccessLine() : nextSyslogLine();
      ws.send(`${line}\n`);
    }, interval);
    ws.on('close', () => clearInterval(timer));
    return;
  }

  if (unit) {
    if (!LOG_UNITS.includes(unit)) {
      ws.close(1011, 'Unsafe unit name.');
      return;
    }
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      ws.send(`${nextJournalLine(unit)}\n`);
    }, 500);
    ws.on('close', () => clearInterval(timer));
    return;
  }

  // Neither path nor unit -- logTargetFromRequest (index.ts) treats this
  // the same way: not a request this bridge knows how to serve.
  ws.close();
}

function testConfigOutput(kind) {
  return kind === 'nginx'
    ? 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful'
    : 'Syntax OK';
}

function testConfigFailureOutput(kind) {
  return kind === 'nginx'
    ? 'nginx: [emerg] unexpected "}" in /etc/nginx/sites-enabled/broken.conf:14\nnginx: configuration file /etc/nginx/nginx.conf test failed'
    : 'AH00526: Syntax error on line 12 of /etc/apache2/sites-enabled/broken.conf:\nInvalid command \'ProxyPas\', perhaps misspelled or defined by a module not included in the server configuration\nAction \'configtest\' failed.';
}

// A dev-only twin of terminal.ts's bridge, just enough of one to exercise
// Terminal.jsx without a real host: echoes every keystroke back (a real pty
// in canonical mode does its own local echo; nothing here does that for us),
// acknowledges a resize with a visible line so a screenshot can show it took
// effect, and closes with 1000 when the mock "shell" sees `exit` typed —
// exactly the two close codes terminal.ts documents (1000 clean, 1011
// failure). `?fail=1` on the socket URL mirrors this file's existing
// `?fail=` convention on the mutating HTTP routes: it skips straight to the
// 1011 failure path with no prompt, so the failure state is reachable
// without touching this file's source.
const TERM_PROMPT = `${PROFILE.username}@${PROFILE.name}:~$ `;

function handleTerminalSocket(ws, req) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  if (query.get('fail')) {
    ws.close(1011, 'mock: failed to open shell (ssh channel error)');
    return;
  }

  ws.send(`Welcome to ${PROFILE.name} (mock shell)\r\n${TERM_PROMPT}`);

  let line = '';
  ws.on('message', (data, isBinary) => {
    // Mirrors terminal.ts's own dispatch: binary frames are input, text
    // frames are control (here, only a resize) — see that file's
    // wire-protocol comment for why the two must never be conflated.
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch (error) {
        return;
      }
      if (msg && msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        ws.send(`\r\n\x1b[2m[resized to ${msg.cols}x${msg.rows}]\x1b[0m\r\n${TERM_PROMPT}${line}`);
      }
      return;
    }
    const text = data.toString('utf8');
    ws.send(data); // local echo
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const trimmed = line.trim();
        line = '';
        if (trimmed === 'exit') {
          ws.send('\r\nlogout\r\n');
          ws.close(1000);
          return;
        }
        ws.send(`\r\n${TERM_PROMPT}`);
      } else if (ch === '' || ch === '') {
        line = line.slice(0, -1);
      } else {
        line += ch;
      }
    }
  });
}

/* -------------------------------------------------------------- database -- */
// Shaped like DbAccess.list() (dbAccess.ts) — `{ id, name, label }` per
// configured database — plus a per-database in-memory schema+rows fixture
// exercising the shapes GET/POST /api/db/... hand back (routes.ts, ops/db.ts).
// Names are deliberately fixture-flavoured (`mock_app`, `mock_reporting`),
// never a real schema name, matching this file's identity discipline; email
// addresses in the row data use the `.invalid` TLD for the same reason.
//
// `sessions` carries no PRIMARY KEY column on purpose — it's the one table
// this fixture set exercises the `usingPk: false` / whole-row-identity path
// against, the same rule dbDataBrowser/index.ts and DbGrid.jsx both apply.
const DB_LIST = [
  { id: 'db0', name: 'mock_app', label: 'mock_app' },
  { id: 'db1', name: 'mock_reporting', label: 'Reporting (read replica)' },
];

function orderRows(n) {
  const statuses = ['pending', 'paid', 'shipped', 'refunded'];
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push([i, 1 + (i % 5), 1299 + i * 37, statuses[i % statuses.length]]);
  }
  return rows;
}

const DB_SCHEMA = {
  db0: {
    users: {
      columns: [
        { name: 'id', type: 'int(11)', nullable: false, key: 'PRI' },
        { name: 'email', type: 'varchar(255)', nullable: false, key: 'UNI' },
        { name: 'name', type: 'varchar(120)', nullable: true, key: '' },
        { name: 'active', type: 'tinyint(1)', nullable: false, key: '' },
        { name: 'created_at', type: 'datetime', nullable: false, key: '' },
      ],
      rows: [
        [1, 'ada@mock-fixture-host.invalid', 'Ada', 1, '2026-01-04 09:12:00'],
        [2, 'grace@mock-fixture-host.invalid', 'Grace', 1, '2026-02-11 14:03:00'],
        [3, 'linus@mock-fixture-host.invalid', null, 0, '2026-03-22 08:47:00'],
        [4, 'margaret@mock-fixture-host.invalid', 'Margaret', 1, '2026-04-02 17:31:00'],
        [5, 'alan@mock-fixture-host.invalid', 'Alan', 0, '2026-05-19 11:55:00'],
      ],
    },
    orders: {
      // 120 rows so pagination (default page size well under this) is
      // actually exercised in the mock, not just a single always-full page.
      columns: [
        { name: 'id', type: 'int(11)', nullable: false, key: 'PRI' },
        { name: 'user_id', type: 'int(11)', nullable: false, key: '' },
        { name: 'total_cents', type: 'int(11)', nullable: false, key: '' },
        { name: 'status', type: "enum('pending','paid','shipped','refunded')", nullable: false, key: '' },
      ],
      rows: orderRows(120),
    },
    sessions: {
      // No PRIMARY KEY -- see the module comment above.
      columns: [
        { name: 'session_id', type: 'varchar(64)', nullable: false, key: '' },
        { name: 'user_id', type: 'int(11)', nullable: true, key: '' },
        { name: 'payload', type: 'text', nullable: true, key: '' },
      ],
      rows: [
        ['sess_a1b2c3', 1, '{"cart":[]}'],
        ['sess_d4e5f6', null, '{"cart":["sku-102"]}'],
      ],
    },
  },
  db1: {
    daily_totals: {
      columns: [
        { name: 'day', type: 'date', nullable: false, key: 'PRI' },
        { name: 'orders', type: 'int(11)', nullable: false, key: '' },
        { name: 'revenue_cents', type: 'int(11)', nullable: false, key: '' },
      ],
      rows: [
        ['2026-08-14', 18, 42_318],
        ['2026-08-15', 22, 51_004],
        ['2026-08-16', 15, 33_920],
      ],
    },
  },
};

function dbFilterOp(op) {
  return {
    '=': (a, b) => a !== null && String(a) === String(b),
    '!=': (a, b) => a === null || String(a) !== String(b),
    LIKE: (a, b) => a !== null && String(a).toLowerCase().indexOf(String(b).toLowerCase()) !== -1,
    '>': (a, b) => a !== null && Number(a) > Number(b),
    '<': (a, b) => a !== null && Number(a) < Number(b),
    '>=': (a, b) => a !== null && Number(a) >= Number(b),
    '<=': (a, b) => a !== null && Number(a) <= Number(b),
    'IS NULL': a => a === null,
    'IS NOT NULL': a => a !== null,
  }[op];
}

function dbApplyFilter(rows, columnNames, filter) {
  if (!filter || !filter.op) {
    return rows;
  }
  const fn = dbFilterOp(filter.op);
  if (!fn) {
    return rows;
  }
  if (filter.column) {
    const idx = columnNames.indexOf(filter.column);
    if (idx === -1) {
      return rows;
    }
    return rows.filter(r => fn(r[idx], filter.value));
  }
  // "anywhere" -- OR across every column, mirroring buildWhere (dbQuery.ts).
  return rows.filter(r => columnNames.some((_, i) => fn(r[i], filter.value)));
}

function dbApplySort(rows, columnNames, sort) {
  if (!sort || !sort.column) {
    return rows;
  }
  const idx = columnNames.indexOf(sort.column);
  if (idx === -1) {
    return rows;
  }
  const dir = sort.dir === 'DESC' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a[idx];
    const bv = b[idx];
    if (av === bv) {
      return 0;
    }
    if (av === null) {
      return -1 * dir;
    }
    if (bv === null) {
      return 1 * dir;
    }
    return (av > bv ? 1 : -1) * dir;
  });
}

function dbRowMatches(row, columnNames, where) {
  return Object.keys(where || {}).every(col => {
    const idx = columnNames.indexOf(col);
    if (idx === -1) {
      return false;
    }
    const wv = where[col];
    return wv === null || wv === undefined ? row[idx] === null : String(row[idx]) === String(wv);
  });
}

function dbTable(id, tableName) {
  const schema = DB_SCHEMA[id];
  return schema ? schema[tableName] : undefined;
}

function dbExportFilename(dbName, table) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = table ? `${dbName}.${table}` : dbName;
  return `${base}-${stamp}.sql.gz`;
}

// A small, plausible-looking gzip-header-prefixed buffer -- this does not
// need to decompress into anything real, only to exercise the browser's
// blob-download path (Database.jsx's downloadExport) end to end.
function dbExportBody(label) {
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]),
    Buffer.from(`-- mock export: ${label}\n`),
  ]);
}

// `?fail=sql` on POST /api/db/:id/sql skips straight to the query-failure
// shape ({ results: [], error }) -- the same "fail is on the query, not the
// transport" distinction routes.ts's own handler draws.
function handleSqlFail() {
  return { results: [], error: 'mock: syntax error near "FORM" -- did you mean FROM?' };
}

const wss = new WebSocketServer({ noServer: true });

// Only the DB write routes (rows/update/delete/sql) actually read a JSON
// body -- every other POST route in this file (services actions, webserver
// test) carries no body at all, so this is new rather than something
// pre-existing to reuse.
function readJsonBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        resolve({});
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;
    const query = parsed.searchParams;
    const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const fail = query.get('fail');
    const body = req.method === 'POST' ? await readJsonBody(req) : {};

    const sendJson = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (pathname === '/api/session') {
      sendJson(200, { ...state(), capabilities: CAPABILITIES });
      return;
    }
    if (pathname === '/api/host') {
      sendJson(200, state());
      return;
    }
    if (pathname === '/api/activity') {
      sendJson(200, { entries: [{ at: Date.now(), label: 'restart nginx', command: 'systemctl restart nginx', code: 0, ms: 412, error: null }] });
      return;
    }
    if (pathname === '/api/host/refresh') {
      sendJson(200, { ok: true });
      return;
    }
    if (pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Mirror the real server's transition sequence (idle -> connecting ->
      // online), not just a single 'online' frame — that single-frame shape
      // is exactly what let useSession.js's old wholesale-replace state
      // handler hide the capabilities-dropping bug: with only one frame ever
      // sent, there was nothing after the initial /api/session fetch to
      // clobber it. Sending 'connecting' first and 'online' a beat later
      // actually exercises the merge.
      send('state', state('connecting'));
      const onlineTimer = setTimeout(() => send('state', state('online')), 400);
      const history = [];
      const timer = setInterval(() => {
        const snap = snapshot();
        history.push({ at: snap.at, one: snap.load.one, five: snap.load.five, fifteen: snap.load.fifteen });
        send('tick', { snapshot: snap, history: history.slice(-1800) });
      }, 1000);
      const slowTimer = setInterval(() => send('slow', SLOW), 5000);
      send('slow', SLOW);
      req.on('close', () => {
        clearTimeout(onlineTimer);
        clearInterval(timer);
        clearInterval(slowTimer);
      });
      return;
    }

    // GET /api/services
    if (req.method === 'GET' && pathname === '/api/services') {
      sendJson(200, { services: SERVICES });
      return;
    }

    // GET /api/services/:unit/status
    if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'services' && segments[3] === 'status') {
      const unit = segments[2];
      sendJson(200, { output: serviceStatusText(unit) });
      return;
    }

    // POST /api/services/:unit/:action
    if (req.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'services') {
      const unit = segments[2];
      const action = segments[3];
      if (fail === 'sudo') {
        sendJson(200, { ok: false, output: sudoHintText() });
        return;
      }
      if (fail) {
        sendJson(200, { ok: false, output: genericActionFailure(unit, action) });
        return;
      }
      sendJson(200, { ok: true, output: serviceActionOutput(unit, action) });
      return;
    }

    // GET /api/webserver
    if (req.method === 'GET' && pathname === '/api/webserver') {
      sendJson(200, WEBSERVER_DETECT);
      return;
    }

    // GET /api/webserver/:kind/vhosts
    if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'webserver' && segments[3] === 'vhosts') {
      const kind = segments[2];
      if (kind === 'apache') {
        sendJson(200, { vhosts: APACHE_VHOSTS, certificates: APACHE_CERTIFICATES, skipped: APACHE_SKIPPED });
        return;
      }
      if (kind === 'nginx') {
        sendJson(200, { vhosts: NGINX_VHOSTS, certificates: NGINX_CERTIFICATES, skipped: NGINX_SKIPPED });
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`Unknown web server kind: ${kind}`);
      return;
    }

    // POST /api/webserver/:kind/test
    if (req.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'webserver' && segments[3] === 'test') {
      const kind = segments[2];
      if (kind !== 'nginx' && kind !== 'apache') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`Unknown web server kind: ${kind}`);
        return;
      }
      if (fail === 'sudo') {
        sendJson(200, { ok: false, output: sudoHintText() });
        return;
      }
      if (fail) {
        sendJson(200, { ok: false, output: testConfigFailureOutput(kind) });
        return;
      }
      sendJson(200, { ok: true, output: testConfigOutput(kind) });
      return;
    }

    // GET /api/logs
    if (req.method === 'GET' && pathname === '/api/logs') {
      if (fail) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('mock: log discovery failed (ssh exec error)');
        return;
      }
      sendJson(200, { files: LOG_FILES, units: LOG_UNITS });
      return;
    }

    // GET /api/file?path=...&lines=...
    if (req.method === 'GET' && pathname === '/api/file') {
      const requestedPath = query.get('path') || '';
      const content = Object.prototype.hasOwnProperty.call(FILE_CONTENTS, requestedPath)
        ? FILE_CONTENTS[requestedPath]
        : Object.prototype.hasOwnProperty.call(LOG_FILE_CONTENTS, requestedPath)
        ? LOG_FILE_CONTENTS[requestedPath]
        : null;
      if (content === null) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('That file was not returned by a vhost listing or a log discovery scan for this session.');
        return;
      }
      // Mirrors readFileCommand's real `sed -n '1,Np'` shape: the FIRST N
      // lines of the file, not an arbitrary slice -- see that builder's own
      // comment in ops/command.ts for why this route is head-first, not
      // tail-first, despite Logs.jsx presenting it as a "snapshot" view.
      const linesParam = Number(query.get('lines'));
      const n = Number.isFinite(linesParam) && linesParam > 0 ? Math.floor(linesParam) : 400;
      const sliced = content ? content.split('\n').slice(0, n).join('\n') : content;
      sendJson(200, { content: sliced });
      return;
    }

    // GET /api/cloudflare/zone
    if (req.method === 'GET' && pathname === '/api/cloudflare/zone') {
      if (fail === 'cf') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(CF_ZONE_FAILURE);
        return;
      }
      sendJson(200, CF_ZONE);
      return;
    }

    // POST /api/cloudflare/purge
    if (req.method === 'POST' && pathname === '/api/cloudflare/purge') {
      if (fail === 'cf' || fail === 'cfpurge') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(fail === 'cfpurge' ? CF_PURGE_RATE_LIMIT_FAILURE : CF_PURGE_FAILURE);
        return;
      }
      sendJson(200, { purged: true });
      return;
    }

    // GET /api/db
    if (req.method === 'GET' && pathname === '/api/db') {
      sendJson(200, { databases: DB_LIST });
      return;
    }

    // GET /api/db/:id/tables
    if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'db' && segments[3] === 'tables') {
      const id = segments[2];
      const schema = DB_SCHEMA[id];
      if (!schema) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`No database "${id}" is configured for this profile.`);
        return;
      }
      sendJson(200, { tables: Object.keys(schema) });
      return;
    }

    // GET /api/db/:id/tables/:table/columns
    if (
      req.method === 'GET' &&
      segments.length === 6 &&
      segments[0] === 'api' &&
      segments[1] === 'db' &&
      segments[3] === 'tables' &&
      segments[5] === 'columns'
    ) {
      const id = segments[2];
      const tableName = segments[4];
      const table = dbTable(id, tableName);
      if (!table) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`No table named "${tableName}" in this database.`);
        return;
      }
      sendJson(200, { columns: table.columns });
      return;
    }

    // POST /api/db/:id/tables/:table/rows
    if (
      req.method === 'POST' &&
      segments.length === 6 &&
      segments[0] === 'api' &&
      segments[1] === 'db' &&
      segments[3] === 'tables' &&
      segments[5] === 'rows'
    ) {
      const id = segments[2];
      const tableName = segments[4];
      const table = dbTable(id, tableName);
      if (!table) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`No table named "${tableName}" in this database.`);
        return;
      }
      const columnNames = table.columns.map(c => c.name);
      const filtered = dbApplyFilter(table.rows, columnNames, body.filter);
      const total = filtered.length;
      const sorted = dbApplySort(filtered, columnNames, body.sort);
      const limit = Math.max(0, Math.min(Number(body.limit) || 50, 500));
      const offset = Math.max(0, Number(body.offset) || 0);
      const page = sorted.slice(offset, offset + limit);
      sendJson(200, { columns: columnNames, rows: page, total, durationMs: 3, truncated: false });
      return;
    }

    // POST /api/db/:id/tables/:table/update
    if (
      req.method === 'POST' &&
      segments.length === 6 &&
      segments[0] === 'api' &&
      segments[1] === 'db' &&
      segments[3] === 'tables' &&
      segments[5] === 'update'
    ) {
      const id = segments[2];
      const tableName = segments[4];
      const table = dbTable(id, tableName);
      if (!table) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`No table named "${tableName}" in this database.`);
        return;
      }
      const columnNames = table.columns.map(c => c.name);
      const set = (body && body.set) || {};
      const where = (body && body.where) || {};
      if (!Object.keys(set).length || !Object.keys(where).length) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('No columns to update, or no row identity was given.');
        return;
      }
      const idx = table.rows.findIndex(r => dbRowMatches(r, columnNames, where));
      if (idx === -1) {
        sendJson(200, { ok: true, affectedRows: 0 });
        return;
      }
      Object.keys(set).forEach(col => {
        const ci = columnNames.indexOf(col);
        if (ci !== -1) {
          table.rows[idx][ci] = set[col];
        }
      });
      sendJson(200, { ok: true, affectedRows: 1 });
      return;
    }

    // POST /api/db/:id/tables/:table/delete
    if (
      req.method === 'POST' &&
      segments.length === 6 &&
      segments[0] === 'api' &&
      segments[1] === 'db' &&
      segments[3] === 'tables' &&
      segments[5] === 'delete'
    ) {
      const id = segments[2];
      const tableName = segments[4];
      const table = dbTable(id, tableName);
      if (!table) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`No table named "${tableName}" in this database.`);
        return;
      }
      const columnNames = table.columns.map(c => c.name);
      const where = (body && body.where) || {};
      if (!Object.keys(where).length) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('No row identity was given.');
        return;
      }
      const idx = table.rows.findIndex(r => dbRowMatches(r, columnNames, where));
      if (idx === -1) {
        sendJson(200, { ok: true, affectedRows: 0 });
        return;
      }
      table.rows.splice(idx, 1);
      sendJson(200, { ok: true, affectedRows: 1 });
      return;
    }

    // POST /api/db/:id/sql
    if (req.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'db' && segments[3] === 'sql') {
      const sql = String((body && body.sql) || '').trim();
      if (!sql) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Enter a SQL statement.');
        return;
      }
      // Deliberately loose (a real statement splitter lives in dbSql.ts, not
      // duplicated here) -- good enough to exercise the two-step confirm gate
      // (Global Constraint 5) and both result shapes.
      const mutating = /^\s*(update|delete|insert|replace|truncate|drop|alter|create)\b/i.test(sql);
      const hasWhere = /\bwhere\b/i.test(sql);
      if (mutating && !body.confirm) {
        sendJson(200, { needsConfirm: true, reason: 'This script changes data. Confirm to run it.', statements: [sql] });
        return;
      }
      if (mutating && !hasWhere && !body.confirmUnfiltered) {
        sendJson(200, {
          needsConfirm: true,
          reason: 'This script changes data with no WHERE clause, so it affects every row. Confirm again to run it.',
          statements: [sql],
        });
        return;
      }
      if (fail === 'sql') {
        sendJson(200, handleSqlFail());
        return;
      }
      if (mutating) {
        sendJson(200, {
          results: [{ columns: [], rows: [], truncated: false, rowCount: 0, affectedRows: 3, durationMs: 6 }],
          error: null,
        });
        return;
      }
      sendJson(200, {
        results: [
          {
            columns: ['id', 'email'],
            rows: [
              [1, 'ada@mock-fixture-host.invalid'],
              [2, 'grace@mock-fixture-host.invalid'],
            ],
            truncated: false,
            rowCount: 2,
            affectedRows: 0,
            durationMs: 4,
          },
        ],
        error: null,
      });
      return;
    }

    // GET /api/db/:id/export?table=
    if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'db' && segments[3] === 'export') {
      const id = segments[2];
      const dbEntry = DB_LIST.find(d => d.id === id);
      if (!dbEntry) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`No database "${id}" is configured for this profile.`);
        return;
      }
      const table = query.get('table') || null;
      const filename = dbExportFilename(dbEntry.name, table);
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      res.end(dbExportBody(table ? `table ${table}` : `database ${dbEntry.name}`));
      return;
    }

    const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, ws => handleTerminalSocket(ws, req));
      return;
    }
    if (pathname === '/ws/logs') {
      wss.handleUpgrade(req, socket, head, ws => handleLogsSocket(ws, req));
      return;
    }
    socket.destroy();
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mock UI server on http://127.0.0.1:${PORT}/?t=dev`);
  });
