# VPN Fixed Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VPN SOCKS proxy listen on the same port every time for a given WireGuard config, and reuse a tunnel that is already running, so the port survives an extension reload.

**Architecture:** `vpnTunnel.acquire()` currently calls `getFreePort()`, which returns a random port unless `vpn.socksPort` is set — so the proxy moves on every restart and anything that hard-codes the port goes stale. This derives the port deterministically from the config path, adopts an already-running tunnel when one is provably ours, and exports `portFor(vpn)` as a read-only view of tunnel state. (Correction, post-implementation: `portFor()` has no production caller. Every consumer takes the port from its own `acquire()`, which is authoritative; the server-manager UI and status-bar item this export was justified by were never built. It is kept as the only way to observe whether a tunnel is tracked, which is what the lifecycle tests assert on.)

**Tech Stack:** TypeScript 3.9 (`lib: ["es6"]`, no DOM, `strictNullChecks`, `noUnusedLocals`), Node `net`/`crypto`/`fs`, Jest.

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md` — section "VPN fixed port"

## Global Constraints

- **No new runtime dependencies.** Node's `net`, `crypto` and `fs` cover all of this.
- The existing `vpn.socksPort` in a profile still wins over any derived port. Never silently override an explicit user choice.
- Never break the current behaviour for profiles with no VPN configured — `acquire()` must remain a no-op cost for them.
- The full suite baseline is **839 passing / 1 failing**; that one failure (`src/fileHandlers/transfer/__tests__/transfer-test.ts` → "sync --update with time offset") is a KNOWN PRE-EXISTING baseline. Do not fix it, do not call it a regression, do not claim a green suite.
- `npx tsc --noEmit -p .` must be clean for `src/`; `node_modules` errors are pre-existing noise.

## A deliberate strengthening of the spec — read this before Task 3

The spec says: *"If the derived port is occupied and answers a SOCKS5 handshake, reuse it instead of starting a second wireproxy."*

**That is not safe enough on its own, and this plan does not do it that way.** "Answers a SOCKS5 handshake" proves only that *something* speaks SOCKS5 on that port — not that it is our wireproxy, and not that it tunnels where we think. Any local process can bind a port in the range and speak SOCKS5. Adopting it would route the user's SSH session — credentials included — through a proxy chosen by whoever won the race to that port. On a shared or compromised machine that is a straightforward MITM.

So adoption requires **proof of ownership**, not just protocol agreement:

1. A marker file, written by us when we start a tunnel, living in the extension's own storage directory (the `init(dir)` path), named from the same `tunnelKey(vpn)` the tunnel map uses. It records `{ port, pid, startedAt, uptimeAtWrite }` — the last two together, so the boot instant it was written against can be recovered from it.
2. On adoption we require **all** of: the marker exists, its `port` matches the port we are about to adopt, its `pid` is still alive, and the port answers a SOCKS5 handshake.
3. Any one of those failing means **do not adopt** — fall back to starting our own tunnel on a free port.

The SOCKS5 probe stays: it catches a stale marker whose PID was recycled onto an unrelated process. Neither check is sufficient alone; both together are.

## Reaping a hung tunnel — scope this plan did not originally have

**This was never in the plan.** It was added mid-implementation, in a task dispatch, which is how a behaviour that sends `SIGTERM` to a process we hold no handle on reached the codebase without design review. It ships, and this section documents it so the plan matches what ships.

**What it does.** When the port we want is occupied and `classifyOwnedPort()` decides the listener is a tunnel of ours that has stopped answering — the `hung` outcome — `openTunnel()` signals that pid before starting the replacement, rather than stepping aside to a free port.

**Why it earns its place.** A hung tunnel can never be adopted again (a live marker whose pid fails the probe never yields `adopt`), and once we step aside to a free port, nothing will ever re-read that marker to kill it either. Left alone it holds the port for the rest of the machine's uptime, and every reload after it leaks one more. The leak is real and compounding.

**Why it needs gating anyway.** Killing an unrelated process is worse than leaking one. The four adoption conditions do not make a kill safe on their own: nothing in them ties the pid to the port, and marker + live pid + failing probe is *precisely* the recycled-pid signature — the one case the probe was introduced to catch. So two gates gate the escalation, and neither may be removed without replacing it:

1. **Re-probe before escalating.** Three attempts at a 2s timeout, on top of the 300ms adopt probe, and a listener that answers any of them is adopted rather than killed. A single missed loopback round trip — a saturated CPU, a swapping machine, a laptop a second out of sleep — is not evidence of death. Adopting wrongly costs one extra wireproxy; killing wrongly can take down another window's tunnel mid-transfer, and asymmetric cost buys asymmetric confidence.
2. **`marker.startedAt` against `os.uptime()`.** A marker written before the current boot describes a process that cannot still exist, because pids are handed out afresh every boot — so whatever is alive under that pid now is, with certainty, unrelated. Such a marker is disqualified outright: not reaped, and not adopted either, since a marker that cannot vouch for a pid cannot vouch for a listener. Force-quitting VS Code leaves exactly this marker behind.

   Only the `os.uptime()` half of that arithmetic is monotonic, and the two directions the wall clock can move are not equally dangerous. A **forward** jump pushes the estimated boot instant ahead, so a genuine marker reads as pre-boot and is disqualified — a leaked wireproxy, nothing worse. A **backward** correction larger than the current uptime (dead RTC battery, a dual-boot machine writing local time, the first NTP sync after either) pushes the estimate back far enough that a genuinely pre-boot marker lands *after* it and passes; with a recycled live pid holding the port and staying silent through all four probes, that is a `SIGTERM` to a stranger. So the marker also records `os.uptime()` as read when its timestamp was taken, pinning the boot instant the writer measured; a backward jump between write and read moves our estimate earlier than the writer's and is refused on that alone, with no wall-clock timestamp involved. A marker carrying no recorded uptime — every build before this one — cannot be checked that way and is refused outright.

**What is deliberately *not* claimed.** The reap is best effort. If the signal does not free the port (EPERM, or a process ignoring `SIGTERM`), the marker stays on disk — it is the only handle a future run has on that process — and we fall back to a free port, or fail outright when `vpn.socksPort` pins the port. Both gates are covered by tests, including that a pre-boot marker is never killed.

---

### Task 1: Deterministic port derivation

**Files:**
- Modify: `src/core/vpnTunnel.ts`
- Test: `src/core/__tests__/vpnTunnel-port-test.ts`

**Interfaces:**
- Produces: `parsePortRange(value: string | undefined): [number, number]`, `derivePort(key: string, range: [number, number]): number`

- [ ] **Step 1: Write the failing tests**

```ts
import { derivePort, parsePortRange } from '../vpnTunnel';

