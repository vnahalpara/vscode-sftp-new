// Pure parsing for nginx/apache config text and `openssl` certificate
// output, ported from Server-manager/server/ops.js's stripComments (150),
// nginxServerBlocks (158), directive/directiveAll (178), listVhosts (191)
// and certificateInfo (260). This file does no I/O and runs no shell
// command itself -- `command.ts` builds the remote commands
// (`detectWebServerCommand`, `configFilesCommand`, `certInfoCommand`) and
// `splitAt` frames their `@@`-keyed sections; the caller (Task 4) is
// responsible for running those commands and handing the resulting text to
// the functions below.
//
// Two fixes relative to the reference implementation this is ported from --
// see the doc comments on `directiveRe` and `listenImpliesSsl` for details.

import { splitAt } from './command';

export interface Vhost {
  file: string;
  serverName: string;
  aliases: string | null;
  listen: string[];
  ssl: boolean;
  root: string | null;
  certificate: string | null;
  accessLog: string | null;
  errorLog: string | null;
  proxyPass: string | null;
}

export interface WebServerInfo {
  kind: 'nginx' | 'apache';
  unit: string;
  version: string;
  active: string;
  enabled: string;
}

export interface CertInfo {
  path: string;
  expires: string | null;
  daysLeft: number | null;
  subject: string | null;
  issuer: string | null;
  error: string | null;
}

/**
 * Drop `#` comments so a commented-out block (e.g. Ubuntu's default
 * `/etc/nginx/sites-enabled/default`, which ships an entire HTTPS
 * `server { ... }` block commented out line by line) is not parsed as a
 * real one.
 *
 * Limitation, inherited rather than fixed: this is a line-based strip with
 * no notion of quoting, so a literal `#` inside a directive's value (e.g. a
 * path that happens to contain one) is indistinguishable from a comment and
 * is stripped along with the rest of that line -- including that
 * directive's own terminating `;`. See `directiveRe` below for how such a
 * directive then fails to match at all, rather than producing a corrupted
 * value.
 */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/#.*$/, ''))
    .join('\n');
}

/** Pull out top-level `server { ... }` blocks from an nginx config file. */
export function nginxServerBlocks(raw: string): string[] {
  const text = stripComments(raw);
  const blocks: string[] = [];
  const re = /(^|[\s;{}])server\s*\{/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') {
        depth++;
      } else if (text[i] === '}') {
        depth--;
      }
      i++;
    }
    blocks.push(text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
    m = re.exec(text);
  }
  return blocks;
}

// Directives can follow a newline, a `{`, or a previous `;` on the same
// line.
//
// Fix relative to the reference implementation: the reference used a
// capturing group of `[^;{]+`, and a JS character class matches a literal
// newline unless it is explicitly excluded. That means a directive whose
// own terminating `;` is missing on its line (for instance because a `#`
// inside its value caused `stripComments` to strip the `;` right along with
// it) would have its match keep scanning across the line boundary and
// silently swallow the *next* directive's text too, up to whatever `;`
// terminated *that* one -- producing a corrupted, multi-line value instead
// of failing safely. Excluding `\n` from the class means a directive can
// only ever match within a single line: if its terminator is missing, the
// match simply fails (`directive` returns null / `directiveAll` omits it).
function directiveRe(name: string, flags: string): RegExp {
  return new RegExp(`(?:^|[\\s;{])${name}\\s+([^;{\\n]+);`, flags);
}

export function directive(block: string, name: string): string | null {
  const m = directiveRe(name, 'm').exec(block);
  return m ? m[1].trim() : null;
}

export function directiveAll(block: string, name: string): string[] {
  const out: string[] = [];
  const re = directiveRe(name, 'gm');
  let m: RegExpExecArray | null = re.exec(block);
  while (m) {
    out.push(m[1].trim());
    m = re.exec(block);
  }
  return out;
}

// A `listen` line implies SSL when it names the `ssl` parameter or binds
// port 443.
//
// Fix relative to the reference implementation: it tested `/443/` as a
// plain substring against the raw listen value, which also matches an
// unrelated port that merely contains the digits "443" -- `"8443".includes
// ("443")` is true -- so a plain HTTP listener on port 8443 would have been
// wrongly reported as SSL. The check here requires "443" to be a
// standalone port token (bounded by the start of the string, a `:`, or
// nothing but non-digits before it, and no further digit after it).
function listenImpliesSsl(listenValues: string[]): boolean {
  return listenValues.some(l => /\bssl\b/.test(l) || /(?:^|[^0-9])443(?!\d)/.test(l));
}

