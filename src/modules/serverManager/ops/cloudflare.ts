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
// both the token and the CANDIDATE OUTPUT TEXT to their FOLDED SKELETON --
// strip every character that isn't a letter or digit, deliberately
// including `-` and `_` even though those are themselves valid token
// characters, then lowercase what remains -- and check whether the token's
// skeleton appears in the candidate's.
//
// Three things about that comparison matter, each of them learned from a
// version of this guard that got defeated:
//
// 1. Stripping `-`/`_` too (not just "everything outside the token
//    charset") closes substitution, not just insertion: a token's own
//    hyphens/underscores are exactly the characters most likely to get
//    swapped for a delimiter by something reformatting text (e.g.
//    `token.split('-').join(' ')`), and keeping them in the "preserved"
//    set would silently break alignment the moment that happens -- the
//    token would still be sitting there, fully readable with spaces
//    instead of hyphens, while an exact substring check against the
//    unmodified token quietly reports no match.
// 2. Case is folded for the same reason. Uppercasing text on its way to a
//    log or a UI is reformatting, not an attack, and a case-sensitive
//    comparison combined with the delimiter substitution above defeated
//    both layers at once: Layer 1 missed on case, Layer 2 missed because
//    no run of 20+ token-charset characters survived the substitution.
//    The skeleton is ASCII alphanumerics only by the time it is folded, so
//    the fold is locale-independent and cannot merge two distinct
//    skeletons the way a Unicode fold could.
// 3. The candidate MUST be the FULL, FINAL string this function is about to
//    return -- not the raw wire-format `body`, and not any intermediate the
//    output is later derived from. Every defeat of this guard so far has
//    been the same mistake in a new costume: checking a proxy for the
//    output instead of the output.
//      - Checking the pre-parse `body` failed because `JSON.stringify`
//        escapes control characters (a real newline becomes the two
//        characters `\` and `n`); stripping non-alphanumerics from the
//        *escaped* form keeps a stray `n`/`t`/`r`/`b`/`f` the *decoded*
//        form never had, and the alignment the comparison depends on broke.
//      - Checking the decoded-but-unassembled detail text failed because
//        two transformations still ran downstream of the check: `scrub()`
//        (which REWRITES text, and can therefore manufacture a skeleton the
//        check just ruled out -- a token containing the literal word
//        `redacted` is enough), and the status template (which splices the
//        `[Cloudflare error N]` suffix in front of the detail, so a match
//        straddling the two is invisible to a check on the detail alone).
//    So `cloudflareError` below assembles the complete message, tests THAT
//    exact string, and on contamination re-assembles a shorter one and
//    tests again -- down a fixed ladder that ends in the empty string. What
//    it returns is always a string that has itself been tested, so no
//    transformation exists between "what we checked" and "what we emit" for
//    a bypass to hide in. Anything added to the assembly (an annotation, an
//    ellipsis, a normaliser) is automatically covered, because the check
//    runs on the result rather than on an input to it.
//
// If the token's skeleton shows up in a candidate at all, that candidate is
// discarded whole -- the detail is not surgically edited, since editing is
// what put `scrub()` on the wrong side of the check in the first place.
// This is the only layer that makes token leakage structurally impossible
// rather than merely unlikely.
//
// A minimum skeleton length gates the match: without one, a short token
// (a one- or two-character skeleton) matches almost any English text and
// silently blacks out every diagnostic detail Cloudflare sends -- fails
// safe, but destructively. Real Cloudflare API tokens are 40 base64url-ish
// characters, so a floor far below that (chosen well under the shortest
// realistic token skeleton, including one built mostly of `-`/`_`) costs
// nothing against the real threat while ending that over-redaction for
// short/degenerate inputs such as tests.
//
// Layer 2 -- shape-based fallback, used only when no token was supplied
// (i.e. Layer 1 could not run). A run of 20+ token-charset characters gets
// redacted before a Cloudflare `message` is allowed into the output. This
// is strictly weaker: a token broken up by inserted or substituted
// delimiters defeats it, which is exactly the failure Layer 1 exists to
// close. It is kept only as a defense for callers that, for whatever
// reason, invoke `cloudflareError` without the token in hand.
const NON_ALPHANUMERIC_RE = /[^A-Za-z0-9]/g;
function foldedSkeleton(text: string): string {
  // Defensive against non-string input (see the guard at the top of
  // cloudflareError for why that can happen despite the `string` type):
  // this helper must never throw either, since it is the thing that would
  // throw first. `toLowerCase` (not `toLocaleLowerCase`) is deliberate --
  // what is left after the strip is ASCII alphanumerics, so the fold must
  // not vary with the host's locale.
  //
  // NFKC first: it maps fullwidth forms and compatibility singletons (the
  // long s, the Kelvin sign) onto their ASCII equivalents, and is the
  // identity on ASCII -- so it closes those echo shapes for free, with no
  // false-positive cost on a normal message. It does NOT fold homoglyphs
  // from other scripts; see candidateContainsToken for what that leaves open.
  if (typeof text !== 'string') {
    return '';
  }
  let normalised = text;
  try {
    normalised = text.normalize('NFKC');
  } catch (error) {
    // normalize() throws only on an invalid form argument, never on content,
    // but this helper's contract is that it cannot throw at all.
    normalised = text;
  }
  return normalised.replace(NON_ALPHANUMERIC_RE, '').toLowerCase();
}

