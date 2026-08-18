import {
  stripComments, nginxServerBlocks, directive, directiveAll,
  parseNginxVhosts, parseApacheVhosts, parseDetect, parseCertInfo,
} from '../ops/webserver';
import {
  NGINX_UBUNTU_DEFAULT_FILE, NGINX_UBUNTU_DEFAULT_TEXT,
  NGINX_NESTED_LOCATIONS_FILE, NGINX_NESTED_LOCATIONS_TEXT,
  NGINX_HASH_IN_VALUE_TEXT,
  STRIP_COMMENTS_TRAILING_TEXT, STRIP_COMMENTS_HASH_IN_VALUE_TEXT,
  NGINX_SSL_LISTEN_FILE, NGINX_SSL_LISTEN_TEXT,
  NGINX_SSL_CERT_ONLY_FILE, NGINX_SSL_CERT_ONLY_TEXT,
  NGINX_PLAIN_8443_FILE, NGINX_PLAIN_8443_TEXT,
  NGINX_LISTEN_443_BARE_FILE, NGINX_LISTEN_443_BARE_TEXT,
  NGINX_LISTEN_44300_FILE, NGINX_LISTEN_44300_TEXT,
  NGINX_LISTEN_IPV4_443_FILE, NGINX_LISTEN_IPV4_443_TEXT,
  NGINX_LISTEN_IPV6_443_SSL_FILE, NGINX_LISTEN_IPV6_443_SSL_TEXT,
  NGINX_LISTEN_UNIX_SOCKET_FILE, NGINX_LISTEN_UNIX_SOCKET_TEXT,
  NGINX_NO_SERVER_NAME_FILE, NGINX_NO_SERVER_NAME_TEXT,
  APACHE_VHOSTS_FILE, APACHE_VHOSTS_TEXT,
  DETECT_BOTH_TEXT, DETECT_NGINX_ONLY_TEXT, DETECT_NONE_TEXT,
  CERT_INFO_TEXT, CERT_INFO_OK_PATH, CERT_INFO_MISSING_PATH,
} from '../__fixtures__/ops';

describe('stripComments', () => {
  it('drops a genuine trailing comment', () => {
    expect(stripComments(STRIP_COMMENTS_TRAILING_TEXT)).toBe('server_name example.com; ');
  });

  it('documents a limitation: a literal # inside a value is stripped along with the rest of the line, ' +
     'including the directive\'s own terminating semicolon -- this is a known gap in line-based comment ' +
     'stripping, not correct handling of an escaped/quoted value', () => {
    expect(stripComments(STRIP_COMMENTS_HASH_IN_VALUE_TEXT)).toBe('root /var/www/weird');
  });
});

describe('nginxServerBlocks', () => {
  it('finds no vhost inside a commented-out server block (Ubuntu default HTTPS block)', () => {
    const blocks = nginxServerBlocks(NGINX_UBUNTU_DEFAULT_TEXT);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).not.toContain('ssl_certificate');
    expect(blocks[0]).not.toContain('default_server;\n#');
  });

  it('finds the true end of a block containing nested location blocks, not the first stray }', () => {
    const blocks = nginxServerBlocks(NGINX_NESTED_LOCATIONS_TEXT);
    expect(blocks.length).toBe(1);
    // Proof the block was captured past the first nested `}`: both locations
    // and the trailing directive placed after them are present.
    expect(blocks[0]).toContain('location /api');
    expect(blocks[0]).toContain('proxy_pass http://127.0.0.1:3000;');
    expect(blocks[0]).toContain('error_log /var/log/nginx/example-error.log;');
  });
});

