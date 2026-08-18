# Cloudflare Cache Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a profile carries both `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`, offer a confirmed "purge everything" button on the Web server tab that clears that zone's Cloudflare cache.

**Architecture:** A new `ops/cloudflare.ts` makes HTTPS calls to the Cloudflare API from the extension host using Node's built-in `https` module — never over SSH, never with the token on a remote command line. Two routes (`GET /api/cloudflare/zone`, `POST /api/cloudflare/purge`) sit behind the existing token auth. The web UI learns only a boolean capability; the token stays extension-side.

**Tech Stack:** TypeScript 3.9 (`lib: ["es6"]`, no DOM, `strictNullChecks`, `noUnusedLocals`), Node `https`, React 18 `.jsx` (never `.tsx`), Jest.

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md` — section "Cloudflare cache purge"

## Global Constraints

- No new runtime dependencies. Node's `https` is built in; do not add axios, node-fetch, or a Cloudflare SDK.
- Components are plain `.jsx`. The repo tsconfig has no `jsx` option; a `.tsx` file will not compile.
- The API token must never appear in: `RedactedProfile`, any activity-log entry, any error message surfaced to the UI, or any test fixture committed to the repo.
- Capability gating is both-or-neither: `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` must both be present. One without the other is a half-finished edit, not a configuration.
- All network calls are dependency-injected so tests never touch the network.
- `null` means "not computable" and renders as an em dash, never `0`. This contract holds across the whole feature.

---

### Task 1: The Cloudflare client

**Files:**
- Create: `src/modules/serverManager/ops/cloudflare.ts`
- Test: `src/modules/serverManager/__tests__/ops-cloudflare-test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface CloudflareDeps { request(opts: CfRequest): Promise<CfResponse>; }`
  - `interface CfRequest { method: string; path: string; token: string; body: string | null; }`
  - `interface CfResponse { status: number; body: string; }`
  - `hasCloudflare(config: any): boolean`
  - `zoneInfo(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ id: string; name: string }>`
  - `purgeEverything(deps: CloudflareDeps, zoneId: string, token: string): Promise<{ purged: true }>`
  - `cloudflareError(status: number, body: string): string`
  - `httpsRequest(opts: CfRequest): Promise<CfResponse>` — the real `https` implementation

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/serverManager/__tests__/ops-cloudflare-test.ts`
Expected: FAIL — `Cannot find module '../ops/cloudflare'`.

- [ ] **Step 3: Implement `ops/cloudflare.ts`**

Key implementation requirements:

- `hasCloudflare` uses truthiness on both fields so an empty string counts as absent.
- `cloudflareError(status, body)` parses `body` defensively inside a `try`/`catch`; a non-JSON body must degrade to a message naming the status code, never throw.
- **Every message `cloudflareError` returns is built from a fixed vocabulary plus Cloudflare's `code` numbers — never by interpolating raw response text.** That is what makes token leakage structurally impossible rather than merely unlikely: if the token is echoed back in a message field, that field is never copied into the output. Include Cloudflare's `message` only after a scrub pass that removes any run of 20+ characters from the token charset, and state in a comment why the scrub exists.
- Map: 401/403 → token invalid or missing the `Zone.Cache Purge` permission; 404 → zone not found, check `CLOUDFLARE_ZONE_ID`; 429 → rate limited (Cloudflare limits `purge_everything` far more tightly than targeted purges); anything else → `Cloudflare returned HTTP <status>`.
- `httpsRequest` uses `https.request` against host `api.cloudflare.com`, sets `Authorization: Bearer <token>`, `Content-Type: application/json`, and a 15s timeout that rejects with a message naming the timeout. Collect the response body as a string; do not assume a single `data` event.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/modules/serverManager/__tests__/ops-cloudflare-test.ts`
Expected: PASS, all 9.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/ops/cloudflare.ts src/modules/serverManager/__tests__/ops-cloudflare-test.ts
git commit -m "feat: add a Cloudflare API client for cache purging"
```

---

### Task 2: Capability flag and routes

**Files:**
- Modify: `src/modules/serverManager/registry.ts`
- Modify: `src/modules/serverManager/routes.ts`
- Modify: `src/modules/serverManager/index.ts` (pass the raw config through to the session for Cloudflare use)
- Test: `src/modules/serverManager/__tests__/routes-test.ts` (extend), `src/modules/serverManager/__tests__/registry-test.ts` (extend)

**Interfaces:**
- Consumes: `hasCloudflare`, `zoneInfo`, `purgeEverything`, `cloudflareError` from Task 1.
- Produces: `RedactedProfile.hasCloudflare: boolean`; routes `GET /api/cloudflare/zone` → `{ id, name }` and `POST /api/cloudflare/purge` → `{ purged: true }`.

- [ ] **Step 1: Write the failing tests**