test('derivePort is deterministic for the same key', () => {
  const a = derivePort('/home/me/wg0.conf', [21000, 21999]);
  const b = derivePort('/home/me/wg0.conf', [21000, 21999]);
  expect(a).toBe(b);
});

test('derivePort stays inside the range, inclusive at both ends', () => {
  for (let i = 0; i < 500; i++) {
    const p = derivePort(`/cfg/${i}.conf`, [21000, 21999]);
    expect(p).toBeGreaterThanOrEqual(21000);
    expect(p).toBeLessThanOrEqual(21999);
  }
});

test('derivePort spreads different keys across the range', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    seen.add(derivePort(`/cfg/${i}.conf`, [21000, 21999]));
  }
  // A constant or near-constant function would collapse this. Not a
  // distribution test -- just a smoke test that the hash is being used.
  expect(seen.size).toBeGreaterThan(150);
});

test('a single-port range always yields that port', () => {
  expect(derivePort('anything', [21000, 21000])).toBe(21000);
});

test('parsePortRange accepts the documented form', () => {
  expect(parsePortRange('21000-21999')).toEqual([21000, 21999]);
});

test('parsePortRange falls back to the default on nonsense', () => {
  const def: [number, number] = [21000, 21999];
  expect(parsePortRange(undefined)).toEqual(def);
  expect(parsePortRange('')).toEqual(def);
  expect(parsePortRange('garbage')).toEqual(def);
  expect(parsePortRange('21999-21000')).toEqual(def);   // reversed
  expect(parsePortRange('0-70000')).toEqual(def);       // out of bounds
  expect(parsePortRange('-1--5')).toEqual(def);
  expect(parsePortRange('21000')).toEqual(def);         // not a range
});
```

**A malformed setting must never throw.** This runs on the connection path; a typo in a user setting must degrade to the default, not break every SFTP connection on the machine. Say so in a comment.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/core/__tests__/vpnTunnel-port-test.ts`
Expected: FAIL — `derivePort is not a function`.

- [ ] **Step 3: Implement**

```ts
function derivePort(key: string, range: [number, number]): number {
  const h = crypto.createHash('sha256').update(key).digest();
  return range[0] + (h.readUInt16BE(0) % (range[1] - range[0] + 1));
}
```

`parsePortRange` validates both bounds are integers in 1024–65535 and that low ≤ high, returning the default `[21000, 21999]` otherwise.

- [ ] **Step 4: Run to verify pass; Step 5: Commit**

```bash
git add src/core/vpnTunnel.ts src/core/__tests__/vpnTunnel-port-test.ts
git commit -m "feat: derive a deterministic SOCKS port from the VPN config path"
```

---

### Task 2: SOCKS5 probe

**Files:**
- Modify: `src/core/vpnTunnel.ts`
- Test: `src/core/__tests__/vpnTunnel-probe-test.ts`