/** Parse nginx `server { ... }` blocks out of a set of already-read config files. */
export function parseNginxVhosts(files: { file: string; content: string }[]): Vhost[] {
  const vhosts: Vhost[] = [];
  for (const { file, content } of files) {
    for (const block of nginxServerBlocks(content)) {
      const listen = directiveAll(block, 'listen');
      const certificate = directive(block, 'ssl_certificate');
      vhosts.push({
        file,
        serverName: directive(block, 'server_name') || '_',
        aliases: null,
        listen,
        ssl: listenImpliesSsl(listen) || Boolean(certificate),
        root: directive(block, 'root'),
        certificate,
        accessLog: directive(block, 'access_log'),
        errorLog: directive(block, 'error_log'),
        proxyPass: directive(block, 'proxy_pass'),
      });
    }
  }
  return vhosts;
}

/** Parse Apache `<VirtualHost>...</VirtualHost>` blocks out of a set of already-read config files. */
export function parseApacheVhosts(files: { file: string; content: string }[]): Vhost[] {
  const vhosts: Vhost[] = [];
  for (const { file, content } of files) {
    const cleaned = stripComments(content);
    const re = /<VirtualHost([^>]*)>([\s\S]*?)<\/VirtualHost>/gi;
    let m: RegExpExecArray | null = re.exec(cleaned);
    while (m) {
      const addr = m[1].trim();
      const block = m[2];
      const get = (name: string): string | null => {
        const mm = new RegExp(`^\\s*${name}\\s+(.+)$`, 'im').exec(block);
        return mm ? mm[1].trim().replace(/^"|"$/g, '') : null;
      };
      vhosts.push({
        file,
        serverName: get('ServerName') || '_',
        aliases: get('ServerAlias'),
        listen: [addr],
        ssl: /:443/.test(addr) || /SSLEngine\s+on/i.test(block),
        root: get('DocumentRoot'),
        certificate: get('SSLCertificateFile'),
        accessLog: get('CustomLog'),
        errorLog: get('ErrorLog'),
        proxyPass: get('ProxyPass'),
      });
      m = re.exec(cleaned);
    }
  }
  return vhosts;
}

/** Parse the `@@nginx`/`@@apache_bin`/`@@apache`/`@@active`/`@@ports`-sectioned output of `detectWebServerCommand`. */
export function parseDetect(text: string): { servers: WebServerInfo[]; listening: string[] } {
  const s = splitAt(text);
  const firstLine = (section: string | undefined): string =>
    (section || '').split('\n').map(l => l.trim()).filter(Boolean)[0] || '';

  const nginxVersion = firstLine(s.nginx);
  const apacheVersion = firstLine(s.apache);
  const apacheUnit = firstLine(s.apache_bin);

  const states: { [unit: string]: { active: string; enabled: string } } = Object.create(null);
  (s.active || '').split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const parts = line.split('|');
    const unit = parts[0];
    if (unit) {
      states[unit] = { active: parts[1] || 'unknown', enabled: parts[2] || 'unknown' };
    }
  });

  const servers: WebServerInfo[] = [];
  if (nginxVersion) {
    servers.push({
      kind: 'nginx',
      unit: 'nginx',
      version: nginxVersion,
      active: (states.nginx && states.nginx.active) || 'unknown',
      enabled: (states.nginx && states.nginx.enabled) || 'unknown',
    });
  }
  if (apacheVersion && apacheUnit) {
    servers.push({
      kind: 'apache',
      unit: apacheUnit,
      version: apacheVersion,
      active: (states[apacheUnit] && states[apacheUnit].active) || 'unknown',
      enabled: (states[apacheUnit] && states[apacheUnit].enabled) || 'unknown',
    });
  }

  const listening = (s.ports || '').split('\n').map(l => l.trim()).filter(Boolean);
  return { servers, listening };
}

function matchValue(body: string, re: RegExp): string | null {
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

function certResult(path: string, body: string, now: number): CertInfo {
  const end = /notAfter=(.+)/.exec(body);
  const expires = end ? new Date(end[1].trim()) : null;
  const subject = matchValue(body, /subject=(.+)/);
  const issuer = matchValue(body, /issuer=(.+)/);
  if (expires === null || Number.isNaN(expires.getTime())) {
    return {
      path,
      expires: null,
      daysLeft: null,
      subject,
      issuer,
      error: body.trim().slice(0, 200),
    };
  }
  return {
    path,
    expires: expires.toISOString(),
    daysLeft: Math.floor((expires.getTime() - now) / 86400000),
    subject,
    issuer,
    error: null,
  };
}

/** Parse the `@@<path>`-sectioned output of `certInfoCommand`. `now` (ms epoch) drives `daysLeft`, so it is never read from the clock here. */
export function parseCertInfo(text: string, now: number): CertInfo[] {
  const sections = splitAt(text);
  return Object.keys(sections).map(path => certResult(path, sections[path], now));
}
