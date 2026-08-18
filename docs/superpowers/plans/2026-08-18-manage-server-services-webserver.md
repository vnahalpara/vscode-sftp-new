# Manage Server — Milestone 3: Services + Web Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on the Services and Web server tabs — list and control systemd units, and read nginx/apache virtual hosts with TLS expiry and a config test — over the connection's existing SSH channel.

**Architecture:** Every remote command is built by a **pure** builder and every response parsed by a **pure** parser, both fixture-tested; a thin exec layer joins them to the session's SSH transport and writes each privileged call to the activity log. The UI gains two tabs that light up automatically when the server flips their capability flags.

**Tech Stack:** TypeScript 3.9 for the server side, `.jsx` for the UI, jest for the parsers. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md`

**Reference implementation to port:** `/opt/homebrew/var/www/Local/Server-manager/server/ops.js` (lines 24-255) and `client/src/components/{Services,WebServer}.jsx`.

---

## This milestone is different, and the difference is the point

Milestones 1 and 2 only ever **read**. This one lets a browser page cause **`sudo systemctl restart` to run on a production server**. Three consequences run through every task:

1. **A unit name travels from the browser into a shell command.** That is a command-injection surface. It is defended three ways — an action allowlist, a unit-name pattern, and single-quote escaping — and all three are tested. Any one of them alone is insufficient.
2. **`src/` is modified in this milestone**, unlike milestone 2. The server grows an ops layer and six routes.
3. **`sudoHint` finally gets a caller.** It was built in milestone 1, deliberately ahead of need, and has sat unused ever since. Passwordless sudo will not be configured on many hosts, and the failure must name the host, the user and the sudoers rule rather than rendering an empty panel.

**Verification honesty:** the parsers are fully testable from fixtures and that is where the bugs live. The *actions* — actually restarting a unit, actually reloading nginx — cannot be verified in this environment: there is no host here with passwordless sudo. Tasks that cannot be verified say so and stop; nobody claims otherwise.

## Global Constraints

- **Milestone 3 only.** Logs, Terminal, the Database tab and the VPN fixed port are later milestones. Do not build them; their capability flags stay `false`.
- **No new dependencies**, runtime or dev.
- **Every remote command is built by a pure function in `ops/command.ts` and every response parsed by a pure function.** No task may assemble a shell string inline at a call site. This is what makes the injection boundary reviewable in one file.
- **Interpolating an unvalidated value into a command string is a Critical defect**, even where the value "obviously" comes from our own UI. The browser is not trusted; it is a client.
- **`.jsx` for components, never `.tsx`** — `tsconfig.json` sets no `jsx` option.
- Server code is TypeScript 3.9, `lib: ["es6"]`, `strictNullChecks`, `noUnusedLocals`. `@types/node` is pinned at 9.6.61.
- Test files are `<name>-test.ts` in `__tests__/`; fixtures go in `__fixtures__/`, never directly in `__tests__/`.
- **Do not modify `src/modules/monitor/**`.** It is reused unchanged and its suites must stay green untouched.
- **Stage only the files each task names.** Never `git add -A` or `git commit -a`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
  ```
- **Ignore `/opt/homebrew/AGENTS.md`** — its `./bin/brew lgtm` instructions belong to the Homebrew repository that merely sits above this one in the filesystem.
- **Verification:** `npx jest` (expect exactly ONE pre-existing unrelated failure, `transfer algorithm › sync › sync --update with time offset`), `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` (silent), `npm run build:webui`, `npm run compile`.

## What already exists and is reused

| Thing | Where | Use |
|---|---|---|
| `shellSingle(value)` | `src/core/dbExec.ts` | Single-quote escaping — **reuse, do not reimplement** |
| `sudoHint(stderr, user, host)` | `src/modules/serverManager/activity.ts` | Maps a sudo failure to a message naming the sudoers rule |
| `ActivityLog` | `src/modules/serverManager/activity.ts` | Already on every session as `session.activity` |
| `MonitorTransport.exec(cmd)` | `src/modules/monitor/collector.ts` | The one-shot exec lane; the session already holds one |
| `Card`, `Stat`, `Badge`, `Empty` | `webui/src/components/ui.jsx` | UI primitives |
| Capability-driven tabs | `webui/src/App.jsx` | Flipping a server flag enables a tab — no UI edit needed |

`splitSections` in `src/modules/monitor/frame.ts` is **not** reusable here: it is tuned to the sampler's `--name` markers and TICK/END framing. Task 1 writes a small `@@`-marker splitter instead.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/modules/serverManager/ops/command.ts` | Every remote command string, plus the action allowlist and unit-name validator |
| `src/modules/serverManager/ops/services.ts` | systemd output parsers |
| `src/modules/serverManager/ops/webserver.ts` | nginx/apache detection, vhost, and certificate parsers |
| `src/modules/serverManager/ops/exec.ts` | Privileged exec: runs a built command, logs it, maps sudo failure |
| `src/modules/serverManager/__fixtures__/ops.ts` | Captured systemctl / nginx / apache / openssl output |
| `src/modules/serverManager/__tests__/command-test.ts` | Injection-boundary tests |
| `src/modules/serverManager/__tests__/ops-services-test.ts` | systemd parser tests |
| `src/modules/serverManager/__tests__/ops-webserver-test.ts` | vhost and certificate parser tests |
| `webui/src/components/Services.jsx` | Services tab |
| `webui/src/components/WebServer.jsx` | Web server tab |

**Modified:** `src/modules/serverManager/routes.ts` (six routes, two capability flags), `webui/src/App.jsx` (mount the two tabs), `webui/dev/mock-server.js` (fixtures for both tabs, including a sudo failure), `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`.

---

### Task 1: Command builders and the injection boundary

The security boundary of the milestone. Built first and tested hardest, so nothing downstream can inject by accident.

**Files:**
- Create: `src/modules/serverManager/ops/command.ts`
- Test: `src/modules/serverManager/__tests__/command-test.ts`

**Interfaces produced:**
- `SERVICE_ACTIONS: string[]` — exactly `start`, `stop`, `restart`, `reload`, `reload-or-restart`
- `isAllowedAction(action: string): boolean`
- `isSafeUnitName(unit: string): boolean`
- `splitAt(text: string): { [key: string]: string }` — splits `@@key` sections
- `servicesCommand(): string`
- `serviceActionCommand(unit: string, action: string): string` — **throws** on invalid input
- `serviceStatusCommand(unit: string): string` — **throws** on invalid input
- `detectWebServerCommand(): string`
- `configFilesCommand(kind: 'nginx' | 'apache'): string`
- `testConfigCommand(kind: 'nginx' | 'apache'): string`
- `certInfoCommand(paths: string[]): string`
- `readFileCommand(path: string, lines: number): string`

Notes binding the implementation:
- **`enable` and `disable` are deliberately NOT allowed.** They change boot behaviour, which is a different class of decision from restarting a running service, and nothing in this milestone's UI offers them.
- `isSafeUnitName` accepts `[A-Za-z0-9._@:-]+` up to 128 characters and nothing else. Real unit names like `php8.2-fpm@www.service` and `getty@tty1.service` must pass; anything containing a space, quote, backtick, `$`, `;`, `|`, `&`, newline, or a path separator must fail.
- Every interpolated value goes through `shellSingle` from `src/core/dbExec.ts` **as well as** validation. Belt and braces, because the validator is a denylist of consequences and the escaper is a positive guarantee.
- `certInfoCommand` and `readFileCommand` take **paths**, which cannot be pattern-validated the way unit names can — a legitimate certificate path contains `/`. They rely on `shellSingle` alone, and their tests must prove a path containing a single quote cannot break out.

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/command-test.ts` covering, at minimum:

```ts
import {
  SERVICE_ACTIONS, isAllowedAction, isSafeUnitName, splitAt,
  servicesCommand, serviceActionCommand, serviceStatusCommand,
  detectWebServerCommand, configFilesCommand, testConfigCommand,
  certInfoCommand, readFileCommand,
} from '../ops/command';

describe('isAllowedAction', () => {
  it('allows exactly the five documented actions', () => {
    expect(SERVICE_ACTIONS.slice().sort()).toEqual(
      ['reload', 'reload-or-restart', 'restart', 'start', 'stop']
    );
  });
  it('rejects enable and disable, which change boot behaviour', () => {
    expect(isAllowedAction('enable')).toBe(false);
    expect(isAllowedAction('disable')).toBe(false);
  });
  it('rejects anything not on the list', () => {
    ['', 'mask', 'restart; rm -rf /', 'RESTART', 'restart '].forEach(a =>
      expect(isAllowedAction(a)).toBe(false)
    );
  });
});

describe('isSafeUnitName', () => {
  it('accepts real unit names', () => {
    ['nginx', 'nginx.service', 'php8.2-fpm@www.service', 'getty@tty1.service', 'my_app.service']
      .forEach(u => expect(isSafeUnitName(u)).toBe(true));
  });
  it('rejects every shell metacharacter', () => {
    [
      'nginx; rm -rf /', 'nginx && reboot', 'nginx | tee x', 'nginx`id`',
      'nginx$(id)', "nginx'", 'nginx"', 'nginx\nrestart', 'nginx x',
      '../../etc/passwd', '/etc/passwd', '',
    ].forEach(u => expect(isSafeUnitName(u)).toBe(false));
  });
  it('rejects an absurdly long name', () => {
    expect(isSafeUnitName('a'.repeat(129))).toBe(false);
  });
});

describe('serviceActionCommand', () => {
  it('builds a quoted systemctl call', () => {
    expect(serviceActionCommand('nginx.service', 'restart'))
      .toBe(`sudo -n systemctl restart 'nginx.service'`);
  });
  it('throws rather than building anything for a bad action', () => {
    expect(() => serviceActionCommand('nginx', 'enable')).toThrow();
  });
  it('throws rather than building anything for a bad unit', () => {
    expect(() => serviceActionCommand('nginx; reboot', 'restart')).toThrow();
  });
  it('never emits an unquoted unit name', () => {
    // Property check: whatever passes validation must still be quoted.
    expect(serviceActionCommand('php8.2-fpm@www.service', 'reload'))
      .toContain(`'php8.2-fpm@www.service'`);
  });
});

describe('certInfoCommand', () => {
  it('escapes a path containing a single quote so it cannot break out', () => {
    const cmd = certInfoCommand(["/etc/ssl/o'brien.pem"]);
    expect(cmd).toContain(`'/etc/ssl/o'\\''brien.pem'`);
    expect(cmd).not.toMatch(/;\s*rm/);
  });
  it('de-duplicates and drops empty paths', () => {
    const cmd = certInfoCommand(['/a.pem', '/a.pem', '', null as any]);
    expect(cmd.match(/openssl/g)!.length).toBe(1);
  });
  it('returns an empty string for no paths, so no command is run at all', () => {
    expect(certInfoCommand([])).toBe('');
  });
});

describe('splitAt', () => {
  it('splits @@-prefixed sections', () => {
    expect(splitAt('@@units\na\nb\n@@files\nc')).toEqual({ units: 'a\nb', files: 'c' });
  });
  it('returns an empty object for output with no markers', () => {
    expect(splitAt('noise')).toEqual({});
  });
  it('keeps a section that is present but empty', () => {
    expect(splitAt('@@units\n@@files\nc')).toEqual({ units: '', files: 'c' });
  });
});
```

Add equivalent tests for `serviceStatusCommand` (throws on a bad unit), `configFilesCommand` / `testConfigCommand` (reject a `kind` other than `nginx`/`apache`), and `readFileCommand` (escapes its path, clamps `lines` to a sane maximum).

- [ ] **Step 2: Run it and confirm it fails** — `npx jest src/modules/serverManager/__tests__/command-test.ts`, expect `Cannot find module '../ops/command'`.

- [ ] **Step 3: Implement `ops/command.ts`**, importing `shellSingle` from `../../../core/dbExec`. Port the command strings from the reference `ops.js` (lines 24-30 for services, 89-101 for detection, 141-143 for config globs, 244-249 for configtest, 260-266 for certificates), replacing every interpolation with `shellSingle` and every action/unit with a validated value.

- [ ] **Step 4: Run the tests** — all pass.

- [ ] **Step 5: Types** — `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/serverManager/ops/command.ts src/modules/serverManager/__tests__/command-test.ts
git commit -m "$(cat <<'EOF'
feat: add server manager remote command builders

Every command that reaches a production shell is built here, so the
injection boundary is one reviewable file. Unit names are validated AND
quoted: the validator rejects known-bad shapes, the quoting is the
positive guarantee.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 2: systemd parsers

**Files:**
- Create: `src/modules/serverManager/ops/services.ts`, `src/modules/serverManager/__fixtures__/ops.ts`
- Test: `src/modules/serverManager/__tests__/ops-services-test.ts`

**Interfaces produced:**
- `interface ServiceRow { unit; name; load; active; sub; enabled; description }`
- `parseUnits(text: string): ServiceRow[]` — from `systemctl list-units`
- `parseUnitFiles(text: string): { [unit: string]: string }` — from `systemctl list-unit-files`
- `mergeServices(units, files): ServiceRow[]`
- `sortServices(rows: ServiceRow[]): ServiceRow[]` — active first, then failed, then the rest, alphabetical within each
- `filterServices(rows: ServiceRow[], needle: string): ServiceRow[]`

Fixtures must include real-world awkwardness: a unit whose description contains multiple spaces, a `●` bullet prefix (systemd emits one for failed units on some versions), a `not-found` load state, a templated unit `getty@tty1.service`, a non-`.service` unit that must be skipped, and a completely empty listing.

Behaviour worth pinning in tests: `enabled` is `'unknown'` when the unit appears in `list-units` but not in `list-unit-files`; a malformed line with fewer than four fields is skipped rather than producing a row of `undefined`s; sorting puts `failed` above `inactive` because a failed unit is the thing an operator came to find.

Standard TDD steps, then commit as `feat: add systemd output parsers for the server manager`.

---

### Task 3: Web server and certificate parsers

The task with the highest bug density in the reference implementation, and the fixtures exist to pin exactly those bugs.

**Files:**
- Create: `src/modules/serverManager/ops/webserver.ts`
- Extend: `src/modules/serverManager/__fixtures__/ops.ts`
- Test: `src/modules/serverManager/__tests__/ops-webserver-test.ts`

**Interfaces produced:**
- `interface Vhost { file; serverName; aliases; listen: string[]; ssl; root; certificate; accessLog; errorLog; proxyPass }`
- `interface WebServerInfo { kind: 'nginx' | 'apache'; unit; version; active; enabled }`
- `stripComments(text: string): string`
- `nginxServerBlocks(raw: string): string[]`
- `directive(block: string, name: string): string | null`
- `directiveAll(block: string, name: string): string[]`
- `parseNginxVhosts(files: { file: string; content: string }[]): Vhost[]`
- `parseApacheVhosts(files: { file: string; content: string }[]): Vhost[]`
- `parseDetect(text: string): { servers: WebServerInfo[]; listening: string[] }`
- `parseCertInfo(text: string, now: number): CertInfo[]` — `now` is a parameter, never `Date.now()`, so expiry maths is testable

**The three fixtures that matter most**, because each pins a real defect:

1. **Ubuntu's commented-out default HTTPS block.** `/etc/nginx/sites-enabled/default` ships with an entire `server { ... }` block commented out line by line with `#`. Without comment stripping it parses as a real vhost, and the panel shows a site that does not exist. The reference implementation hit this. A test must assert the commented block produces **no** vhost.
2. **Nested `location` blocks.** A `server` block containing `location / { ... }` breaks naive regex extraction — the brace matcher must find the block's true end. A test must assert a `server` block with two nested `location` blocks yields exactly one vhost with the correct `root`.
3. **A `#` inside a quoted string.** `server_name example.com; # comment` must strip, but a `#` inside a value should not truncate it wrongly. Pin whatever the implementation does, and say in the test name whether it is a limitation being documented rather than a behaviour being blessed.

Also pin: a `listen 443 ssl http2;` line sets `ssl: true`; `ssl` is also true when `ssl_certificate` is present without `443`; a vhost with no `server_name` reports `_`; and `parseCertInfo` computes `daysLeft` from the injected `now`, returning `null` plus an `error` string when openssl failed instead of a bogus date.

Standard TDD steps, then commit as `feat: add nginx and apache config parsers for the server manager`.

---

### Task 4: Privileged exec and activity logging

**Files:**
- Create: `src/modules/serverManager/ops/exec.ts`
- Test: `src/modules/serverManager/__tests__/ops-exec-test.ts`

**Interfaces produced:**
- `interface OpsDeps { exec(cmd: string): Promise<{ stdout; stderr; code }>; activity: ActivityLog; user: string; host: string; now(): number }`
- `runPrivileged(deps: OpsDeps, label: string, command: string): Promise<{ stdout; stderr; code }>`

Requirements:
- Every call appends an `ActivityEntry` with the label, the command, the exit code and the duration — **whether it succeeded or failed**. An action that failed is exactly the one an operator needs to see in the log.
- On a non-zero exit whose stderr matches a sudo failure, throw an error carrying `sudoHint(stderr, user, host)`. This is `sudoHint`'s first caller.
- A non-sudo failure throws with the trimmed stderr, or a generic message naming the exit code when stderr is empty.
- `now` is injected so duration is testable.
- The command is logged **verbatim**. It contains no secrets — these are `systemctl` and `openssl` calls, not credentials — but state that in a comment so nobody later logs something that does.

Tests use a fake `exec` and a real `ActivityLog`: success logs code 0; failure logs the non-zero code and still throws; a sudo-failure stderr produces a message containing the user, the host and `NOPASSWD`; duration comes from the injected clock.

Commit as `feat: add privileged exec with activity logging for the server manager`.

---

### Task 5: Routes

**Files:**
- Modify: `src/modules/serverManager/routes.ts`
- Test: extend `src/modules/serverManager/__tests__/routes-test.ts`

Six routes, all session-scoped and token-gated by the existing `httpServer`:

```
GET  /api/services                    { services: ServiceRow[] }
POST /api/services/:unit/:action      { ok, output }
GET  /api/services/:unit/status       { output }
GET  /api/webserver                   { servers, listening }
GET  /api/webserver/:kind/vhosts      { vhosts, certificates }
POST /api/webserver/:kind/test        { ok, output }
GET  /api/file?path=                  { content }
```

And flip **`services: true`** and **`webserver: true`** in `CAPABILITIES`. That is the entire mechanism by which the two tabs stop being greyed out — no UI edit is needed, and milestone 2's review specifically verified this path works.

Requirements:
- An invalid `:action` or `:unit` must return **400**, not 500 — the builder throws, and the route must translate that into a client error rather than an internal one.
- An unknown `:kind` returns 400.
- `GET /api/file` is for viewing a vhost config from the UI's View button. It is **not** a general file browser: restrict it to paths the vhost listing actually returned for this session, or state plainly in a comment why that is not enforced and what the exposure is. Reaching this endpoint requires a valid token, but "already authenticated" is not a reason to hand out arbitrary file reads.
- Existing tests must keep passing; the token-leak test now covers more endpoints, so extend its list.

Commit as `feat: add the services and web server API surface`.

---

### Task 6: Mock server fixtures

The harness must grow with the surface, or Tasks 7 and 8 are unverifiable.

**Files:** Modify `webui/dev/mock-server.js`

Add: a services listing of ~12 units including one `failed` and one `inactive`; nginx **and** apache both detected; a vhost listing with one plain HTTP vhost, one SSL vhost with a certificate expiring in 44 days, and one expiring in 5 days so the warning tone is visible; a `configtest` that succeeds; and — importantly — **a way to make an action fail with a sudo error**, so the sudo-hint path is exercisable in the browser rather than only in a unit test. A query flag such as `?fail=sudo` on the action endpoint is enough.

Commit as `build: extend the dev mock server with services and web server fixtures`.

---

### Task 7: Services tab

**Files:** Create `webui/src/components/Services.jsx`; modify `webui/src/App.jsx`

Port from the reference `client/src/components/Services.jsx`. Requirements beyond the port:

- A filter box, and a table of unit, description, load/active/sub, enabled state, and actions.
- **Every action opens a confirmation naming the unit and the action.** These run against production servers; a misclick must not restart a database.
- While an action is in flight the row disables, and the result — including a sudo hint — appears inline rather than in a toast that can be missed.
- A failed unit is visually distinct from an inactive one.
- Empty state when no units match the filter; `Empty` primitive when the host returned nothing at all.

Verify against the mock, including the `?fail=sudo` path, and screenshot. Commit as `feat: add the Services tab`.

---

### Task 8: Web server tab

**Files:** Create `webui/src/components/WebServer.jsx`; modify `webui/src/App.jsx`

Port from the reference `client/src/components/WebServer.jsx`. Requirements:

- One card per detected server (nginx, apache) with version, unit, active/enabled state and Reload / Restart / Stop / Start behind confirmations.
- A vhost table: server name, listen, document root or upstream, TLS certificate with days remaining toned by `toneForPct`-style thresholds (green > 30 days, amber 8-30, red ≤ 7), and a **View** button showing the config file.
- A **Test config** button surfacing the real output on both success and failure — a failed `nginx -t` message is the most useful thing on the page when something is broken.
- Empty state when neither server is installed. That is a normal answer, not an error.

Verify against the mock and screenshot. Commit as `feat: add the Web server tab`.

---

### Task 9: Verification, docs and release

- Full suite, tsc, both builds, `vsce package` with the `media/webui` count non-zero.
- README: describe both tabs and **state the sudo requirement plainly** — passwordless sudo for `systemctl` and the web server control binaries, or the actions will fail with a hint rather than working.
- CHANGELOG entry; bump `package.json` **and** `package-lock.json` to `1.24.0`.
- Report explicitly which behaviours were verified against the mock only and which remain unverified against a real host — the actions in particular.

Commit as `chore: document Services and Web server; bump to 1.24.0`.

---

## Self-Review

**Spec coverage.** The spec's ops layer (`ops/services.ts`, `ops/webserver.ts`), its API surface (`/api/services`, `/api/services/:unit/:action`, `/api/webserver`, `/api/webserver/:kind/vhosts`, `/api/webserver/:kind/test`, `/api/file`), its Services and Web server tab contents, its sudo error mapping, and its "every privileged action is logged to Activity" requirement are covered by Tasks 1-8. The spec's fixture-driven testing discipline is Tasks 1-4.

**Out of scope by design:** Logs, Terminal, Database, VPN fixed port. Their capability flags stay `false`.

**Placeholder scan.** Tasks 2, 3, 7 and 8 specify behaviours and fixtures rather than inlining full implementations, as milestone 2 did for its ports — the reference files exist at named paths and every required export and deviation is stated. Task 1, the security boundary, inlines its tests in full precisely because it is the one place where "roughly right" is not good enough.

**Type consistency.** `ServiceRow` (Task 2) is what Task 5 serialises and Task 7 renders. `Vhost` and `CertInfo` (Task 3) likewise for Task 8. `OpsDeps` (Task 4) is constructed in Task 5 from the session's transport, `session.activity`, and the profile's `username`/`host`.

**The risk I want named.** Tasks 7 and 8 are verifiable only against the mock. The actions themselves — restarting a real unit, reloading a real nginx — need a host with passwordless sudo, which does not exist in this environment. Task 9 must say so rather than implying end-to-end coverage. The parsers, which is where the bugs actually live, are fully covered from fixtures.