describe('directive / directiveAll', () => {
  it('returns null, not a corrupted multi-line value, for a directive whose terminating ; was stripped ' +
     'along with a # in its value -- pins the newline exclusion in directiveRe: the reference ' +
     'implementation\'s [^;{]+ class matches a literal newline, so this same input makes it capture ' +
     'across the line boundary and swallow the next directive\'s text too, up to whatever ; terminates ' +
     'that one, instead of failing to match', () => {
    const [block] = nginxServerBlocks(NGINX_HASH_IN_VALUE_TEXT);
    expect(directive(block, 'root')).toBeNull();
  });

  it('leaves the next directive independently parseable even though the line before it is malformed', () => {
    const [block] = nginxServerBlocks(NGINX_HASH_IN_VALUE_TEXT);
    expect(directive(block, 'access_log')).toBe('/var/log/nginx/access.log');
  });

  it('directiveAll collects every occurrence in document order', () => {
    const [block] = nginxServerBlocks(NGINX_UBUNTU_DEFAULT_TEXT);
    expect(directiveAll(block, 'listen')).toEqual(['80 default_server', '[::]:80 default_server']);
  });

  it('returns an empty array from directiveAll when the directive is absent', () => {
    const [block] = nginxServerBlocks(NGINX_NO_SERVER_NAME_TEXT);
    expect(directiveAll(block, 'proxy_pass')).toEqual([]);
  });
});

describe('parseNginxVhosts', () => {
  it('produces no vhost at all from a file that is only a commented-out default HTTPS block, ' +
     'and exactly one vhost from the real HTTP block beside it', () => {
    const vhosts = parseNginxVhosts([{ file: NGINX_UBUNTU_DEFAULT_FILE, content: NGINX_UBUNTU_DEFAULT_TEXT }]);
    expect(vhosts.length).toBe(1);
    expect(vhosts[0].serverName).toBe('_');
    expect(vhosts[0].ssl).toBe(false);
    expect(vhosts[0].root).toBe('/var/www/html');
    expect(vhosts[0].certificate).toBeNull();
  });

  it('yields exactly one vhost with the correct root from a block with two nested location blocks', () => {
    const vhosts = parseNginxVhosts([{ file: NGINX_NESTED_LOCATIONS_FILE, content: NGINX_NESTED_LOCATIONS_TEXT }]);
    expect(vhosts.length).toBe(1);
    expect(vhosts[0].serverName).toBe('example.com');
    expect(vhosts[0].root).toBe('/var/www/example');
    expect(vhosts[0].errorLog).toBe('/var/log/nginx/example-error.log');
    expect(vhosts[0].proxyPass).toBe('http://127.0.0.1:3000');
  });

  it('sets ssl true for a listen 443 ssl http2 line', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_SSL_LISTEN_FILE, content: NGINX_SSL_LISTEN_TEXT }]);
    expect(vhost.listen).toEqual(['443 ssl http2']);
    expect(vhost.ssl).toBe(true);
  });

  it('sets ssl true when ssl_certificate is present even though the vhost only listens on 80', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_SSL_CERT_ONLY_FILE, content: NGINX_SSL_CERT_ONLY_TEXT }]);
    expect(vhost.listen).toEqual(['80']);
    expect(vhost.certificate).toBe('/etc/ssl/certs/certonly.pem');
    expect(vhost.ssl).toBe(true);
  });

  it('fixes a reference bug: a plain listener on port 8443 is not SSL, even though "8443" contains ' +
     'the substring "443"', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_PLAIN_8443_FILE, content: NGINX_PLAIN_8443_TEXT }]);
    expect(vhost.listen).toEqual(['8443']);
    expect(vhost.ssl).toBe(false);
  });

  it('reports _ for a vhost with no server_name directive at all', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_NO_SERVER_NAME_FILE, content: NGINX_NO_SERVER_NAME_TEXT }]);
    expect(vhost.serverName).toBe('_');
  });

  it('always reports aliases as null -- nginx has no ServerAlias-equivalent directive', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_SSL_LISTEN_FILE, content: NGINX_SSL_LISTEN_TEXT }]);
    expect(vhost.aliases).toBeNull();
  });

  it('returns an empty array for an empty file list', () => {
    expect(parseNginxVhosts([])).toEqual([]);
  });

  it('concatenates vhosts across multiple files, tagging each with its own file path', () => {
    const vhosts = parseNginxVhosts([
      { file: NGINX_SSL_LISTEN_FILE, content: NGINX_SSL_LISTEN_TEXT },
      { file: NGINX_NO_SERVER_NAME_FILE, content: NGINX_NO_SERVER_NAME_TEXT },
    ]);
    expect(vhosts.map(v => v.file)).toEqual([NGINX_SSL_LISTEN_FILE, NGINX_NO_SERVER_NAME_FILE]);
  });
});

