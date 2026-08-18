# Manage Server — Logs and Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Logs tab (discovered log files and journald units, tail and live follow) and a Terminal tab (xterm.js over the session's existing SSH connection) to the Manage Server dashboard.

**Architecture:** A WebSocket server rides the existing loopback `node:http` server, handling upgrades for `/ws/terminal` and `/ws/logs`. The terminal bridges an ssh2 `shell()` stream; the log follower bridges a `tail -F` / `journalctl -f` exec stream. Every remote command is still built in `ops/command.ts`, the single injection boundary. The UI gains two tabs built with xterm.js.

**Tech Stack:** TypeScript 3.9 (`lib: ["es6"]`, no DOM, `strictNullChecks`, `noUnusedLocals`), Node `http`, `ws`, ssh2, React 18 `.jsx` (never `.tsx`), xterm.js, Jest.

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md` — "Transport", "SSHClient.shell()", "API surface", "Security"

## Global Constraints

- **One new runtime dependency: `ws`, and nothing else.** Add its optional native deps `bufferutil` and `utf-8-validate` to `webpack.config.js` externals so the production build does not try to bundle them. xterm.js goes in `devDependencies` — it is bundled into `media/webui` by Vite and never loaded by the extension host.
- Components are plain `.jsx`. The repo tsconfig has no `jsx` option; a `.tsx` file will not compile.
- Every string that reaches a remote shell is built in `src/modules/serverManager/ops/command.ts`, quoted with `shellSingle` and `--`-guarded. Nothing downstream builds command strings.
- `null` means "not computable" and renders as an em dash, never `0`.
- The full suite baseline is **649 passing / 1 failing**; that one failure (`src/fileHandlers/transfer/__tests__/transfer-test.ts` → "sync --update with time offset") is a KNOWN PRE-EXISTING baseline failure. Do not fix it, do not call it a regression, do not claim a green suite.
- `npx tsc --noEmit -p .` must be clean for `src/`; `node_modules` errors are pre-existing noise.

## Threat model — read before writing any code

This milestone opens two channels that are categorically more dangerous than anything shipped so far. **A terminal on a loopback WebSocket is remote code execution as the SSH user.** Treat the following as requirements, not suggestions.

1. **Token auth on the upgrade, not just on `/api/*`.** The existing per-session random token must be validated during the HTTP upgrade handshake, before any WebSocket is established. A failed check destroys the socket; it does not upgrade-then-close.

2. **`Origin` must be checked.** WebSocket upgrades are *not* subject to the same-origin policy the way `fetch` is — any page the user visits can attempt `new WebSocket('ws://127.0.0.1:<port>/ws/terminal?t=…')` and the browser will send it without a CORS preflight. The token is the primary defence, but a leaked token (a screenshot, a shared URL, shell history) must not be enough on its own. Reject any upgrade whose `Origin` is not our own server's origin.

3. **`Host` must be checked, to defeat DNS rebinding.** A hostile page can resolve its own domain to `127.0.0.1` and reach this server with a `Host` header of `evil.example.com`. Accept only `127.0.0.1:<port>` and `localhost:<port>`.

4. **Log paths are an allowlist, never caller-supplied.** `tail -F <path>` with a caller-chosen path is arbitrary file read as the privileged user. A path may be followed only if it was surfaced by the discovery step for that session — the same discipline `/api/file` uses, which was hardened in the previous milestone after exactly this class of bug. Reuse that mechanism rather than inventing a second one.

5. **journald unit names are validated with `isSafeUnitName`**, the existing validator, and `--`-guarded.

6. **Every spawned remote process must be reaped.** A `tail -F` or a shell stream that outlives its WebSocket is a leaked SSH channel on the user's server. Closing the socket must kill the remote process; a dropped connection must too.

---

### Task 1: WebSocket plumbing and upgrade authentication

**Files:**
- Create: `src/modules/serverManager/wsServer.ts`
- Modify: `src/modules/serverManager/httpServer.ts`, `package.json`, `webpack.config.js`
- Test: `src/modules/serverManager/__tests__/ws-auth-test.ts`

**Interfaces:**
- Produces:
  - `interface UpgradeCheck { ok: boolean; reason: string | null; }`
  - `checkUpgrade(req: { url?: string; headers: { [k: string]: any } }, port: number, tokenIsValid: (t: string) => boolean): UpgradeCheck`
  - `attachWs(server: http.Server, opts: WsOpts): { close(): void }`

- [ ] **Step 1: Write the failing tests**

`checkUpgrade` is the security boundary and is a pure function so it can be tested without a socket. Test at minimum:

```ts
import { checkUpgrade } from '../wsServer';

const PORT = 5599;
const valid = (t: string) => t === 'good-token';
const ok = (over: any = {}) => ({
  url: '/ws/terminal?t=good-token',
  headers: { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}`, ...over },
});

test('accepts a well-formed upgrade', () => {
  expect(checkUpgrade(ok(), PORT, valid).ok).toBe(true);
});

test('rejects a missing token', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/terminal' }, PORT, valid).ok).toBe(false);
});

test('rejects a wrong token', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/terminal?t=nope' }, PORT, valid).ok).toBe(false);
});

test('rejects a foreign Origin even with a VALID token', () => {
  const res = checkUpgrade(ok({ origin: 'https://evil.example.com' }), PORT, valid);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/origin/i);
});

test('rejects a rebound Host even with a valid token and no Origin', () => {
  const res = checkUpgrade(
    { url: '/ws/terminal?t=good-token', headers: { host: 'evil.example.com' } }, PORT, valid);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/host/i);
});

test('accepts localhost as well as 127.0.0.1', () => {
  expect(checkUpgrade(ok({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }), PORT, valid).ok).toBe(true);
});

test('rejects a host on a DIFFERENT port', () => {
  expect(checkUpgrade(ok({ host: `127.0.0.1:${PORT + 1}` }), PORT, valid).ok).toBe(false);
});

test('rejects an unknown ws path', () => {
  expect(checkUpgrade({ ...ok(), url: '/ws/evil?t=good-token' }, PORT, valid).ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/serverManager/__tests__/ws-auth-test.ts`
Expected: FAIL — `Cannot find module '../wsServer'`.

- [ ] **Step 3: Add the dependency**

```bash
npm install ws@^8.18.0 --save
npm install @types/ws --save-dev
```

In `webpack.config.js`, extend `externals` so the optional native deps are never bundled:

```js
externals: {
  vscode: 'commonjs vscode',
  ssh2: 'commonjs ssh2',
  mysql2: 'commonjs mysql2',
  'mysql2/promise': 'commonjs mysql2/promise',
  bufferutil: 'commonjs bufferutil',
  'utf-8-validate': 'commonjs utf-8-validate',
},
```

Note `ws` itself is NOT an external — it is pure JS and must be bundled.

- [ ] **Step 4: Implement `checkUpgrade` and `attachWs`**

`checkUpgrade` parses the path and `t` query param, then applies, in order: known path (`/ws/terminal` or `/ws/logs`), `Host` allowlist (`127.0.0.1:<port>` or `localhost:<port>`), `Origin` allowlist (absent is acceptable — non-browser clients omit it — but a *present* Origin must match), and finally the token. Return a distinct `reason` for each so failures are diagnosable, and document in a comment why Origin/Host are checked at all (browsers do not apply CORS to WebSocket upgrades; DNS rebinding).

`attachWs` uses `new WebSocketServer({ noServer: true })` and handles `server.on('upgrade')` itself, calling `checkUpgrade` and responding `401`/`403` + `socket.destroy()` on failure. This is what "does not upgrade-then-close" means.

- [ ] **Step 5: Run tests to verify they pass; then commit**

```bash
npx jest src/modules/serverManager
git add -A
git commit -m "feat: add authenticated WebSocket plumbing to the manage-server http server"
```

---

### Task 2: `SSHClient.shell()` and the terminal bridge

**Files:**
- Modify: `src/core/remote-client/sshClient.ts` (add `shell`)
- Create: `src/modules/serverManager/terminal.ts`
- Test: `src/modules/serverManager/__tests__/terminal-test.ts`

**Interfaces:**
- Consumes: `attachWs` from Task 1.
- Produces: `bridgeTerminal(deps: TerminalDeps, socket: WsLike): void`, where `TerminalDeps` supplies `openShell(size)` and `WsLike` is the structural subset of a `ws` socket (`on`, `send`, `close`) so tests need no real socket.

- [ ] **Step 1: Write the failing tests**

Drive the bridge with a fake socket and a fake stream. Cover:

```ts
test('remote output is forwarded to the socket', ...);
test('socket input is written to the shell', ...);
test('a resize control message calls setWindow, and is NOT written as input', ...);
test('a malformed resize message is ignored, not written as input, and does not throw', ...);
test('closing the socket ends the remote stream', ...);   // no leaked channel
test('the remote stream closing closes the socket', ...);
test('a shell that fails to open closes the socket with a reason', ...);
```

The resize tests matter: control frames must never be interpretable as terminal input, and terminal *output* must never be interpretable as a control frame (the protocol is client→server only for control).

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/modules/serverManager/__tests__/terminal-test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `SSHClient.shell()`**

In `src/core/remote-client/sshClient.ts`, exactly as the spec gives it:

```ts
shell(opts: { cols: number; rows: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    this._client.shell({ term: 'xterm-256color', ...opts },
      (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}
```

This rides the already-authenticated ssh2 connection: unlike *Open SSH in Terminal*, there is no `sshpass` and no password on any command line. Say so in a comment — it is the reason this is safe.

- [ ] **Step 4: Implement the bridge**

Protocol: binary/text data frames are terminal bytes; a JSON text frame `{"type":"resize","cols":N,"rows":N}` is control. Validate `cols`/`rows` are finite integers in a sane range (1–1000) before calling `stream.setWindow`; ignore anything else silently rather than throwing. Wire `close`/`error` in both directions so neither side can outlive the other.

- [ ] **Step 5: Run tests, then commit**

```bash
git commit -m "feat: bridge an ssh2 shell to a websocket for the Terminal tab"
```

---

### Task 3: Log discovery and follow command builders

**Files:**
- Modify: `src/modules/serverManager/ops/command.ts`
- Create: `src/modules/serverManager/ops/logs.ts`
- Test: extend `src/modules/serverManager/__tests__/command-test.ts`; create `__tests__/ops-logs-test.ts`

**Interfaces:**
- Produces, in `command.ts`: `logDiscoveryCommand(): string`, `tailCommand(path: string, lines: number): string`, `followCommand(path: string): string`, `journalCommand(unit: string, lines: number): string`, `journalFollowCommand(unit: string): string`.
- Produces, in `ops/logs.ts`: `parseLogDiscovery(text: string): { files: LogFile[]; units: string[] }` with `interface LogFile { path: string; bytes: number | null; }`.

- [ ] **Step 1: Write the failing tests**

Command-builder tests must mirror the existing security tests in `command-test.ts`. At minimum:

```ts
test('tailCommand quotes and -- guards the path', () => {
  expect(tailCommand('/var/log/syslog', 200)).toBe(`sudo -n tail -n 200 -- '/var/log/syslog'`);
});

test('tailCommand rejects a path with a newline', () => {
  expect(() => tailCommand('/var/log/a\nb', 200)).toThrow();
});

test('tailCommand rejects a non-integer line count', () => {
  expect(() => tailCommand('/var/log/syslog', 1.5 as any)).toThrow();
  expect(() => tailCommand('/var/log/syslog', -1)).toThrow();
  expect(() => tailCommand('/var/log/syslog', '200; rm -rf /' as any)).toThrow();
});

test('journalCommand validates the unit with isSafeUnitName', () => {
  expect(() => journalCommand('-Hroot@evil', 200)).toThrow();
  expect(journalCommand('nginx.service', 200))
    .toBe(`sudo -n journalctl -n 200 --no-pager -u -- 'nginx.service'`);
});
```

The line count is a new kind of operand — a *number* interpolated without quoting. It must be validated as a positive integer within a bound, or it is an injection vector. Say so in a comment.

Parser tests use fixtures of real `find`/`systemctl` output, following `__fixtures__/ops.ts`.

- [ ] **Step 2: Run to verify they fail; Step 3: implement; Step 4: verify pass**

Discovery command: list candidate log files under `/var/log` (regular files, bounded depth, with sizes) and journald units, framed with the existing `@@` marker convention and parsed with `splitAt`. **Terminate each section with an explicit newline** — the previous milestone shipped a bug where `cat` without a trailing newline swallowed the next `@@` marker; do not repeat it.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add log discovery and follow command builders"
```

---

### Task 4: `GET /api/logs` and the log allowlist

**Files:**
- Modify: `src/modules/serverManager/routes.ts`
- Test: extend `src/modules/serverManager/__tests__/routes-test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /api/logs returns discovered files and units', ...);
test('discovery seeds the session allowlist', ...);
test('a path NOT surfaced by discovery is refused by the follow endpoint', ...);
test('file CONTENT cannot forge an allowlist entry', ...);  // the /api/file lesson
```

The fourth is mandatory. The previous milestone shipped a defect where remote file *content* could seed the `/api/file` allowlist because `cat` output shared a stream with `@@` markers. Discovery here lists filenames rather than contents, which is safer by construction — prove it, and constrain the allowlist to paths under `/var/log` the same way `/api/file` is constrained to the config globs.

- [ ] **Step 2-4: fail, implement, pass.** Reuse the existing `allowFiles`/session-allowlist mechanism rather than adding a parallel one.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add the logs discovery route"
```

---

### Task 5: `WS /ws/logs` live follow

**Files:**
- Create: `src/modules/serverManager/logFollow.ts`
- Test: `src/modules/serverManager/__tests__/log-follow-test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('follows an allowlisted file and streams lines to the socket', ...);
test('refuses a path that is not in the session allowlist', ...);
test('refuses an unsafe unit name', ...);
test('closing the socket kills the remote tail', ...);     // no leaked channel
test('a dropped connection kills the remote tail', ...);
test('backpressure: a slow socket does not buffer without bound', ...);
```

The last one matters: a `tail -F` on a busy log can outpace a socket. Cap the in-flight buffer and drop with a visible marker rather than growing memory in the extension host without bound.

- [ ] **Step 2-4: fail, implement, pass.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: stream live log follow over a websocket"
```

---

### Task 6: The Terminal tab

**Files:**
- Create: `webui/src/components/Terminal.jsx`
- Modify: `webui/src/App.jsx`, `webui/dev/mock-server.js`, `package.json` (devDeps)

- [ ] **Step 1: Add xterm to devDependencies**

```bash
npm install @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0 --save-dev
```

These are bundled into `media/webui` by Vite and never loaded by the extension host, which is why they are devDependencies and do not count against the one-new-runtime-dependency constraint.

- [ ] **Step 2: Build the tab**

Connect on mount, dispose on unmount (an undisposed xterm leaks a canvas and listeners). Send a resize control frame on mount and on container resize via the fit addon. Show connection state plainly — a terminal that is silently disconnected is worse than one that says so.

Follow the concurrency discipline established in `Services.jsx`: a `mountedRef` guard before every post-await `setState`.

**The dev mock must gain a WebSocket endpoint** so this is verifiable without a real host. Keep every identity in it fake — that file was previously seeded from a real server and scrubbed to RFC 5737 / RFC 6761 reserved values; never reintroduce a real one.

- [ ] **Step 3: Verify visually** — screenshot a connected terminal echoing input, and the disconnected state. Revert any temporary mock edit and prove it with `git diff --stat webui/dev/mock-server.js` showing empty.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add the Terminal tab"
```

---

### Task 7: The Logs tab

**Files:**
- Create: `webui/src/components/Logs.jsx`
- Modify: `webui/src/App.jsx`, `webui/dev/mock-server.js`

- [ ] **Step 1: Build the tab**

A source picker (discovered files with sizes, and journald units), a tail view, and a Follow toggle. Follow must be explicitly started, not automatic — attaching a live stream to a production log the instant a tab opens is a surprise. Cap the rendered buffer (the DOM cannot hold an unbounded log) and say so in the UI when lines are dropped.

Byte sizes render through the existing `format.ts` helpers; a `null` size renders as an em dash, never `0`.

- [ ] **Step 2: Verify visually** — the picker, a tail result, follow streaming, follow stopped, the empty state when nothing is discovered, and an error state. Revert mock edits.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add the Logs tab"
```

---

### Task 8: Verification, docs and release

**Files:** `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Full verification**

`npx jest` (baseline 649/1 known failure, plus this milestone's new tests), `npx tsc --noEmit -p .` clean for `src/`, `npm run build:webui`, `npx vsce package` with a non-zero `media/webui` file count.

**Confirm the packaged VSIX actually contains `ws`** — it is the first new runtime dependency this project has added in this effort, and a webpack externals mistake would produce an extension that fails at runtime with `Cannot find module 'ws'` while every test passes.

- [ ] **Step 2: Docs**

Document both tabs. State plainly that the Terminal runs as the **profile's SSH user** (not the root lane) and that it is a real interactive shell with the same power that user has. Document that log follow requires the same sudo/root arrangement as the other privileged reads, and cross-reference the existing sudo section rather than restating it.

- [ ] **Step 3: Bump to 1.25.0** in `package.json` AND `package-lock.json` (the version appears in more than one place in the lock).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: document Logs and Terminal; bump to 1.25.0"
```