```ts
test('redacted profile exposes hasCloudflare but never the token', () => {
  const TOKEN = 'cf-secret-token-value';
  const redacted = redact({
    name: 'p', host: 'h', port: 22, username: 'u', password: 'pw',
    CLOUDFLARE_ZONE_ID: 'zone123', CLOUDFLARE_API_TOKEN: TOKEN,
  } as any);
  expect(redacted.hasCloudflare).toBe(true);
  const json = JSON.stringify(redacted);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain('CLOUDFLARE_API_TOKEN');
});

test('hasCloudflare is false when only one field is set', () => {
  expect(redact({ CLOUDFLARE_ZONE_ID: 'z' } as any).hasCloudflare).toBe(false);
});

test('purge route 404s when the profile has no Cloudflare config', async () => {
  const res = await call('POST', '/api/cloudflare/purge', sessionWithoutCloudflare);
  expect(res.status).toBe(404);
});

test('purge route returns the mapped error, not the raw body', async () => {
  const res = await call('POST', '/api/cloudflare/purge', sessionWithFailingCloudflare);
  expect(res.status).toBe(502);
  expect(res.body).not.toContain('cf-secret-token-value');
});
```

Adapt `call`/`redact` to the helpers those two test files already use — read them first; do not invent a new harness.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/serverManager/__tests__/registry-test.ts src/modules/serverManager/__tests__/routes-test.ts`
Expected: FAIL — `hasCloudflare` undefined; routes 404 as unknown paths.

- [ ] **Step 3: Implement**

In `registry.ts`, follow the EXISTING pattern exactly — `hasVpn: Boolean(config.vpn && config.vpn.configFile)` — and add:

```ts
hasCloudflare: hasCloudflare(config),
```

Confirm the redaction is an allowlist that builds a fresh object with named fields (safe by default), not a denylist that deletes known-secret keys. If it is a denylist, say so in your report — that is a finding worth raising, because it means any future field leaks by default.

In `routes.ts`, add both routes behind the existing token auth, following the shape of the existing web-server routes. Both must 404 when `hasCloudflare(config)` is false. Map client errors through `cloudflareError` and return 502 for upstream failures. Log to the activity log with the zone id and outcome only — never the token, never the Authorization header.

- [ ] **Step 4: Run the full suite**

Run: `npx jest src/modules/serverManager`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager
git commit -m "feat: gate and route Cloudflare cache purging"
```

---

### Task 3: The Cloudflare card

**Files:**
- Modify: `webui/src/components/WebServer.jsx`
- Modify: `webui/dev/mock-server.js` (add Cloudflare fixtures + a `?fail=cf` mode)

**Interfaces:**
- Consumes: `hasCloudflare` from the session's redacted profile; the two routes from Task 2.

- [ ] **Step 1: Add mock fixtures**

Add `hasCloudflare: true` to the mock `PROFILE`, a `/api/cloudflare/zone` handler returning `{ id: 'zone123', name: 'mock-fixture-host.invalid' }`, and a `/api/cloudflare/purge` handler. Support a failure mode consistent with the mock's existing `?fail=` convention — read how `?fail=sudo` works and match it.

**Every identity in the mock stays fake.** That file was previously seeded from a real server and had to be scrubbed; never reintroduce a real zone id, domain, or token. Use `zone123` and the `.invalid` hostname already there.

- [ ] **Step 2: Render the card**

Add a Cloudflare card to the Web server tab, rendered only when `profile.hasCloudflare` is true. It shows the zone name (fetched lazily from `/api/cloudflare/zone`; while loading show a placeholder, on failure show the mapped error) and a single **Purge everything** button.

Reuse the EXISTING `ConfirmDialog` and `ResultBanner` from this file — do not write new ones. The confirmation text must state plainly that this evicts the entire zone cache and that every subsequent request falls through to the origin until it refills.

**Concurrency:** follow the pattern already in this file and in `Services.jsx` — a busy flag with functional `setState`, a `mountedRef` guard before every post-await `setState` (success, catch AND finally), and the confirm dialog's own button disabled while in flight.

- [ ] **Step 3: Verify visually**

Run the mock, and screenshot with your own eyes: the card present with the zone name; the confirmation dialog; a successful purge; a failed purge showing the mapped error; and the card ABSENT when `hasCloudflare` is false. Revert any temporary mock edit and prove it with `git diff --stat webui/dev/mock-server.js` showing empty.

- [ ] **Step 4: Build and commit**

```bash
npm run build:webui
npx jest src/modules/serverManager
git add webui/
git commit -m "feat: add the Cloudflare purge card"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Document the configuration**

Document that `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` on a profile enable the purge card, that both are required, and that the token needs the **Zone.Cache Purge** permission.

State plainly that these are stored in plaintext in `.vscode/sftp.json` like every other credential the extension reads, that the file should not be committed to a shared repository, and that a scoped token limited to cache-purge on a single zone limits the blast radius if it leaks.

- [ ] **Step 2: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document Cloudflare cache purging"
```