// Fix round 1: `listenImpliesSsl` is not exported, so these go through
// `parseNginxVhosts` -- the most honest reachable surface -- with one
// minimal fixture per `listen` shape traced by hand in review. Each of
// these was confirmed to fail against the pre-fix `/ssl|443/` substring
// regex before this round's fixes were locked in (see task-3-report.md,
// "Fix round 1" section).
describe('parseNginxVhosts: ssl boundary regex, every listen shape traced in review', () => {
  it('listen 443 ssl; (no further params) -> ssl true', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_LISTEN_443_BARE_FILE, content: NGINX_LISTEN_443_BARE_TEXT }]);
    expect(vhost.listen).toEqual(['443 ssl']);
    expect(vhost.ssl).toBe(true);
  });

  it('listen 44300; (443 as a digit-run prefix, not the port) -> ssl false', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_LISTEN_44300_FILE, content: NGINX_LISTEN_44300_TEXT }]);
    expect(vhost.listen).toEqual(['44300']);
    expect(vhost.ssl).toBe(false);
  });

  it('listen 127.0.0.1:443; (explicit IPv4 bind address, no ssl keyword) -> ssl true', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_LISTEN_IPV4_443_FILE, content: NGINX_LISTEN_IPV4_443_TEXT }]);
    expect(vhost.listen).toEqual(['127.0.0.1:443']);
    expect(vhost.ssl).toBe(true);
  });

  it('listen [::]:443 ssl; (IPv6 bind address) -> ssl true', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_LISTEN_IPV6_443_SSL_FILE, content: NGINX_LISTEN_IPV6_443_SSL_TEXT }]);
    expect(vhost.listen).toEqual(['[::]:443 ssl']);
    expect(vhost.ssl).toBe(true);
  });

  it('listen 80; with an ssl_certificate directive present -> ssl true via the certificate path, not the port', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_SSL_CERT_ONLY_FILE, content: NGINX_SSL_CERT_ONLY_TEXT }]);
    expect(vhost.listen).toEqual(['80']);
    expect(vhost.certificate).not.toBeNull();
    expect(vhost.ssl).toBe(true);
  });

  it('listen 80; with no certificate directive -> ssl false', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_NO_SERVER_NAME_FILE, content: NGINX_NO_SERVER_NAME_TEXT }]);
    expect(vhost.listen).toEqual(['80']);
    expect(vhost.certificate).toBeNull();
    expect(vhost.ssl).toBe(false);
  });

  it('documents a known limitation: a standalone "443" digit run inside an unrelated value ' +
     '(a unix-socket path that happens to contain "443") still false-positives ssl true -- the boundary ' +
     'regex has no notion of the listen value\'s grammar (host[:port] vs unix:path), it only knows digit ' +
     'boundaries', () => {
    const [vhost] = parseNginxVhosts([{ file: NGINX_LISTEN_UNIX_SOCKET_FILE, content: NGINX_LISTEN_UNIX_SOCKET_TEXT }]);
    expect(vhost.listen).toEqual(['unix:/run/nginx-443.sock']);
    expect(vhost.ssl).toBe(true);
  });
});

