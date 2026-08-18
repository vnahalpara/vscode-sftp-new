// Fixtures for the systemd output parsers in `ops/services.ts`.
//
// These are captured (or hand-built to match) the raw text that would sit
// under the `units` / `files` keys after `splitAt(servicesCommand())`'s
// output is split -- i.e. exactly what `systemctl list-units --type=service
// --all --no-pager --plain --no-legend` and `systemctl list-unit-files
// --type=service --no-pager --plain --no-legend` print, one section each.
// `--plain --no-legend` means: no header row, no ANSI colour, whitespace-
// separated columns -- except that real-world systemd still prepends a `●`
// bullet to a FAILED unit's line on some versions even with those flags,
// which is exactly the kind of surprise a parser has to survive.

// `systemctl list-units --type=service --all --no-pager --plain --no-legend`
export const UNITS_TEXT = [
  // Ordinary, healthy unit -- the baseline case.
  'nginx.service                loaded    active   running A high performance web server',
  // A `●` bullet prefix: systemd emits this for a FAILED unit on some
  // versions even under --plain --no-legend. Must not be swallowed into the
  // unit-name field and must not be dropped from the output -- a failed
  // unit is exactly what an operator opens this tab to find.
  '● sshd.service               loaded    failed   failed  OpenSSH server daemon',
  // A `not-found` load state: the unit file has vanished (e.g. an old
  // transient/generated unit) but systemd still reports a line for it.
  'bogus.service                not-found inactive dead    -',
  // A templated unit -- the `@` instance syntax must survive untouched.
  'getty@tty1.service           loaded    active   running Getty on tty1',
  // A non-`.service` unit that happens to sort in alongside the services;
  // must be skipped entirely rather than misparsed as a service.
  'cron.timer                   loaded    active   waiting Run cron background tasks',
  // Multiple consecutive spaces inside the description text itself (not
  // just between columns) -- collapsing whitespace during parsing must not
  // be mistaken for corruption.
  'cron.service                 loaded    active   running Regular   background program',
  // Fewer than four whitespace-separated fields: malformed and must be
  // skipped outright, not turned into a row of `undefined`s.
  'brokenline.service loaded active',
].join('\n');

// `systemctl list-unit-files --type=service --no-pager --plain --no-legend`
// Deliberately omits `cron.service` so `mergeServices` has a unit present in
// `list-units` but absent from `list-unit-files`, pinning `enabled ===
// 'unknown'` for that case. Also omits `bogus.service` (a not-found unit
// realistically has no unit file to report on) and `cron.timer` (filtered
// out before merge and not a `.service` unit to begin with).
export const UNIT_FILES_TEXT = [
  'nginx.service                          enabled',
  'sshd.service                           disabled',
  'getty@tty1.service                     enabled',
  // A malformed line with only one field -- must be skipped, not crash.
  'garbageline',
].join('\n');

// A completely empty listing, e.g. `systemctl` produced no output at all
// (permission denied, no services matched, etc).
export const EMPTY_UNITS_TEXT = '';
export const EMPTY_UNIT_FILES_TEXT = '';

/* -------------------------------------------------------- web server / nginx */
// Fixtures for the nginx/apache/openssl parsers in `ops/webserver.ts`. Each
// one is captured (or hand-built to match) the raw text that would sit
// under a `configFilesCommand`/`certInfoCommand`/`detectWebServerCommand`
// section, or -- for `parseNginxVhosts`/`parseApacheVhosts` -- the plain
// config file content that a `{ file, content }` entry would carry after
// splitting. Every one of these is a defect that has actually happened once
// in the reference implementation this ports from; see ops-webserver-test.ts
// for what each one pins.

export const NGINX_UBUNTU_DEFAULT_FILE = '/etc/nginx/sites-enabled/default';

// Ubuntu's stock nginx package ships this file nearly verbatim: an active
// plain-HTTP `server { ... }` block, followed by the HTTPS block commented
// out line by line with a leading `#` (the maintainers leave it as a
// template rather than deleting it). Without comment stripping, the second
// block parses as a real vhost and the panel shows a site -- with a
// self-signed "snakeoil" certificate -- that was never actually enabled.
export const NGINX_UBUNTU_DEFAULT_TEXT = [
  'server {',
  '        listen 80 default_server;',
  '        listen [::]:80 default_server;',
  '',
  '        root /var/www/html;',
  '',
  '        index index.html index.htm index.nginx-debian.html;',
  '',
  '        server_name _;',
  '',
  '        location / {',
  '                try_files $uri $uri/ =404;',
  '        }',
  '}',
  '',
  '# server {',
  '#       listen 443 ssl default_server;',
  '#       listen [::]:443 ssl default_server;',
  '#',
  '#       root /var/www/html;',
  '#',
  '#       index index.html index.htm index.nginx-debian.html;',
  '#',
  '#       server_name _;',
  '#',
  '#       ssl_certificate snakeoil.pem;',
  '#       ssl_certificate_key snakeoil.key;',
  '#}',
].join('\n');

