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

// Two independent layers, in order of strength:
//
// Layer 1 -- exact match, used whenever the caller has the real token in
// scope (every caller in this file does; see checkResponse below). Reduce
// both the token and the response body to their ALPHANUMERIC SKELETON --
// strip every character that isn't a letter or digit, deliberately
// including `-` and `_` even though those are themselves valid token
// characters -- then check whether the token's skeleton appears in the
// body's skeleton. Stripping `-`/`_` too (not just "everything outside the
// token charset") is the part that matters: a token's own hyphens/
// underscores are exactly the characters most likely to get swapped for a
// delimiter by something reformatting text (e.g. `token.split('-').join('
// ')`), and keeping them in the "preserved" set would silently break
// alignment between the two sides the moment that happens -- the token
// would still be sitting there in the message, fully readable with spaces
// instead of hyphens, while an exact substring check against the
// unmodified token quietly reports no match. Reducing to letters-and-
// digits-only means it doesn't matter whether a separator was *inserted*
// (a stray space/colon/line-wrap) or *substituted* (a hyphen replaced by
// something else) -- either way the two skeletons still line up. If the
// token's skeleton shows up anywhere in the body's skeleton at all -- as a
// `message` substring, as an unrelated top-level field, as a JSON *key*,
// nested arbitrarily deep -- the whole body is treated as contaminated and
// NO text from it is used; only the fixed-vocabulary message for the
// status code is returned. This is the only layer that makes token leakage
// structurally impossible rather than merely unlikely.
//
// Layer 2 -- shape-based fallback, used only when no token was supplied
// (i.e. Layer 1 could not run). A run of 20+ token-charset characters gets
// redacted before a Cloudflare `message` is allowed into the output. This
// is strictly weaker: a token broken up by inserted or substituted
// delimiters defeats it, which is exactly the failure Layer 1 exists to
// close. It is kept only as a defense for callers that, for whatever
// reason, invoke `cloudflareError` without the token in hand.
const NON_ALPHANUMERIC_RE = /[^A-Za-z0-9]/g;
function alphanumericSkeleton(text: string): string {
  return text.replace(NON_ALPHANUMERIC_RE, '');
}

function bodyContainsToken(body: string, token: string): boolean {
  const tokenSkeleton = alphanumericSkeleton(token);
  return tokenSkeleton.length > 0 && alphanumericSkeleton(body).includes(tokenSkeleton);
}

const TOKEN_SHAPED_RUN_RE = /[A-Za-z0-9_-]{20,}/g;
function scrub(text: string): string {
  return text.replace(TOKEN_SHAPED_RUN_RE, '[redacted]');
}

/**
 * Turn an HTTP status + raw response body into an actionable message.
 *
 * This never throws, and it never interpolates raw response text into the
 * result -- every branch below is built from a fixed vocabulary plus
 * Cloudflare's numeric `code`s plus, at most, a `message` detail that has
 * been proven (Layer 1 above) or scrubbed (Layer 2) not to carry the token.
 * Pass `token` whenever it is available -- every caller in this file does --
 * so Layer 1's exact-match, fragmentation-proof check runs instead of the
 * weaker shape-based fallback.
 */
export function cloudflareError(status: number, body: string, token?: string): string {
  let codes: number[] = [];
  let detail = '';
  const contaminated = token ? bodyContainsToken(body, token) : false;
  try {
    const parsed = JSON.parse(body);
    if (parsed && Array.isArray(parsed.errors)) {
      codes = parsed.errors
        .map((e: any) => e && e.code)
        .filter((c: any) => typeof c === 'number');
      if (!contaminated) {
        const messages = parsed.errors
          .map((e: any) => e && typeof e.message === 'string' ? e.message : '')
          .filter(Boolean);
        if (messages.length) {
          detail = ` (${scrub(messages.join('; '))})`;
        }
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
//
// `token` is threaded through from the caller (both callers below hold it)
// so cloudflareError can run its exact-match, fragmentation-proof
// contamination check instead of falling back to the weaker shape-based
// scrub.
function checkResponse(res: CfResponse, token: string): any {
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300 || !parsed || parsed.success !== true) {
    throw new Error(cloudflareError(res.status, res.body, token));
  }
  return parsed;
}

export async function zoneInfo(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ id: string; name: string }> {
  const res = await deps.request({ method: 'GET', path: `/client/v4/zones/${zoneId}`, token, body: null });
  const parsed = checkResponse(res, token);
  // `success: true` promises a `result` object, but a proxy or gateway
  // between us and Cloudflare could rewrite/truncate the body and leave
  // `success: true` while dropping `result` -- degrade through the normal
  // error path instead of letting a raw TypeError (`Cannot read properties
  // of undefined`) escape past checkResponse/cloudflareError.
  if (!parsed.result || typeof parsed.result.id !== 'string' || typeof parsed.result.name !== 'string') {
    throw new Error(cloudflareError(res.status, res.body, token));
  }
  return { id: parsed.result.id, name: parsed.result.name };
}

export async function purgeEverything(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ purged: true }> {
  const res = await deps.request({
    method: 'POST',
    path: `/client/v4/zones/${zoneId}/purge_cache`,
    token,
    body: JSON.stringify({ purge_everything: true }),
  });
  checkResponse(res, token);
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