describe('parseApacheVhosts', () => {
  const vhosts = parseApacheVhosts([{ file: APACHE_VHOSTS_FILE, content: APACHE_VHOSTS_TEXT }]);

  it('produces exactly two vhosts, excluding the commented-out third one entirely', () => {
    expect(vhosts.length).toBe(2);
    expect(vhosts.some(v => v.serverName === 'ghost.example.com')).toBe(false);
  });

  it('parses a plain HTTP vhost with a ServerAlias and a ProxyPass', () => {
    const http = vhosts[0];
    expect(http.serverName).toBe('example.com');
    expect(http.aliases).toBe('www.example.com');
    expect(http.listen).toEqual(['*:80']);
    expect(http.ssl).toBe(false);
    expect(http.root).toBe('/var/www/example');
    // Apache's `get()` captures the whole rest of the line, so a two-part
    // directive like `ProxyPass <path> <url>` comes back as one string.
    expect(http.proxyPass).toBe('/api http://127.0.0.1:4000/');
    expect(http.accessLog).toBe('/var/log/apache2/example-access.log combined');
    expect(http.errorLog).toBe('/var/log/apache2/example-error.log');
  });

  it('reports ssl true for a vhost with SSLEngine on, and null aliases when ServerAlias is absent', () => {
    const https = vhosts[1];
    expect(https.serverName).toBe('secure.example.com');
    expect(https.aliases).toBeNull();
    expect(https.ssl).toBe(true);
    expect(https.certificate).toBe('/etc/ssl/certs/secure.example.com.pem');
  });

  it('returns an empty array for an empty file list', () => {
    expect(parseApacheVhosts([])).toEqual([]);
  });
});

describe('parseDetect', () => {
  it('reports both servers with their active/enabled state and the listening ports when both are installed', () => {
    const { servers, listening } = parseDetect(DETECT_BOTH_TEXT);
    expect(servers).toEqual([
      { kind: 'nginx', unit: 'nginx', version: 'nginx version: nginx/1.18.0 (Ubuntu)', active: 'active', enabled: 'enabled' },
      { kind: 'apache', unit: 'apache2', version: 'Server version: Apache/2.4.41 (Ubuntu)', active: 'active', enabled: 'enabled' },
    ]);
    expect(listening.length).toBe(2);
    expect(listening[0]).toContain('0.0.0.0:80');
  });

  it('reports only nginx when apache is not installed', () => {
    const { servers, listening } = parseDetect(DETECT_NGINX_ONLY_TEXT);
    expect(servers.length).toBe(1);
    expect(servers[0].kind).toBe('nginx');
    expect(listening.length).toBe(1);
  });

  it('reports no servers and no listening ports when neither is installed', () => {
    const { servers, listening } = parseDetect(DETECT_NONE_TEXT);
    expect(servers).toEqual([]);
    expect(listening).toEqual([]);
  });
});

describe('parseCertInfo', () => {
  const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

  it('computes expiry and daysLeft for a certificate openssl could read', () => {
    const [cert] = parseCertInfo(CERT_INFO_TEXT, NOW);
    expect(cert.path).toBe(CERT_INFO_OK_PATH);
    const expiresMs = Date.parse('Sep 20 12:00:00 2026 GMT');
    expect(cert.expires).toBe(new Date(expiresMs).toISOString());
    expect(cert.daysLeft).toBe(Math.floor((expiresMs - NOW) / 86400000));
    expect(cert.subject).toBe('CN = example.com');
    expect(cert.issuer).toBe('CN = R3');
    expect(cert.error).toBeNull();
  });

  it('returns null expires/daysLeft plus a non-empty error, rather than a bogus date, when openssl failed', () => {
    const certs = parseCertInfo(CERT_INFO_TEXT, NOW);
    const missing = certs.filter(c => c.path === CERT_INFO_MISSING_PATH)[0];
    expect(missing.expires).toBeNull();
    expect(missing.daysLeft).toBeNull();
    expect(missing.subject).toBeNull();
    expect(missing.issuer).toBeNull();
    expect(missing.error).not.toBeNull();
    expect(missing.error).toContain('unable to load certificate');
  });

  it('derives daysLeft from the injected now, never from the real clock', () => {
    const earlier = parseCertInfo(CERT_INFO_TEXT, NOW)[0].daysLeft;
    const oneDayLater = parseCertInfo(CERT_INFO_TEXT, NOW + 86400000)[0].daysLeft;
    expect(earlier).not.toBeNull();
    expect(oneDayLater).not.toBeNull();
    expect((earlier as number) - (oneDayLater as number)).toBe(1);
  });

  it('returns an empty array when there is nothing to report', () => {
    expect(parseCertInfo('', NOW)).toEqual([]);
  });
});