export const NGINX_NESTED_LOCATIONS_FILE = '/etc/nginx/sites-enabled/example.conf';

// A `server` block with two sibling `location { ... }` blocks nested
// inside it. A naive extractor (e.g. a non-greedy `server\s*\{([\s\S]*?)\}`
// regex) stops at the *first* `}` it meets -- the close of `location /`
// -- silently truncating the block before `location /api`, and before the
// trailing `error_log` directive placed after both locations. The
// `error_log` assertion in the test is what actually proves the block was
// captured in full, not just that a `root` before the locations survived.
export const NGINX_NESTED_LOCATIONS_TEXT = [
  'server {',
  '    listen 80;',
  '    server_name example.com;',
  '    root /var/www/example;',
  '',
  '    location / {',
  '        try_files $uri $uri/ =404;',
  '    }',
  '',
  '    location /api {',
  '        proxy_pass http://127.0.0.1:3000;',
  '    }',
  '',
  '    error_log /var/log/nginx/example-error.log;',
  '}',
].join('\n');

// A directive whose value contains a literal `#`. `stripComments` has no
// notion of quoting, so it cannot tell this `#` apart from a real comment
// marker and strips from it to the end of the line -- including this
// directive's own terminating `;`. Pinned here as a known, honestly
// documented limitation: the missing `;` means `directive`/`directiveAll`
// fail to match `root` at all (return null / omit it) rather than
// returning a truncated or -- absent the newline-exclusion fix in
// `directiveRe` -- a corrupted value that swallows the next directive too.
export const NGINX_HASH_IN_VALUE_FILE = '/etc/nginx/sites-enabled/weird.conf';
export const NGINX_HASH_IN_VALUE_TEXT = [
  'server {',
  '    listen 80;',
  '    server_name example.com;',
  '    root /var/www/weird#dir;',
  '    access_log /var/log/nginx/access.log;',
  '}',
].join('\n');

// Direct, minimal inputs for `stripComments` itself, isolating the two
// cases above from block/directive parsing.
export const STRIP_COMMENTS_TRAILING_TEXT = 'server_name example.com; # a genuine trailing comment';
export const STRIP_COMMENTS_HASH_IN_VALUE_TEXT = 'root /var/www/weird#dir;';

export const NGINX_SSL_LISTEN_FILE = '/etc/nginx/sites-enabled/secure.conf';
// `listen 443 ssl http2;` -- the `ssl` parameter and the 443 port both
// independently signal SSL.
export const NGINX_SSL_LISTEN_TEXT = [
  'server {',
  '    listen 443 ssl http2;',
  '    server_name secure.example.com;',
  '    root /var/www/secure;',
  '    ssl_certificate /etc/ssl/certs/secure.example.com.pem;',
  '}',
].join('\n');

export const NGINX_SSL_CERT_ONLY_FILE = '/etc/nginx/sites-enabled/certonly.conf';
// `ssl_certificate` present but the vhost only listens on plain port 80 --
// e.g. a host mid-migration to TLS termination elsewhere. `ssl` must still
// be true because a certificate is configured, independent of the listen
// port.
export const NGINX_SSL_CERT_ONLY_TEXT = [
  'server {',
  '    listen 80;',
  '    server_name cert-only.example.com;',
  '    root /var/www/certonly;',
  '    ssl_certificate /etc/ssl/certs/certonly.pem;',
  '}',
].join('\n');

export const NGINX_PLAIN_8443_FILE = '/etc/nginx/sites-enabled/altport.conf';
// A plain (non-SSL) listener on port 8443. The reference implementation
// tested `443` as a bare substring, and "8443".includes("443") is true, so
// this would have been wrongly reported as SSL. Pins the fix in
// `listenImpliesSsl`, which requires 443 to be a standalone port token.
export const NGINX_PLAIN_8443_TEXT = [
  'server {',
  '    listen 8443;',
  '    server_name alt-port.example.com;',
  '    root /var/www/altport;',
  '}',
].join('\n');

