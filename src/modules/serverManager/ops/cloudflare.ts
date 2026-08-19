// Cloudflare's purge-cache API, called from the extension host over HTTPS --
// never over SSH to the managed host. Two reasons that split is deliberate:
//
// 1. The managed host is not the right place to hold a Cloudflare API
//    token. Shelling out to `curl -H "Authorization: Bearer <token>"` on
//    that host would put the token in its process table (readable by any
//    other user via `ps`), and likely into its shell history too. The
//    extension host's own process is not shared with anyone else.
// 2. Cloudflare is the operator's concern, not the server's -- purging a
//    CDN cache has nothing to do with what the managed host can see or do,
//    and requiring it to have outbound internet and a `curl` binary just to
//    support this feature would be an odd new dependency for it to carry.
//
// This module uses Node's built-in `https` module. No new runtime
// dependency.

import * as https from 'https';

export interface CfRequest {
  method: string;
  path: string;
  token: string;
  body: string | null;
}

export interface CfResponse {
  status: number;
  body: string;
}

export interface CloudflareDeps {
  request(opts: CfRequest): Promise<CfResponse>;
}

const CF_HOST = 'api.cloudflare.com';
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Both-or-neither: a profile with only one of the two Cloudflare fields set
 * is a half-finished edit, not a configuration, so it does not count as
 * "has Cloudflare". Truthiness (not just presence) is checked so an empty
 * string -- e.g. a field cleared out in the UI but not removed -- counts as
 * absent, the same as if the key were missing entirely.
 */
export function hasCloudflare(config: any): boolean {
  return Boolean(config && config.CLOUDFLARE_ZONE_ID && config.CLOUDFLARE_API_TOKEN);
}

// Any run of 20+ characters drawn from the token charset (letters, digits,
// `_`, `-`) is scrubbed out of a Cloudflare-supplied message before that
// message is allowed anywhere near an error string. Cloudflare API tokens
// are 40 base64url-ish characters, but the exact length is not a contract
// Cloudflare has made to us, and their error payloads occasionally echo
// back request context (see the "load-bearing" test in
// ops-cloudflare-test.ts, which feeds the token back inside a `message`
// field and inside an unrelated top-level `token` field). Scrubbing by
// shape rather than by exact match means a token-shaped substring is
// removed even if Cloudflare echoes it back mangled, truncated-differently,
// or under a field name we did not anticipate.
const TOKEN_SHAPED_RUN_RE = /[A-Za-z0-9_-]{20,}/g;
function scrub(text: string): string {
  return text.replace(TOKEN_SHAPED_RUN_RE, '[redacted]');
}

/**
 * Turn an HTTP status + raw response body into an actionable message.
 *
 * This never throws, and it never interpolates raw response text into the
 * result -- every branch below is built from a fixed vocabulary plus
 * Cloudflare's numeric `code`s. That is what makes token leakage
 * structurally impossible rather than merely unlikely: even if Cloudflare's
 * `message` field echoes back the token (it has, see above), that field is
 * only ever included after the scrub pass, and only as a scrubbed
 * secondary detail -- never as the message itself.
 */
export function cloudflareError(status: number, body: string): string {
  let codes: number[] = [];
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && Array.isArray(parsed.errors)) {
      codes = parsed.errors
        .map((e: any) => e && e.code)
        .filter((c: any) => typeof c === 'number');
      const messages = parsed.errors
        .map((e: any) => e && typeof e.message === 'string' ? e.message : '')
        .filter(Boolean);
      if (messages.length) {
        detail = ` (${scrub(messages.join('; '))})`;
      }
    }
  } catch {
    // Non-JSON body -- an HTML gateway error page, for instance. Degrade to
    // a message naming just the status code below; nothing from `body` is
    // ever used in that case.
  }

  const codeSuffix = codes.length ? ` [Cloudflare error ${codes.join(', ')}]` : '';

  if (status === 401 || status === 403) {
    return `Cloudflare rejected the request: the CLOUDFLARE_API_TOKEN is invalid or lacks the ` +
      `Zone.Cache Purge permission.${codeSuffix}${detail}`;
  }
  if (status === 404) {
    return `Cloudflare zone not found -- check CLOUDFLARE_ZONE_ID.${codeSuffix}${detail}`;
  }
  if (status === 429) {
    return `Cloudflare rate limited this request. Cloudflare limits purge_everything far more ` +
      `tightly than targeted purges, so this can happen even under light use.${codeSuffix}${detail}`;
  }
  return `Cloudflare returned HTTP ${status}${codeSuffix}${detail}`;
}

// A 200 with `success: false` is still an error -- Cloudflare does that,
// for instance when a request is malformed in a way that does not map to
// an HTTP error status. Route it through cloudflareError the same as a
// non-2xx status so the token-safety guarantees above cover it too.
function checkResponse(res: CfResponse): any {
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300 || !parsed || parsed.success !== true) {
    throw new Error(cloudflareError(res.status, res.body));
  }
  return parsed;
}

export async function zoneInfo(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ id: string; name: string }> {
  const res = await deps.request({ method: 'GET', path: `/client/v4/zones/${zoneId}`, token, body: null });
  const parsed = checkResponse(res);
  return { id: parsed.result.id, name: parsed.result.name };
}

export async function purgeEverything(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ purged: true }> {
  const res = await deps.request({
    method: 'POST',
    path: `/client/v4/zones/${zoneId}/purge_cache`,
    token,
    body: JSON.stringify({ purge_everything: true }),
  });
  checkResponse(res);
  return { purged: true };
}

/** The real `https` implementation. Exported for production wiring; the tested paths above never call it -- they take `CloudflareDeps` injected. */
export function httpsRequest(opts: CfRequest): Promise<CfResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: CF_HOST,
        method: opts.method,
        path: opts.path,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Cloudflare request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (opts.body !== null) {
      req.write(opts.body);
    }
    req.end();
  });
}