// Tokens whose skeleton falls under this floor are DELIBERATELY left
// unprotected by Layer 1 -- a decision, not an oversight. A one- or
// two-character skeleton is a substring of nearly every English sentence,
// so matching on it blacks out every diagnostic Cloudflare sends without
// protecting anything real. A genuine 40-character Cloudflare API token
// skeletonises to 37-38 characters, three times this floor, so no real
// secret is ever in the unprotected band; only degenerate inputs (tests,
// half-typed config) land there, and those are not secrets worth the
// blackout. Layer 2's shape-based scrub still applies to them.
const MIN_TOKEN_SKELETON_LENGTH = 12;
// KNOWN GAP, stated precisely because an understated version of this comment
// is what let three earlier fixes ship as complete. Layer 1 compares skeletons
// after NFKC + case folding, which does NOT fold homoglyphs from other scripts:
// a token echoed with ASCII letters swapped for their Cyrillic twins
// (a -> U+0430, K -> U+041A, x -> U+0445 ...) produces a skeleton that does not
// match, so Layer 1 misses it entirely.
//
// Sparsely homoglyphed, Layer 2's shape scrub still redacts the surviving
// ASCII runs. DENSELY homoglyphed -- no run of 20 reaching charset characters
// left -- NOTHING is redacted and the whole token is emitted. That case is
// judged theoretical rather than realistic: it needs an upstream that
// transliterates the token into another script, which is not reformatting but
// participation. Closing it would need a Unicode confusable fold, whose
// false-positive cost on ordinary error text is not worth a vector no
// reformatting proxy produces.
function candidateContainsToken(candidateText: string, token: string): boolean {
  const tokenSkeleton = foldedSkeleton(token);
  if (tokenSkeleton.length < MIN_TOKEN_SKELETON_LENGTH) {
    return false;
  }
  return foldedSkeleton(candidateText).includes(tokenSkeleton);
}

const TOKEN_SHAPED_RUN_RE = /[A-Za-z0-9_-]{20,}/g;
function scrub(text: string): string {
  return text.replace(TOKEN_SHAPED_RUN_RE, '[redacted]');
}

/**
 * Turn an HTTP status + raw response body into an actionable message.
 *
 * This never throws -- including when `body` is not actually a string, a
 * contract violation this module's own types disallow but a JS caller can
 * still commit -- and it never interpolates raw response text into the
 * result -- every branch below is built from a fixed vocabulary plus
 * Cloudflare's numeric `code`s plus, at most, a `message` detail that has
 * been scrubbed (Layer 2) of token-shaped runs.
 *
 * The guarantee it actually makes, and the one Layer 1 above is written to
 * hold: WHEN `token` IS PASSED, THE RETURNED STRING IS ALWAYS A STRING THAT
 * WAS ITSELF TESTED FOR THE TOKEN AND FOUND CLEAN. Not an input to it, not a
 * fragment of it -- the returned string. Pass `token` whenever it is
 * available; every caller in this file does.
 */
