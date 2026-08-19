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

// Both permissions, not just one. The card makes two calls needing two
// different permissions -- Zone Details needs Zone > Zone > Read, purge needs
// Zone > Cache Purge -- and a 403 does not say which call failed. Naming only
// Cache Purge told a user whose token was scoped to Cloudflare's "Purge
// cache" template to add the permission they already had.
test('a 403 names both permissions, so it is actionable whichever is missing', () => {
  const msg = cloudflareError(403, JSON.stringify({
    success: false, errors: [{ code: 10000, message: 'Authentication error' }],
  }));
  expect(msg).toMatch(/token/i);
  expect(msg).toMatch(/Zone > Zone > Read/);
  expect(msg).toMatch(/Zone > Cache Purge/);
});

test('a 401 gets the same both-permissions message as a 403', () => {
  const msg = cloudflareError(401, '{}');
  expect(msg).toMatch(/Zone > Zone > Read/);
  expect(msg).toMatch(/Zone > Cache Purge/);
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

// The same reduction the module itself compares on: skeleton + case fold.
// Assertions written against this catch a leak that has merely been
// reformatted (delimiters swapped, case changed) on its way to the output,
// which `.not.toContain(token)` would happily let through.
function foldedSkeleton(s: string): string {
  return alnumSkeleton(s).toLowerCase();
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

// Re-review finding (MEDIUM): the skeleton comparison was case-SENSITIVE.
// Case folding is reformatting, not an attack -- plenty of things uppercase
// text on its way to a log or a UI -- so it sits squarely in the same
// realistic threat class as the delimiter substitution above, and combining
// the two defeated both layers at once: Layer 1 missed on case, Layer 2
// missed because no run of 20+ token-charset characters survived the
// delimiter swap. Every character of a realistic 40-character token reached
// the browser. Both skeletons are lowercased before comparing now; since the
// skeleton is ASCII alphanumerics only, that fold is locale-independent, and
// at a 37-character skeleton the false-positive cost is nil.
test('a token echoed back case-folded AND delimiter-substituted is still caught', async () => {
  // A realistically shaped 40-char Cloudflare-style token: mixed case, with
  // hyphens, skeletonising to 37 characters.
  const casedToken = 'v1-a7Kd3xQ9m-Zp2Lr8Tn4W-c6Hb0Ys5Jf-1Ge2Dq';
  const echoes = [
    // The review's exact repro: upstream echoes it uppercased with the
    // hyphens turned into spaces.
    casedToken.toUpperCase().split('-').join(' '),
    // The mirror image, for symmetry: lowercased, hyphens turned into dots.
    casedToken.toLowerCase().split('-').join('.'),
  ];
  for (const echo of echoes) {
    const body = JSON.stringify({ success: false, errors: [{ code: 1, message: 'bad token ' + echo }] });
    const msg = cloudflareError(403, body, casedToken);
    expect(foldedSkeleton(msg)).not.toContain(foldedSkeleton(casedToken));
    // The message still has to be useful -- dropping the detail is the whole
    // response, not blanking the message.
    expect(msg).toMatch(/Zone > Zone > Read/);
    expect(msg).toMatch(/Zone > Cache Purge/);
    const d = deps(403, body);
    await expect(purgeEverything(d, 'z1', casedToken)).rejects.toThrow(/Zone > Cache Purge/);
    await expect(purgeEverything(d, 'z1', casedToken)).rejects.toThrow(
      expect.not.stringContaining(echo) as any
    );
  }
});

// Re-review finding (MEDIUM, structural): rounds 1-3 all made the same
// mistake -- they tested a PROXY for the emitted string instead of the
// emitted string. Round 3 checked `rawDetailText`, which is nearly but not
// quite what gets emitted: `scrub()` runs after the check, and the status
// template then splices the error-code suffix and fixed vocabulary in front
// of the detail. Both transformations demonstrably change the answer, per
// the two repros below. The fix assembles the full message, tests THAT, and
// re-assembles without the detail if it is contaminated, so there is no
// transformation left downstream of the check for a bypass to hide in.
test('a message that scrub() REWRITES into the token skeleton is caught', () => {
  // scrub() replaces the 25-Q run with the literal text `[redacted]`,
  // manufacturing the very skeleton a check on the pre-scrub text ruled out.
  const token = 'aaaaa-redacted-bbbbb-ccccc';
  const body = JSON.stringify({
    success: false,
    errors: [{ code: 1, message: 'aaaaa ' + 'Q'.repeat(25) + ' bbbbb ccccc' }],
  });
  const msg = cloudflareError(403, body, token);
  expect(foldedSkeleton(msg)).not.toContain(foldedSkeleton(token));
  expect(msg).toMatch(/Zone > Zone > Read/);
  expect(msg).toMatch(/Zone > Cache Purge/);
});

test('a token skeleton straddling the error-code suffix and the detail is caught', () => {
  // The match spans `[Cloudflare error 10000]` into `(abcdefghijklmnop)`, so
  // it is invisible to any check that looks at the detail alone.
  const token = '10000-abcdefghijklmnop';
  const body = JSON.stringify({
    success: false,
    errors: [{ code: 10000, message: 'abcdefghijklmnop' }],
  });
  const msg = cloudflareError(403, body, token);
  expect(foldedSkeleton(msg)).not.toContain(foldedSkeleton(token));
  expect(msg).toMatch(/Zone > Zone > Read/);
  expect(msg).toMatch(/Zone > Cache Purge/);
});

// The ladder's last rung. If a (degenerate) token's skeleton occurs inside
// this module's own fixed vocabulary, there is no message left to emit that
// does not contain it -- so nothing is emitted. This is documented rather
// than merely tolerated: it is what makes "the returned string never
// contains the token's folded skeleton" an unconditional statement instead
// of one with an unexamined tail.
test('a token whose skeleton is inside the fixed vocabulary leaves nothing to say', () => {
  expect(cloudflareError(403, '{}', 'Cloudflare rejected the request')).toBe('');
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
//
// The short token must actually OCCUR in the message being asserted on,
// otherwise the test passes with or without the floor and proves nothing:
// the original `'x'` never appeared in the sentence below, so this test was
// green even against the floor-less version it was written to pin. `'zone'`
// occurs twice.
test('a degenerate short token does not black out an unrelated diagnostic message', () => {
  const shortToken = 'zone';
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
