import {
  hasCloudflare, zoneInfo, purgeEverything, cloudflareError, CloudflareDeps,
} from '../ops/cloudflare';

const TOKEN = 'cf-secret-token-value';

function deps(status: number, body: string): CloudflareDeps & { seen: any[] } {
  const seen: any[] = [];
  return { seen, request: (o: any) => { seen.push(o); return Promise.resolve({ status, body }); } };
}

test('hasCloudflare requires BOTH fields', () => {
  expect(hasCloudflare({ CLOUDFLARE_ZONE_ID: 'z', CLOUDFLARE_API_TOKEN: 't' })).toBe(true);
  expect(hasCloudflare({ CLOUDFLARE_ZONE_ID: 'z' })).toBe(false);
  expect(hasCloudflare({ CLOUDFLARE_API_TOKEN: 't' })).toBe(false);
  expect(hasCloudflare({})).toBe(false);
  expect(hasCloudflare({ CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: 't' })).toBe(false);
});

test('zoneInfo returns the zone name', async () => {
  const d = deps(200, JSON.stringify({ success: true, result: { id: 'z1', name: 'example.com' } }));
  await expect(zoneInfo(d, 'z1', TOKEN)).resolves.toEqual({ id: 'z1', name: 'example.com' });
  expect(d.seen[0].method).toBe('GET');
  expect(d.seen[0].path).toBe('/client/v4/zones/z1');
});

test('purgeEverything posts purge_everything', async () => {
  const d = deps(200, JSON.stringify({ success: true, result: { id: 'z1' } }));
  await expect(purgeEverything(d, 'z1', TOKEN)).resolves.toEqual({ purged: true });
  expect(d.seen[0].method).toBe('POST');
  expect(d.seen[0].path).toBe('/client/v4/zones/z1/purge_cache');
  expect(JSON.parse(d.seen[0].body)).toEqual({ purge_everything: true });
});

test('a 403 becomes an actionable permission message', () => {
  const msg = cloudflareError(403, JSON.stringify({
    success: false, errors: [{ code: 10000, message: 'Authentication error' }],
  }));
  expect(msg).toMatch(/token/i);
  expect(msg).toMatch(/Zone.Cache Purge/);
});

test('a 404 points at the zone id, not the token', () => {
  const msg = cloudflareError(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'not found' }] }));
  expect(msg).toMatch(/CLOUDFLARE_ZONE_ID/);
});

test('a 429 says rate limited', () => {
  expect(cloudflareError(429, '{}')).toMatch(/rate/i);
});

test('malformed JSON does not throw, it degrades', () => {
  expect(() => cloudflareError(500, '<html>gateway error</html>')).not.toThrow();
  expect(cloudflareError(500, '<html>gateway error</html>')).toMatch(/500/);
});

test('success:false with HTTP 200 is still an error', async () => {
  const d = deps(200, JSON.stringify({ success: false, errors: [{ code: 1, message: 'nope' }] }));
  await expect(purgeEverything(d, 'z1', TOKEN)).rejects.toThrow();
});

// The load-bearing test. Cloudflare error payloads sometimes echo request
// context, and an error message is rendered in the browser and written to the
// activity log. The token must never survive into one.
test('the token never appears in any thrown error message', async () => {
  const bodies = [
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'bad token ' + TOKEN }] }),
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'x' }], token: TOKEN }),
    'Authorization: Bearer ' + TOKEN,
  ];
  for (const body of bodies) {
    expect(cloudflareError(403, body)).not.toContain(TOKEN);
    const d = deps(403, body);
    await expect(purgeEverything(d, 'z1', TOKEN)).rejects.toThrow(
      expect.not.stringContaining(TOKEN) as any
    );
  }
});

// Review finding (HIGH): the shape-based scrub only redacts a CONTIGUOUS
// run of 20+ token-charset characters, so a single non-charset delimiter
// inserted anywhere in the token defeats it -- the fragments each fall
// under the length threshold and pass through untouched. The fix threads
// the real token into cloudflareError (every caller here has it) so it can
// reduce both sides to their alphanumeric skeleton (see the Layer 1 doc
// comment in ops/cloudflare.ts for why `-`/`_` must be stripped too, not
// just "everything outside the token charset") and drop the entire message
// the moment the token's skeleton is found anywhere in the body's, rather
// than trying to redact just the matched piece.
//
// The `.not.toContain(TOKEN)` check alone is not sufficient here: a naive
// fix that preserves `-`/`_` while stripping other punctuation would pass
// that check even while leaking the token in fully human-readable form
// with hyphens turned to spaces (verified against an intermediate version
// of this file, which did exactly that). `alnumSkeleton` below applies the
// same alphanumeric-only reduction to the assertion itself, so the test
// actually fails on that kind of reformatted-but-readable leak.
function alnumSkeleton(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '');
}