// -- Fix round 1: additional `listen` shapes traced by hand in review of the
// `listenImpliesSsl` boundary fix, added as regression tests per shape so a
// future edit to the regex can't silently regress one of them the way it
// would have gone untested otherwise (per the project's history with the
// `$10` positional-parameter bug and the systemd bullet-prefix bug -- both
// were traced-correct once and untested, and both shipped broken).

export const NGINX_LISTEN_443_BARE_FILE = '/etc/nginx/sites-enabled/bare443.conf';
// `listen 443 ssl;` with no further parameters after `ssl` -- the minimal
// form of an explicit SSL listener, as opposed to the `ssl http2` shape
// already covered elsewhere.
export const NGINX_LISTEN_443_BARE_TEXT = [
  'server {',
  '    listen 443 ssl;',
  '    server_name bare443.example.com;',
  '    root /var/www/bare443;',
  '}',
].join('\n');

export const NGINX_LISTEN_44300_FILE = '/etc/nginx/sites-enabled/port44300.conf';
// A port that starts with the digits "443" but is not port 443 -- 44300,
// not 443. Distinct from the 8443 case (443 as a suffix): here 443 is a
// prefix of a longer digit run, which the lookahead half of the boundary
// check (`(?!\d)`) is what rejects.
export const NGINX_LISTEN_44300_TEXT = [
  'server {',
  '    listen 44300;',
  '    server_name port44300.example.com;',
  '    root /var/www/port44300;',
  '}',
].join('\n');

export const NGINX_LISTEN_IPV4_443_FILE = '/etc/nginx/sites-enabled/ipv4-443.conf';
// Port 443 with an explicit IPv4 bind address and no `ssl` keyword --
// nginx still terminates TLS here if paired with `ssl_certificate`
// elsewhere, but this fixture isolates the port-443 half of the OR.
export const NGINX_LISTEN_IPV4_443_TEXT = [
  'server {',
  '    listen 127.0.0.1:443;',
  '    server_name ipv4-443.example.com;',
  '    root /var/www/ipv4-443;',
  '}',
].join('\n');

export const NGINX_LISTEN_IPV6_443_SSL_FILE = '/etc/nginx/sites-enabled/ipv6-443.conf';
// Port 443 with an IPv6 bind address and the `ssl` keyword -- the `[::]`
// literal brackets must not confuse the boundary check.
export const NGINX_LISTEN_IPV6_443_SSL_TEXT = [
  'server {',
  '    listen [::]:443 ssl;',
  '    server_name ipv6-443.example.com;',
  '    root /var/www/ipv6-443;',
  '}',
].join('\n');

export const NGINX_LISTEN_UNIX_SOCKET_FILE = '/etc/nginx/sites-enabled/unix-socket.conf';
// Documented limitation, not a blessed behaviour: the boundary regex has no
// notion of what kind of value it is scanning, so a standalone "443" digit
// run inside an unrelated value -- here a unix-socket path that merely
// happens to contain "443" -- still reads as a port and false-positives
// `ssl: true`. A real fix would need to parse the listen value's grammar
// (host[:port] vs unix:path) rather than pattern-matching the whole raw
// string; out of scope for this fix.
export const NGINX_LISTEN_UNIX_SOCKET_TEXT = [
  'server {',
  '    listen unix:/run/nginx-443.sock;',
  '    server_name socket.example.com;',
  '    root /var/www/socket;',
  '}',
].join('\n');

export const NGINX_NO_SERVER_NAME_FILE = '/etc/nginx/sites-enabled/noname.conf';
// No `server_name` directive at all -- nginx itself treats this as the
// catch-all `_` server, and the parser must report the same.
export const NGINX_NO_SERVER_NAME_TEXT = [
  'server {',
  '    listen 80;',
  '    root /var/www/noname;',
  '}',
].join('\n');

/* ------------------------------------------------------- web server / apache */