**Interfaces:**
- Produces: `probeSocks5(port: number, timeoutMs?: number): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Stand up real `net` servers on **port 0** (never a fixed port) and point the probe at them:

```
test('resolves true for a server that answers a SOCKS5 greeting', ...)   // replies 0x05 0x00
test('resolves false for a server that replies with the wrong version', ...) // replies 0x04 0x00
test('resolves false for a server that accepts and says nothing', ...)   // must TIME OUT, not hang
test('resolves false for a closed port', ...)                            // ECONNREFUSED
test('resolves false for a server that closes immediately', ...)
test('resolves false for a server that sends one byte then stalls', ...)  // partial read
test('never rejects, for any of the above', ...)
test('closes its socket on every path', ...)                             // no leaked handles
```

The greeting is `0x05 0x01 0x00` (SOCKS5, one method, no-auth). A SOCKS5 server replies with two bytes whose first is `0x05`.

**The probe must never reject and must always destroy its socket.** It runs on the connection path; an unhandled rejection or a leaked handle here breaks unrelated features. Jest must exit without `--forceExit`.

- [ ] **Step 2: fail; Step 3: implement; Step 4: pass**

Use a short timeout (300ms is ample on loopback) and destroy the socket in every terminal path, including timeout.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: probe whether a port speaks SOCKS5"
```

---

### Task 3: Ownership marker and tunnel adoption

**Files:**
- Modify: `src/core/vpnTunnel.ts`
- Test: `src/core/__tests__/vpnTunnel-adopt-test.ts`

**Interfaces:**
- Produces: `portFor(vpn: VpnOption): number | undefined`
- Internal: marker read/write/delete keyed by `tunnelKey(vpn)`.

**Read the "deliberate strengthening" section above before writing any of this.** Adoption requires marker + matching port + live PID + SOCKS5 answer. All four.

- [ ] **Step 1: Write the failing tests**

```
test('adopts when marker matches, pid is alive and the port speaks SOCKS5', ...)
test('does NOT adopt when there is no marker', ...)                  // a stranger's proxy
test('does NOT adopt when the marker names a different port', ...)
test('does NOT adopt when the marker pid is dead', ...)
test('does NOT adopt when the port does not answer SOCKS5', ...)     // stale marker, recycled pid
test('does NOT adopt when the marker file is corrupt JSON', ...)     // must not throw
test('an explicit vpn.socksPort wins over the derived port', ...)
test('falls back to a free port when the derived port is occupied by a non-SOCKS service', ...)
test('writes a marker when it starts a tunnel, and removes it on release', ...)
test('portFor returns undefined when no tunnel is running', ...)
```

Inject the liveness check and the probe as dependencies so no test spawns a process or depends on real PIDs.

- [ ] **Step 2: fail; Step 3: implement; Step 4: pass**

Port selection order in `acquire()`:
1. `vpn.socksPort` if set — explicit user choice always wins.
2. Otherwise `derivePort(tunnelKey(vpn), parsePortRange(setting))`.
3. If that port is free, use it.
4. If occupied **and** adoption's four conditions all hold, adopt it.
5. Otherwise `getFreePort()` — never fail because the derived port was taken.

The marker is best-effort: a failure to write it must not fail the connection, it just means the next run will not adopt. Say so in a comment.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: adopt a running tunnel only when it is provably ours"
```

---

### Task 4: Settings, wiring and the terminal-close comment

**Files:**
- Modify: `package.json` (settings contribution), `src/core/vpnTunnel.ts`, `src/commands/commandOpenSshConnection.ts`
- Test: extend the existing vpn tests

- [ ] **Step 1: Add the settings**

```jsonc
"sftp.vpn.portRange": { "type": "string", "default": "21000-21999",
  "description": "Port range the VPN SOCKS proxy picks a deterministic port from." },
"sftp.vpn.keepAlive": { "type": "boolean", "default": true,
  "description": "Leave the tunnel running when the last consumer releases it, so the next connection reuses it." }
```

Read them where the other `sftp.*` settings are read; do not invent a second mechanism.

- [ ] **Step 2: Honour `keepAlive` in `release()`**

When true, `release()` decrements the refcount but leaves the process running so the next `acquire()` adopts it. When false, current behaviour. `disposeAll()` must still kill everything on deactivate regardless — a setting that leaks a process past extension shutdown is a bug, not a feature. Test both.

- [ ] **Step 3: The comment the spec asks for**

`commandOpenSshConnection.ts` acquires the tunnel and releases on terminal close, but closing the **window** rather than the terminal never fires `onDidCloseTerminal`. `disposeAll()` on deactivate covers it. Add a comment recording that, so nobody "fixes" the apparent leak by adding a release that double-releases.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add VPN port-range and keep-alive settings"
```

---

### Task 5: Verification, docs and release

- [ ] **Step 1: Full verification** — `npx jest`, `npx tsc --noEmit -p .`, `npm run build:webui`, `npx vsce package`.

- [ ] **Step 2: Docs** — README section covering: the port is now stable per config file; `vpn.socksPort` still wins; the two new settings; that a running tunnel is reused **only when it is provably ours** and why that check exists (a port answering SOCKS5 is not proof of ownership, and adopting a stranger's proxy would route SSH credentials through it).

- [ ] **Step 3: CHANGELOG and bump to 1.26.0** in `package.json` AND `package-lock.json`.

- [ ] **Step 4: Report honestly** which behaviours were verified against a real tunnel and which against fakes. Adoption in particular is testable only with fakes here unless a real wireproxy is available.

```bash
git commit -m "chore: document the fixed VPN port; bump to 1.26.0"
```