export function cloudflareError(status: number, body: string, token?: string): string {
  const safeBody = typeof body === 'string' ? body : '';
  let codes: number[] = [];
  let detailText = '';
  try {
    const parsed = JSON.parse(safeBody);
    if (parsed && Array.isArray(parsed.errors)) {
      codes = parsed.errors
        .map((e: any) => e && e.code)
        .filter((c: any) => typeof c === 'number');
      const messages = parsed.errors
        .map((e: any) => e && typeof e.message === 'string' ? e.message : '')
        .filter(Boolean);
      detailText = messages.join('; ');
    }
  } catch {
    // Non-JSON body -- an HTML gateway error page, for instance. Degrade to
    // a message naming just the status code below; nothing from `body` is
    // ever used in that case.
  }

  // The one place a message is assembled. Everything variable reaches the
  // output through a parameter here, so testing this function's RESULT tests
  // the whole output -- there is nothing downstream of it to slip past.
  const assemble = (codeSuffix: string, detail: string): string => {
    if (status === 401 || status === 403) {
      // Names BOTH permissions, because this branch fires for two different
      // calls that need two different ones and the message cannot tell which
      // it is: reading the zone name is Zone Details (Zone > Zone > Read),
      // purging is Zone > Cache Purge. A token scoped to Cloudflare's own
      // "Purge cache" template -- which grants Cache Purge alone -- gets a
      // 403 on the zone lookup, and the earlier wording sent that user off to
      // add the one permission they already had while never naming the one
      // they lacked.
      return `Cloudflare rejected the request: the CLOUDFLARE_API_TOKEN is invalid or lacks a ` +
        `required permission. Reading the zone name needs Zone > Zone > Read; purging needs ` +
        `Zone > Cache Purge.${codeSuffix}${detail}`;
    }
    if (status === 404) {
      return `Cloudflare zone not found -- check CLOUDFLARE_ZONE_ID.${codeSuffix}${detail}`;
    }
    if (status === 429) {
      return `Cloudflare rate limited this request. Cloudflare limits purge_everything far more ` +
        `tightly than targeted purges, so this can happen even under light use.${codeSuffix}${detail}`;
    }
    return `Cloudflare returned HTTP ${status}${codeSuffix}${detail}`;
  };

  const codeSuffix = codes.length ? ` [Cloudflare error ${codes.join(', ')}]` : '';

  // A ladder from most informative to least, each rung a fully assembled
  // message. Emit the first rung that tests clean; every rung is tested, so
  // whatever is returned has been checked in exactly the form it is
  // returned in. Successive rungs drop content rather than rewrite it,
  // which is what keeps a lower rung from re-introducing what a higher one
  // was rejected for.
  const candidates = [
    assemble(codeSuffix, detailText ? ` (${scrub(detailText)})` : ''),
    assemble(codeSuffix, ''),
    assemble('', ''),
  ];
  for (const candidate of candidates) {
    if (!token || !candidateContainsToken(candidate, token)) {
      return candidate;
    }
  }
  // Unreachable for any real token: getting here means the token's folded
  // skeleton occurs inside this module's own fixed vocabulary, which for a
  // 37-character skeleton cannot happen. Kept so the guarantee above has no
  // unexamined tail -- if there is no message left that does not contain the
  // secret, the answer is no message, never a best-effort one.
  return '';
}

/**
 * The other half of the failure space: a rejection from the HTTP client
 * itself, before any response exists to map. `cloudflareError` only ever sees
 * a status and a body, so nothing it does covers httpsRequest's 15s timeout,
 * a DNS or TLS failure, or `https.request`'s synchronous
 * ERR_UNESCAPED_CHARACTERS throw (a zone id with a stray space in it). Those
 * used to propagate as raw Node messages -- a DNS failure surfaced to the
 * user, and into the activity log, as a bare
 * `getaddrinfo ENOTFOUND api.cloudflare.com` with nothing saying it was
 * Cloudflare we could not reach, or why that mattered.
 *
 * Node does not put a request header's value into any of these messages, so
 * the token is not expected in one. "Not expected" is not the guarantee this
 * module makes elsewhere, though, so this runs the same ladder
 * `cloudflareError` does: every rung is a fully assembled string that is
 * itself tested for the token, and the first clean one is returned.
 */
export function cloudflareTransportError(error: any, token?: string): string {
  const raw = error && typeof error.message === 'string' ? error.message : '';
  const candidates = [
    raw ? `Could not reach Cloudflare's API: ${scrub(raw)}` : `Could not reach Cloudflare's API.`,
    `Could not reach Cloudflare's API.`,
  ];
  for (const candidate of candidates) {
    if (!token || !candidateContainsToken(candidate, token)) {
      return candidate;
    }
  }
  return '';
}

// The single door every Cloudflare HTTP call goes through, so that a
// rejection from the injected client is mapped exactly like a failed
// response. `deps.request` is called ONLY from here -- calling it directly
// anywhere below would reopen the raw-Node-message path this closes.
async function request(deps: CloudflareDeps, opts: CfRequest): Promise<CfResponse> {
  try {
    return await deps.request(opts);
  } catch (error) {
    // A synchronous throw inside httpsRequest's promise executor (the
    // ERR_UNESCAPED_CHARACTERS case) rejects the promise rather than
    // escaping it, so `await` inside this try catches that too.
    throw new Error(cloudflareTransportError(error, opts.token));
  }
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
  const res = await request(deps, { method: 'GET', path: `/client/v4/zones/${zoneId}`, token, body: null });
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
  const res = await request(deps, {
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