export const APACHE_VHOSTS_FILE = '/etc/apache2/sites-enabled/example.conf';
// A plain HTTP vhost with a ServerAlias and a proxy, an HTTPS vhost with no
// alias (pinning that a missing `ServerAlias` reports null rather than
// throwing or defaulting to something misleading), and a commented-out
// third vhost that must not appear at all.
export const APACHE_VHOSTS_TEXT = [
  '<VirtualHost *:80>',
  '    ServerName example.com',
  '    ServerAlias www.example.com',
  '    DocumentRoot /var/www/example',
  '    ProxyPass /api http://127.0.0.1:4000/',
  '    CustomLog /var/log/apache2/example-access.log combined',
  '    ErrorLog /var/log/apache2/example-error.log',
  '</VirtualHost>',
  '',
  '<VirtualHost *:443>',
  '    ServerName secure.example.com',
  '    DocumentRoot /var/www/secure',
  '    SSLEngine on',
  '    SSLCertificateFile /etc/ssl/certs/secure.example.com.pem',
  '</VirtualHost>',
  '',
  '# <VirtualHost *:8443>',
  '#     ServerName ghost.example.com',
  '#     DocumentRoot /var/www/ghost',
  '# </VirtualHost>',
].join('\n');

/* ------------------------------------------------------------- detectWebServer */
// Raw `@@`-sectioned text matching exactly what `detectWebServerCommand`
// (src/modules/serverManager/ops/command.ts) frames: `@@nginx`,
// `@@apache_bin`, `@@apache`, `@@active`, `@@ports`.

export const DETECT_BOTH_TEXT = [
  '@@nginx',
  'nginx version: nginx/1.18.0 (Ubuntu)',
  '@@apache_bin',
  'apache2',
  '@@apache',
  'Server version: Apache/2.4.41 (Ubuntu)',
  '@@active',
  'nginx|active|enabled',
  'apache2|active|enabled',
  'httpd|unknown|unknown',
  '@@ports',
  'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=123,fd=6))',
  'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=123,fd=7))',
].join('\n');

export const DETECT_NGINX_ONLY_TEXT = [
  '@@nginx',
  'nginx version: nginx/1.24.0 (Ubuntu)',
  '@@apache_bin',
  '@@apache',
  '@@active',
  'nginx|active|enabled',
  'apache2|inactive|disabled',
  'httpd|inactive|disabled',
  '@@ports',
  'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=99,fd=6))',
].join('\n');

// Neither web server installed, and nothing listening on the watched ports.
export const DETECT_NONE_TEXT = [
  '@@nginx',
  '@@apache_bin',
  '@@apache',
  '@@active',
  'nginx|inactive|disabled',
  'apache2|inactive|disabled',
  'httpd|inactive|disabled',
  '@@ports',
].join('\n');

/* --------------------------------------------------------------- certificateInfo */
// Raw `@@<path>`-sectioned text matching exactly what `certInfoCommand`
// (src/modules/serverManager/ops/command.ts) frames.

export const CERT_INFO_OK_PATH = '/etc/ssl/certs/example.com.pem';
export const CERT_INFO_MISSING_PATH = '/etc/ssl/certs/missing.pem';

export const CERT_INFO_TEXT = [
  `@@${CERT_INFO_OK_PATH}`,
  'notAfter=Sep 20 12:00:00 2026 GMT',
  'subject=CN = example.com',
  'issuer=CN = R3',
  `@@${CERT_INFO_MISSING_PATH}`,
  'unable to load certificate',
  "140245123456:error:02001002:system library:fopen:No such file or directory:bss_file.c:158:fopen('/etc/ssl/certs/missing.pem','r')",
  '140245123456:error:2006D080:BIO routines:BIO_new_file:no such file:bss_file.c:165:',
].join('\n');

/* ------------------------------------------------- configFilesCommand framing */
// A hand-edited vhost file that does NOT end in a newline -- ordinary on a
// real host (an editor without "insert final newline", a `printf` redirect,
// a file truncated by hand). `cat` reproduces it byte for byte, so without
// the `printf '\n'` configFilesCommand now emits after each file, the NEXT
// file's `@@` marker gets appended to this file's last line and stops being
// a marker at all: splitAt requires `@@` at index 0.
export const NGINX_NO_TRAILING_NEWLINE_FILE = '/etc/nginx/sites-enabled/first.conf';
export const NGINX_NO_TRAILING_NEWLINE_TEXT = [
  'server {',
  '    listen 80;',
  '    server_name first.example.com;',
  '    root /var/www/first;',
  '}',
].join('\n'); // deliberately no trailing '\n'

export const NGINX_SECOND_FILE = '/etc/nginx/sites-enabled/second.conf';
export const NGINX_SECOND_TEXT = [
  'server {',
  '    listen 80;',
  '    server_name second.example.com;',
  '    root /var/www/second;',
  '}',
  '',
].join('\n'); // ends with a newline, as most files do
