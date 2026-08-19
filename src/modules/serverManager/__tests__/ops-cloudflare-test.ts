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