test('a token fragmented by inserted or substituted delimiters is still caught, not leaked piecemeal', async () => {
  const midpoint = Math.floor(TOKEN.length / 2);
  const tokenSkeleton = alnumSkeleton(TOKEN);
  const bodies = [
    // Every internal '-' replaced with a space: no single run of 20+
    // token-charset characters survives, so the old shape-based regex
    // alone would miss this entirely and leak the token verbatim (with
    // spaces instead of hyphens) -- and a naive "strip everything outside
    // the token charset" fix would too, since it preserves `-` on the
    // token side while the body side never had it in the first place.
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'bad token ' + TOKEN.split('-').join(' ') }] }),
    // A single delimiter inserted mid-token -- the review's concrete
    // example: this used to leak a real prefix of the secret because the
    // first fragment fell under the 20-char threshold.
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'bad token ' + TOKEN.slice(0, midpoint) + ' ' + TOKEN.slice(midpoint) }] }),
    // The token used as a JSON object KEY rather than a value.
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'x' }], [TOKEN]: 'unrelated' }),
    // The token nested several levels deep in an unrelated object.
    JSON.stringify({ success: false, errors: [{ code: 1, message: 'x' }], meta: { nested: { deep: TOKEN } } }),
  ];
  for (const body of bodies) {
    // Passing the token lets cloudflareError run its exact-match check --
    // this is how every real caller (zoneInfo/purgeEverything) invokes it.
    const msg = cloudflareError(403, body, TOKEN);
    expect(msg).not.toContain(TOKEN);
    // The stronger assertion: no reformatted-but-readable rendering of the
    // secret survives either, not just the exact original string.
    expect(alnumSkeleton(msg)).not.toContain(tokenSkeleton);
    const d = deps(403, body);
    await expect(purgeEverything(d, 'z1', TOKEN)).rejects.toThrow(
      expect.not.stringContaining(TOKEN) as any
    );
  }
});

// Re-review finding (HIGH): the exact-match check computed contamination
// against the RAW (wire-format) body, then built `detail` from the DECODED
// message text -- two different strings. JSON.stringify escapes control
// characters (a real newline becomes the two characters '\' and 'n'), so
// checking the pre-parse body kept those escape-sequence letters where the
// post-parse text had a real control character instead -- the alignment
// the whole comparison depends on broke, contamination went undetected,
// and the decoded message (fully readable, just line-broken) reached the
// output untouched. The fix builds the exact decoded text first and tests
// THAT string, so there is no encoding gap left for a bypass to hide in.
test('a token fragmented by JSON-escaped control-character delimiters is still caught', async () => {
  const tokenSkeleton = alnumSkeleton(TOKEN);
  const delimiters = ['\n', '\t', '\r', '\r\n', '\b', '\f'];
  for (const delimiter of delimiters) {
    const body = JSON.stringify({
      success: false,
      errors: [{ code: 1, message: 'bad token ' + TOKEN.split('-').join(delimiter) }],
    });
    const msg = cloudflareError(403, body, TOKEN);
    expect(msg).not.toContain(TOKEN);
    expect(alnumSkeleton(msg)).not.toContain(tokenSkeleton);
    const d = deps(403, body);
    await expect(purgeEverything(d, 'z1', TOKEN)).rejects.toThrow(
      expect.not.stringContaining(TOKEN) as any
    );
  }
});

// Re-review finding (MEDIUM): the earlier fix called the skeleton helper on
// the raw `body` argument outside cloudflareError's try/catch, so a
// non-string body (null/undefined/a number -- a contract violation this
// module's TS signature disallows but a JS caller can still commit) crashed
// with a raw TypeError, breaking the function's own documented "never
// throws" promise. It must degrade to a status-only message instead.
test('cloudflareError never throws even when body is not actually a string', () => {
  expect(() => cloudflareError(500, null as any, TOKEN)).not.toThrow();
  expect(cloudflareError(500, null as any, TOKEN)).toMatch(/500/);
  expect(() => cloudflareError(500, undefined as any, TOKEN)).not.toThrow();
  expect(cloudflareError(500, undefined as any, TOKEN)).toMatch(/500/);
  expect(() => cloudflareError(500, 12345 as any, TOKEN)).not.toThrow();
  expect(cloudflareError(500, 12345 as any, TOKEN)).toMatch(/500/);
});

// Re-review finding (LOW): without a minimum length floor, a short token
// (as short as a single character) matches almost any English text once
// reduced to its alphanumeric skeleton, silently blacking out every
// diagnostic detail Cloudflare sends -- a security guard turning into a
// diagnostics blackout. Real Cloudflare tokens are 40 characters, far
// above the floor, so this costs nothing against the real threat.
test('a degenerate short token does not black out an unrelated diagnostic message', () => {
  const shortToken = 'x';
  const body = JSON.stringify({
    success: false,
    errors: [{ code: 1, message: 'The zone configuration is invalid, please check your settings' }],
  });
  const msg = cloudflareError(403, body, shortToken);
  expect(msg).toMatch(/zone configuration is invalid/);
});

// Review finding (LOW): a 200/success:true body missing `result` (e.g. a
// gateway or proxy rewriting the body while leaving success:true intact)
// used to throw a raw TypeError from inside zoneInfo, bypassing
// cloudflareError entirely instead of degrading to an actionable message.
test('zoneInfo degrades to an actionable error instead of throwing a raw TypeError when result is missing', async () => {
  const d = deps(200, JSON.stringify({ success: true }));
  await expect(zoneInfo(d, 'z1', TOKEN)).rejects.toThrow(/Cloudflare/);
});
