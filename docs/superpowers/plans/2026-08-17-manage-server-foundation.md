# Manage Server — Milestone 1: Server Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a **Manage Server** command on the Remote Explorer root that starts a loopback HTTP server inside the extension host and opens Chrome on a live, token-authenticated page streaming that connection's metrics — and delete the old Open Monitoring webview.

**Architecture:** The extension host is a Node process, so an `http.Server` lives inside it and answers API calls by driving the *existing* `SSHClient` that `getSshClient()` already returns. Each invocation creates a **managed session** — one profile, one random token, one `Collector` — and the token in the URL is what identifies the session on every request. Metrics reach the browser over Server-Sent Events; the monitor module's data layer (`probe` / `frame` / `parse` / `metrics` / `collector` / `transport`) is reused untouched.

**Tech Stack:** TypeScript 3.9 (target es6, `lib: ["es6"]`, `strictNullChecks`, `noUnusedLocals`), `node:http` with a hand-rolled router, jest 29 via `test/preprocessor.js`, ssh2 through the existing `SSHClient`. **No new runtime dependencies in this milestone.**

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md`

## Global Constraints

- **Milestone 1 only.** The React UI, Services, Web server, Logs, Terminal, the Database tab and the VPN fixed port are later milestones and are explicitly out of scope. Do not add them, and do not add `ws`, `react`, `vite` or `recharts` to `package.json`.
- **No new runtime dependencies.** Everything in this milestone is `node:http`, `node:crypto`, `node:path`, `node:fs`, `node:url` and `node:child_process`.
- **No native modules, ever.** `better-sqlite3` from the reference app is not ported. History is the existing in-memory ring.
- **Bind `127.0.0.1` only.** Never `0.0.0.0`, not behind a setting, not in a test.
- **The API never returns `password`, `passphrase`, `ssh_prefix`, `interactiveAuth`, `git.password`, or `database[].password`.** Redaction is an **allowlist** in `registry.ts`, never a denylist — a denylist silently leaks every field added to `sftp.json` after it was written.
- **Auth applies to `/api/*` only.** Static files and the bootstrap page are not secret; the data is. Every `/api/*` request needs a valid token, in `?t=` or the `x-sftp-token` header.
- **SFTP only.** FTP has no exec channel; reject before any work.
- **Linux remote only.** Collection reads `/proc`. Non-Linux hosts get an explicit unsupported state, not empty cards.
- **Session identity is the token, not a URL path.** The opening URL is `http://127.0.0.1:<port>/?t=<token>`. There is no `#/host/<id>` route — one window can only ever reach its own host. `profileId()` still exists, to stop a second invocation on the same profile from opening a second session.
- **Fixtures must NOT live directly in `__tests__/`.** jest `testMatch` is `<rootDir>/**/*/__tests__/*.ts`, so any `.ts` placed there is collected as a suite and fails with "Your test suite must contain at least one test." Reuse `src/modules/monitor/__fixtures__/proc.ts`; add new fixtures to `src/modules/serverManager/__fixtures__/`.
- **Test file naming:** `<name>-test.ts` inside `__tests__/`, matching the repo convention.
- **`noUnusedLocals` is on.** An unused import or variable fails the compile, not just a lint.
- **`lib` is `["es6"]` — there is no DOM lib.** Browser-side code lives inside template strings in `bootstrap.ts` and is never type-checked. Do not import DOM types.
- **No version bump in this milestone.** `package.json` stays at `1.21.0`; the bump ships with the milestone that delivers the React UI.
- **Every commit message ends with these two trailers:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
  ```
- **Stage only the files each task names.** The working tree contains unrelated uncommitted DB-export / reconnect work (`src/commands/commandDbExport*.ts`, `src/commands/commandReconnect.ts`, `src/modules/dbExport.ts`, `src/core/db*.ts`) that must never enter these commits. Never use `git add -A` or `git commit -a`.
- **Verification commands:**
  - Tests: `npx jest src/modules/serverManager` (or a single file, or `-t '<name>'`).
  - Full suite: `npx jest`.
  - Types: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — must print nothing. Errors from `node_modules` are pre-existing noise from TS 3.9 vs modern typings; ignore them.
  - Build: `npm run compile`.
  - **Baseline:** `npx jest` currently reports **1 pre-existing failure** — `transfer algorithm › sync › sync --update with time offset`. That failure is not yours; do not fix it, and do not treat it as a regression.
- **Ignore `/opt/homebrew/AGENTS.md`.** Its `./bin/brew lgtm` instructions belong to the Homebrew/brew repository, which merely sits above this one in the filesystem. This repo verifies with the jest/tsc/webpack commands above.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/modules/serverManager/registry.ts` | Profile identity and allowlist redaction — the security boundary |
| `src/modules/serverManager/router.ts` | Pure method + path-pattern matching with `:param` capture |
| `src/modules/serverManager/sse.ts` | Server-Sent Events framing and per-session subscriber fan-out |
| `src/modules/serverManager/activity.ts` | Bounded log of privileged commands; `sudo` failure mapping |
| `src/modules/serverManager/session.ts` | One managed profile: collector lifecycle, subscriber refcount, grace period |
| `src/modules/serverManager/httpServer.ts` | `node:http` glue: auth, routing, static serving, path-traversal defence |
| `src/modules/serverManager/bootstrap.ts` | Self-contained diagnostics page served when no UI build exists |
| `src/modules/serverManager/routes.ts` | The milestone-1 REST + SSE surface |
| `src/modules/serverManager/index.ts` | Server singleton, session store, browser launch, disposal |
| `src/commands/commandManageServer.ts` | The command; auto-registered |
| `src/modules/serverManager/__tests__/*-test.ts` | Test suites |

**Modified:**

| File | Change |
|---|---|
| `src/constants.ts` | Add `COMMAND_MANAGE_SERVER`, remove `COMMAND_OPEN_MONITORING` |
| `src/extension.ts` | `serverManager.disposeAll()` in `deactivate()` |
| `package.json` | Command + menu contributions, `sftp.serverManager.*` settings, remove `sftp.monitor.*` |
| `README.md` | Replace the Monitoring section |

**Deleted:**

| File | Reason |
|---|---|
| `src/modules/monitor/html.ts` | 460 lines of hand-written webview markup, replaced by the browser UI |
| `src/modules/monitor/__tests__/html-test.ts` | Tests the deleted file |
| `src/modules/monitor/index.ts` | Webview panel plumbing, replaced by `serverManager/session.ts` |
| `src/commands/commandOpenMonitoring.ts` | Replaced by `commandManageServer.ts` |

**Untouched and reused:** `src/modules/monitor/{probe,frame,parse,metrics,collector,transport,types}.ts` and their 11 remaining test files. Those tests staying green without edits is the check that the data layer was genuinely reused rather than rewritten.

---

### Task 1: Profile identity and redaction

The security boundary of the whole feature. Built first and tested hardest, so nothing downstream can leak by accident.

**Files:**
- Create: `src/modules/serverManager/registry.ts`
- Test: `src/modules/serverManager/__tests__/registry-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `profileId(workspace: string, config: any): string` — 16 lowercase hex chars
  - `redactProfile(workspace: string, config: any): RedactedProfile`
  - `interface RedactedProfile { id: string; name: string; host: string; port: number; username: string; protocol: string; remotePath: string; workspace: string; hasVpn: boolean; hasDatabase: boolean }`

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/registry-test.ts`:

```ts
import { profileId, redactProfile } from '../registry';

// Every secret this repo is known to put in sftp.json, with distinctive values
// so a leak is unambiguous in an assertion failure.
const SECRETS = [
  'hunter2',
  'sshpass -p hunter2',
  'my-passphrase',
  'interactive-secret',
  'glpat-abcdef',
  'db-root-password',
];

const CONFIG = {
  name: 'prod',
  host: '10.0.0.5',
  port: 2222,
  username: 'deploy',
  password: 'hunter2',
  passphrase: 'my-passphrase',
  ssh_prefix: 'sshpass -p hunter2',
  interactiveAuth: ['interactive-secret'],
  protocol: 'sftp',
  remotePath: '/var/www',
  vpn: { configFile: '/etc/wireguard/wg0.conf' },
  git: { username: 'bot', password: 'glpat-abcdef' },
  database: [{ name: 'shop', user: 'root', password: 'db-root-password' }],
};

describe('profileId', () => {
  it('is stable for the same workspace and connection', () => {
    expect(profileId('/ws', CONFIG)).toBe(profileId('/ws', CONFIG));
  });

  it('is 16 lowercase hex characters', () => {
    expect(profileId('/ws', CONFIG)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates same-named profiles in different workspace folders', () => {
    expect(profileId('/ws-a', CONFIG)).not.toBe(profileId('/ws-b', CONFIG));
  });

  it('separates profiles that differ only by host or port', () => {
    const other = { ...CONFIG, host: '10.0.0.6' };
    const otherPort = { ...CONFIG, port: 22 };
    expect(profileId('/ws', other)).not.toBe(profileId('/ws', CONFIG));
    expect(profileId('/ws', otherPort)).not.toBe(profileId('/ws', CONFIG));
  });

  it('does not collide when name and host are swapped around the separator', () => {
    // Naive concatenation would make {name:'a', host:'b'} and {name:'ab', host:''}
    // hash identically. The NUL separator is what prevents that.
    const a = profileId('/ws', { name: 'a', host: 'b', port: 22 });
    const b = profileId('/ws', { name: 'ab', host: '', port: 22 });
    expect(a).not.toBe(b);
  });
});

describe('redactProfile', () => {
  it('exposes exactly the fields the UI needs', () => {
    expect(redactProfile('/ws', CONFIG)).toEqual({
      id: profileId('/ws', CONFIG),
      name: 'prod',
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      protocol: 'sftp',
      remotePath: '/var/www',
      workspace: '/ws',
      hasVpn: true,
      hasDatabase: true,
    });
  });

  it('leaks no secret when serialised', () => {
    const json = JSON.stringify(redactProfile('/ws', CONFIG));
    SECRETS.forEach(secret => expect(json).not.toContain(secret));
  });

  it('survives a config that grows a new secret field', () => {
    // The allowlist, not a denylist, is what makes this pass.
    const grown = { ...CONFIG, futureToken: 'a-brand-new-secret' };
    const json = JSON.stringify(redactProfile('/ws', grown));
    expect(json).not.toContain('a-brand-new-secret');
  });

  it('falls back to the host when the profile has no name', () => {
    const nameless = { ...CONFIG, name: undefined };
    expect(redactProfile('/ws', nameless).name).toBe('10.0.0.5');
  });

  it('defaults port to 22 and reports no vpn or database when absent', () => {
    const bare = { host: 'example.com', username: 'root', protocol: 'sftp' };
    const out = redactProfile('/ws', bare);
    expect(out.port).toBe(22);
    expect(out.hasVpn).toBe(false);
    expect(out.hasDatabase).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/registry-test.ts`
Expected: FAIL — `Cannot find module '../registry'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/registry.ts`:

```ts
import * as crypto from 'crypto';

export interface RedactedProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: string;
  remotePath: string;
  workspace: string;
  hasVpn: boolean;
  hasDatabase: boolean;
}

// Two workspace folders can each hold a profile called "prod", so the folder
// path is part of the identity. The NUL separator stops {name:'a',host:'b'}
// from hashing the same as {name:'ab',host:''}.
export function profileId(workspace: string, config: any): string {
  const key = [
    workspace,
    config.name || '',
    config.host || '',
    String(config.port || 22),
  ].join(' ');
  return crypto
    .createHash('sha1')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

// An allowlist, deliberately. A denylist of secret keys would silently start
// leaking the day someone adds a new credential field to sftp.json.
//
// `username` is intentionally included: the UI header shows root@host:port, and
// a username is not a secret the way a password is.
export function redactProfile(workspace: string, config: any): RedactedProfile {
  return {
    id: profileId(workspace, config),
    name: config.name || config.host || '',
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    protocol: config.protocol || 'sftp',
    remotePath: config.remotePath || '/',
    workspace,
    hasVpn: Boolean(config.vpn && config.vpn.configFile),
    hasDatabase: Array.isArray(config.database) && config.database.length > 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/registry-test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Check types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/modules/serverManager/registry.ts src/modules/serverManager/__tests__/registry-test.ts
git commit -m "$(cat <<'EOF'
feat: add server manager profile identity and redaction

Redaction is an allowlist rather than a denylist so a new credential
field in sftp.json cannot leak by omission.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 2: Route matching

**Files:**
- Create: `src/modules/serverManager/router.ts`
- Test: `src/modules/serverManager/__tests__/router-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RouteParams { [name: string]: string }`
  - `interface Route<H> { method: string; path: string; handler: H }`
  - `interface RouteMatch<H> { handler: H; params: RouteParams }`
  - `matchRoute<H>(routes: Route<H>[], method: string, pathname: string): RouteMatch<H> | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/router-test.ts`:

```ts
import { matchRoute, Route } from '../router';

const ROUTES: Route<string>[] = [
  { method: 'GET', path: '/api/session', handler: 'session' },
  { method: 'GET', path: '/api/host', handler: 'host' },
  { method: 'POST', path: '/api/host/refresh', handler: 'refresh' },
  { method: 'POST', path: '/api/services/:unit/:action', handler: 'service' },
];

describe('matchRoute', () => {
  it('matches an exact path', () => {
    const m = matchRoute(ROUTES, 'GET', '/api/session');
    expect(m && m.handler).toBe('session');
    expect(m && m.params).toEqual({});
  });

  it('captures named parameters', () => {
    const m = matchRoute(ROUTES, 'POST', '/api/services/nginx/restart');
    expect(m && m.handler).toBe('service');
    expect(m && m.params).toEqual({ unit: 'nginx', action: 'restart' });
  });

  it('percent-decodes captured parameters', () => {
    const m = matchRoute(ROUTES, 'POST', '/api/services/php8.2-fpm%40www/restart');
    expect(m && m.params.unit).toBe('php8.2-fpm@www');
  });

  it('does not match on the wrong method', () => {
    expect(matchRoute(ROUTES, 'POST', '/api/session')).toBeNull();
  });

  it('does not match a longer or shorter path', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/session/extra')).toBeNull();
    expect(matchRoute(ROUTES, 'GET', '/api')).toBeNull();
  });

  it('ignores a trailing slash', () => {
    const m = matchRoute(ROUTES, 'GET', '/api/session/');
    expect(m && m.handler).toBe('session');
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/nope')).toBeNull();
  });

  it('prefers the first matching route when two could match', () => {
    // A literal segment declared before a parameter wins, which is what lets
    // /api/host/refresh coexist with a future /api/host/:field.
    const routes: Route<string>[] = [
      { method: 'GET', path: '/api/host/refresh', handler: 'literal' },
      { method: 'GET', path: '/api/host/:field', handler: 'param' },
    ];
    const m = matchRoute(routes, 'GET', '/api/host/refresh');
    expect(m && m.handler).toBe('literal');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/router-test.ts`
Expected: FAIL — `Cannot find module '../router'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/router.ts`:

```ts
export interface RouteParams {
  [name: string]: string;
}

export interface Route<H> {
  method: string;
  path: string;
  handler: H;
}

export interface RouteMatch<H> {
  handler: H;
  params: RouteParams;
}

// Filtering empties is what makes '/api/session' and '/api/session/' the same
// route, and it costs nothing.
function segments(pathname: string): string[] {
  return pathname.split('/').filter(part => part.length > 0);
}

// Routes are tried in declaration order, so a literal segment listed before a
// parameter always wins over it.
export function matchRoute<H>(
  routes: Route<H>[],
  method: string,
  pathname: string
): RouteMatch<H> | null {
  const want = segments(pathname);

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const have = segments(route.path);
    if (have.length !== want.length) {
      continue;
    }

    const params: RouteParams = {};
    let matched = true;
    for (let i = 0; i < have.length; i++) {
      const declared = have[i];
      if (declared.charAt(0) === ':') {
        params[declared.slice(1)] = decodeURIComponent(want[i]);
      } else if (declared !== want[i]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { handler: route.handler, params };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/router-test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/router.ts src/modules/serverManager/__tests__/router-test.ts
git commit -m "$(cat <<'EOF'
feat: add pure route matching for the server manager

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 3: Server-Sent Events fan-out

**Files:**
- Create: `src/modules/serverManager/sse.ts`
- Test: `src/modules/serverManager/__tests__/sse-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SseSink { write(chunk: string): void; end(): void }`
  - `formatEvent(event: string, data: any): string`
  - `class SseChannel` with `add(sink): () => void`, `send(event, data): void`, `ping(): void`, `count(): number`, `closeAll(): void`

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/sse-test.ts`:

```ts
import { SseChannel, formatEvent, SseSink } from '../sse';

class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  throwOnWrite = false;

  write(chunk: string) {
    if (this.throwOnWrite) {
      throw new Error('EPIPE');
    }
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
}

describe('formatEvent', () => {
  it('emits a named event with a JSON payload and a blank-line terminator', () => {
    expect(formatEvent('tick', { cpu: 12 })).toBe('event: tick\ndata: {"cpu":12}\n\n');
  });

  it('keeps the payload on one line even when it contains newlines', () => {
    // JSON.stringify escapes them, which is what keeps the frame parseable.
    const frame = formatEvent('error', { message: 'line one\nline two' });
    expect(frame.split('\n').length).toBe(4);
    expect(frame).toContain('line one\\nline two');
  });
});

describe('SseChannel', () => {
  it('fans one event out to every subscriber', () => {
    const channel = new SseChannel();
    const a = new FakeSink();
    const b = new FakeSink();
    channel.add(a);
    channel.add(b);

    channel.send('tick', { n: 1 });

    expect(a.chunks).toEqual(['event: tick\ndata: {"n":1}\n\n']);
    expect(b.chunks).toEqual(['event: tick\ndata: {"n":1}\n\n']);
  });

  it('counts live subscribers', () => {
    const channel = new SseChannel();
    expect(channel.count()).toBe(0);
    const off = channel.add(new FakeSink());
    expect(channel.count()).toBe(1);
    off();
    expect(channel.count()).toBe(0);
  });

  it('stops writing to a subscriber after it unsubscribes', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    const off = channel.add(sink);
    off();

    channel.send('tick', { n: 1 });

    expect(sink.chunks).toEqual([]);
  });

  it('drops a sink that throws instead of failing the whole broadcast', () => {
    const channel = new SseChannel();
    const dead = new FakeSink();
    const live = new FakeSink();
    dead.throwOnWrite = true;
    channel.add(dead);
    channel.add(live);

    channel.send('tick', { n: 1 });

    expect(live.chunks.length).toBe(1);
    expect(channel.count()).toBe(1);
  });

  it('sends a comment heartbeat that carries no event', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    channel.add(sink);

    channel.ping();

    expect(sink.chunks).toEqual([': ping\n\n']);
  });

  it('ends and forgets every subscriber on closeAll', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    channel.add(sink);

    channel.closeAll();

    expect(sink.ended).toBe(true);
    expect(channel.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/sse-test.ts`
Expected: FAIL — `Cannot find module '../sse'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/sse.ts`:

```ts
export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

// JSON.stringify escapes newlines, so the payload is always a single data line
// and the frame stays parseable by EventSource without any splitting.
export function formatEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseChannel {
  private _sinks: SseSink[] = [];

  add(sink: SseSink): () => void {
    this._sinks.push(sink);
    return () => this._drop(sink);
  }

  count(): number {
    return this._sinks.length;
  }

  send(event: string, data: any): void {
    this._broadcast(formatEvent(event, data));
  }

  // A comment frame. Proxies and some browsers drop an idle event stream, and a
  // heartbeat is cheaper than reconnecting.
  ping(): void {
    this._broadcast(': ping\n\n');
  }

  closeAll(): void {
    const sinks = this._sinks;
    this._sinks = [];
    sinks.forEach(sink => {
      try {
        sink.end();
      } catch (error) {
        // A socket that is already gone is exactly what we wanted.
      }
    });
  }

  private _broadcast(frame: string): void {
    // Iterate a copy: a throwing sink is dropped mid-loop.
    this._sinks.slice().forEach(sink => {
      try {
        sink.write(frame);
      } catch (error) {
        this._drop(sink);
      }
    });
  }

  private _drop(sink: SseSink): void {
    const index = this._sinks.indexOf(sink);
    if (index >= 0) {
      this._sinks.splice(index, 1);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/sse-test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/sse.ts src/modules/serverManager/__tests__/sse-test.ts
git commit -m "$(cat <<'EOF'
feat: add SSE framing and subscriber fan-out

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 4: Activity log and sudo failure mapping

**Files:**
- Create: `src/modules/serverManager/activity.ts`
- Test: `src/modules/serverManager/__tests__/activity-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ActivityEntry { at: number; label: string; command: string; code: number; ms: number; error: string | null }`
  - `class ActivityLog` with `constructor(capacity?: number)`, `onEntry: (e: ActivityEntry) => void`, `push(entry): void`, `entries(): ActivityEntry[]`
  - `sudoHint(stderr: string, user: string, host: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/activity-test.ts`:

```ts
import { ActivityLog, sudoHint, ActivityEntry } from '../activity';

function entry(label: string): ActivityEntry {
  return { at: 1, label, command: 'true', code: 0, ms: 5, error: null };
}

describe('ActivityLog', () => {
  it('keeps entries in insertion order', () => {
    const log = new ActivityLog();
    log.push(entry('one'));
    log.push(entry('two'));
    expect(log.entries().map(e => e.label)).toEqual(['one', 'two']);
  });

  it('drops the oldest entries once capacity is exceeded', () => {
    const log = new ActivityLog(2);
    log.push(entry('one'));
    log.push(entry('two'));
    log.push(entry('three'));
    expect(log.entries().map(e => e.label)).toEqual(['two', 'three']);
  });

  it('notifies a listener for each entry', () => {
    const log = new ActivityLog();
    const seen: string[] = [];
    log.onEntry = e => seen.push(e.label);
    log.push(entry('one'));
    expect(seen).toEqual(['one']);
  });

  it('survives having no listener attached', () => {
    const log = new ActivityLog();
    expect(() => log.push(entry('one'))).not.toThrow();
  });

  it('hands out a copy, so a caller cannot mutate the ring', () => {
    const log = new ActivityLog();
    log.push(entry('one'));
    log.entries().push(entry('injected'));
    expect(log.entries().length).toBe(1);
  });
});

describe('sudoHint', () => {
  it('explains a password prompt', () => {
    const hint = sudoHint('sudo: a password is required', 'deploy', 'web1');
    expect(hint).toContain('deploy');
    expect(hint).toContain('web1');
    expect(hint).toContain('NOPASSWD');
  });

  it('explains a missing tty', () => {
    const hint = sudoHint(
      'sudo: no tty present and no askpass program specified',
      'deploy',
      'web1'
    );
    expect(hint).toContain('NOPASSWD');
  });

  it('explains a user missing from sudoers', () => {
    const hint = sudoHint('deploy is not in the sudoers file.', 'deploy', 'web1');
    expect(hint).toContain('sudoers');
  });

  it('returns null for an unrelated failure, so real errors survive', () => {
    expect(sudoHint('Unit nginx.service not found.', 'deploy', 'web1')).toBeNull();
  });

  it('returns null for empty stderr', () => {
    expect(sudoHint('', 'deploy', 'web1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/activity-test.ts`
Expected: FAIL — `Cannot find module '../activity'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/activity.ts`:

```ts
export interface ActivityEntry {
  at: number;
  label: string;
  command: string;
  code: number;
  ms: number;
  error: string | null;
}

export class ActivityLog {
  onEntry: (entry: ActivityEntry) => void = () => undefined;

  private _entries: ActivityEntry[] = [];
  private _capacity: number;

  constructor(capacity: number = 200) {
    this._capacity = Math.max(1, capacity);
  }

  push(entry: ActivityEntry): void {
    this._entries.push(entry);
    if (this._entries.length > this._capacity) {
      this._entries = this._entries.slice(this._entries.length - this._capacity);
    }
    this.onEntry(entry);
  }

  // A copy: the ring is ours, and a route handler serialising it must not be
  // able to grow it.
  entries(): ActivityEntry[] {
    return this._entries.slice();
  }
}

const SUDO_PATTERNS = [
  /a password is required/i,
  /no tty present and no askpass/i,
  /is not in the sudoers file/i,
];

// An empty panel is the worst possible answer to a sudo failure: it looks like
// the host has no services. Name the host, the user, and the fix instead.
export function sudoHint(stderr: string, user: string, host: string): string | null {
  if (!stderr) {
    return null;
  }
  const matched = SUDO_PATTERNS.some(pattern => pattern.test(stderr));
  if (!matched) {
    return null;
  }
  return (
    `${user}@${host} cannot run this command with sudo without a password. ` +
    `Add a sudoers rule on ${host}, for example: ` +
    `${user} ALL=(ALL) NOPASSWD: /bin/systemctl, /usr/sbin/nginx, /usr/sbin/apache2ctl`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/activity-test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/activity.ts src/modules/serverManager/__tests__/activity-test.ts
git commit -m "$(cat <<'EOF'
feat: add the activity log and sudo failure mapping

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 5: The managed session

The heart of the milestone: one profile, one collector, a subscriber refcount, and a grace period so a browser reload does not tear down the SSH channel.

Everything time- and I/O-shaped is injected, which is why this can be tested synchronously with no sockets and no timers — the same approach `collector-test.ts` already takes.

**Files:**
- Create: `src/modules/serverManager/session.ts`
- Test: `src/modules/serverManager/__tests__/session-test.ts`

**Interfaces:**
- Consumes: `RedactedProfile` (Task 1), `SseChannel` / `SseSink` (Task 3), `ActivityLog` (Task 4), and from the monitor module: `MonitorTransport` (`../monitor/collector`), `HostFacts`, `Snapshot`, `SlowData`, `LoadPoint` (`../monitor/types`).
- Produces:
  - `type SessionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unsupported'`
  - `interface CollectorLike` — the structural subset of `Collector` the session drives
  - `interface SessionDeps { transport; readFacts; makeCollector; schedule; cancel; now }`
  - `interface SessionState { id; profile; status; error; facts; interval; lastSeen }`
  - `class ManagedSession` with `id`, `token`, `profile`, `sse`, `activity`, `state()`, `subscribe(sink)`, `refresh()`, `subscriberCount()`, `isRunning()`, `dispose()`

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/session-test.ts`:

```ts
import { ManagedSession, CollectorLike, SessionDeps } from '../session';
import { RedactedProfile } from '../registry';
import { SseSink } from '../sse';
import { HostFacts, Snapshot, SlowData } from '../../monitor/types';

const PROFILE: RedactedProfile = {
  id: 'abc123',
  name: 'prod',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  protocol: 'sftp',
  remotePath: '/var/www',
  workspace: '/ws',
  hasVpn: false,
  hasDatabase: false,
};

const FACTS: HostFacts = {
  hostname: 'web1',
  prettyName: 'Ubuntu 24.04.4 LTS',
  distroId: 'ubuntu',
  cpuModel: 'Test CPU',
  arch: 'x86_64',
  cores: 2,
  pageSize: 4096,
  serverEpochMs: 1000,
  linux: true,
};

class FakeCollector implements CollectorLike {
  onSnapshot: (s: Snapshot) => void = () => undefined;
  onSlow: (s: SlowData) => void = () => undefined;
  onError: (e: Error) => void = () => undefined;
  onClosed: () => void = () => undefined;

  started = 0;
  stopped = 0;
  slowCalls = 0;

  async start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  async slowNow() {
    this.slowCalls++;
  }
  history() {
    return { points: () => [{ at: 1, cpu: 10, mem: 20, load1: 0.5 }] };
  }
}

class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
  events(): string[] {
    return this.chunks
      .filter(c => c.indexOf('event: ') === 0)
      .map(c => c.slice('event: '.length, c.indexOf('\n')));
  }
  payload(event: string): any {
    const frame = this.chunks.find(c => c.indexOf(`event: ${event}\n`) === 0);
    if (!frame) {
      throw new Error(`no ${event} frame in ${JSON.stringify(this.chunks)}`);
    }
    return JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length));
  }
}

interface Harness {
  session: ManagedSession;
  collector: FakeCollector;
  runTimers(): void;
  pendingTimers(): number;
  factsCalls(): number;
}

function harness(overrides: { facts?: HostFacts; factsError?: Error } = {}): Harness {
  const collector = new FakeCollector();
  let timers: (() => void)[] = [];
  let factsCalls = 0;

  const deps: SessionDeps = {
    transport: { openSampler: async () => ({} as any), exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
    async readFacts() {
      factsCalls++;
      if (overrides.factsError) {
        throw overrides.factsError;
      }
      return overrides.facts || FACTS;
    },
    makeCollector: () => collector,
    schedule(fn: () => void) {
      timers.push(fn);
      return timers.length - 1;
    },
    cancel(handle: any) {
      timers[handle as number] = () => undefined;
    },
    now: () => 1234,
  };

  const session = new ManagedSession(PROFILE, 'tok', deps, { graceMs: 30000, interval: 2000 });
  return {
    session,
    collector,
    runTimers() {
      const due = timers;
      timers = [];
      due.forEach(fn => fn());
    },
    pendingTimers: () => timers.filter(fn => fn.toString().indexOf('undefined') === -1).length,
    factsCalls: () => factsCalls,
  };
}

describe('ManagedSession', () => {
  it('starts idle with no collector running', () => {
    const h = harness();
    expect(h.session.state().status).toBe('idle');
    expect(h.session.isRunning()).toBe(false);
    expect(h.collector.started).toBe(0);
  });

  it('starts the collector when the first subscriber arrives', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    expect(h.collector.started).toBe(1);
    expect(h.session.state().status).toBe('online');
  });

  it('sends the current state to a subscriber immediately', () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);

    expect(sink.events()[0]).toBe('state');
    expect(sink.payload('state').profile.host).toBe('10.0.0.5');
  });

  it('does not start a second collector for a second subscriber', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    expect(h.collector.started).toBe(1);
    expect(h.session.subscriberCount()).toBe(2);
  });

  it('forwards a snapshot to every subscriber with the history attached', async () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    h.collector.onSnapshot({ at: 5 } as any);

    const tick = sink.payload('tick');
    expect(tick.snapshot.at).toBe(5);
    expect(tick.history.length).toBe(1);
  });

  it('replays the last snapshot to a subscriber that joins later', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.collector.onSnapshot({ at: 5 } as any);

    const late = new FakeSink();
    h.session.subscribe(late);

    expect(late.payload('tick').snapshot.at).toBe(5);
  });

  it('does not stop the collector until the grace period elapses', async () => {
    const h = harness();
    const off = h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    off();
    expect(h.collector.stopped).toBe(0);

    h.runTimers();
    expect(h.collector.stopped).toBe(1);
    expect(h.session.isRunning()).toBe(false);
  });

  it('survives a reload inside the grace period without restarting SSH', async () => {
    const h = harness();
    const off = h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    off();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();
    h.runTimers();

    expect(h.collector.stopped).toBe(0);
    expect(h.collector.started).toBe(1);
    expect(h.factsCalls()).toBe(1);
  });

  it('reports a non-Linux host as unsupported and never starts the collector', async () => {
    const h = harness({ facts: { ...FACTS, linux: false } });
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('unsupported');
    expect(h.collector.started).toBe(0);
    expect(sink.payload('state').error).toContain('Linux');
  });

  it('reports a failed connection as offline with the error text', async () => {
    const h = harness({ factsError: new Error('connect ETIMEDOUT') });
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    expect(h.session.state().status).toBe('offline');
    expect(h.session.state().error).toContain('ETIMEDOUT');
    expect(sink.payload('state').status).toBe('offline');
  });

  it('goes offline when the collector reports the channel closed', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    h.collector.onClosed();

    expect(h.session.state().status).toBe('offline');
  });

  it('runs the slow lane on refresh', async () => {
    const h = harness();
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    await h.session.refresh();

    expect(h.collector.slowCalls).toBe(1);
  });

  it('retries the connection on refresh when it is offline', async () => {
    const h = harness({ factsError: new Error('connect ETIMEDOUT') });
    h.session.subscribe(new FakeSink());
    await h.session.whenSettled();

    await h.session.refresh();

    expect(h.factsCalls()).toBe(2);
  });

  it('stops the collector and ends every stream on dispose', async () => {
    const h = harness();
    const sink = new FakeSink();
    h.session.subscribe(sink);
    await h.session.whenSettled();

    h.session.dispose();

    expect(h.collector.stopped).toBe(1);
    expect(sink.ended).toBe(true);
    expect(h.session.subscriberCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/session-test.ts`
Expected: FAIL — `Cannot find module '../session'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/session.ts`:

```ts
import { MonitorTransport } from '../monitor/collector';
import { HostFacts, Snapshot, SlowData, LoadPoint } from '../monitor/types';
import { RedactedProfile } from './registry';
import { SseChannel, SseSink } from './sse';
import { ActivityLog } from './activity';

export type SessionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unsupported';

// The structural subset of Collector the session drives. Declaring it as an
// interface rather than importing the class is what lets the tests run without
// a transport, a socket, or a timer.
export interface CollectorLike {
  onSnapshot: (snapshot: Snapshot) => void;
  onSlow: (slow: SlowData) => void;
  onError: (error: Error) => void;
  onClosed: () => void;
  start(): Promise<void>;
  stop(): void;
  slowNow(): Promise<void>;
  history(): { points(): LoadPoint[] };
}

export interface SessionDeps {
  transport: MonitorTransport;
  readFacts(transport: MonitorTransport): Promise<HostFacts>;
  makeCollector(transport: MonitorTransport, facts: HostFacts): CollectorLike;
  schedule(fn: () => void, ms: number): any;
  cancel(handle: any): void;
  now(): number;
}

export interface SessionOpts {
  graceMs: number;
  interval: number;
}

export interface SessionState {
  id: string;
  profile: RedactedProfile;
  status: SessionStatus;
  error: string | null;
  facts: HostFacts | null;
  interval: number;
  lastSeen: number | null;
}

export class ManagedSession {
  readonly id: string;
  readonly token: string;
  readonly profile: RedactedProfile;
  readonly sse = new SseChannel();
  readonly activity = new ActivityLog();

  private _deps: SessionDeps;
  private _opts: SessionOpts;
  private _collector: CollectorLike | null = null;
  private _facts: HostFacts | null = null;
  private _status: SessionStatus = 'idle';
  private _error: string | null = null;
  private _lastSeen: number | null = null;
  private _lastSnapshot: Snapshot | null = null;
  private _lastSlow: SlowData | null = null;
  private _stopHandle: any = null;
  private _pending: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(profile: RedactedProfile, token: string, deps: SessionDeps, opts: SessionOpts) {
    this.id = profile.id;
    this.token = token;
    this.profile = profile;
    this._deps = deps;
    this._opts = opts;
  }

  state(): SessionState {
    return {
      id: this.id,
      profile: this.profile,
      status: this._status,
      error: this._error,
      facts: this._facts,
      interval: this._opts.interval,
      lastSeen: this._lastSeen,
    };
  }

  subscriberCount(): number {
    return this.sse.count();
  }

  isRunning(): boolean {
    return this._collector !== null;
  }

  // Tests await this to let the start() chain settle. Production code never
  // needs it: everything it produces arrives as an SSE event.
  whenSettled(): Promise<void> {
    return this._pending;
  }

  subscribe(sink: SseSink): () => void {
    const off = this.sse.add(sink);

    // A reload lands here inside the grace period; cancelling the pending stop
    // is what keeps the SSH channel alive across it.
    if (this._stopHandle !== null) {
      this._deps.cancel(this._stopHandle);
      this._stopHandle = null;
    }

    this._sendStateTo(sink);
    if (this._lastSnapshot) {
      this._sendTickTo(sink, this._lastSnapshot);
    }
    if (this._lastSlow) {
      sink.write(`event: slow\ndata: ${JSON.stringify(this._lastSlow)}\n\n`);
    }

    if (!this._collector && this._status !== 'connecting') {
      this._pending = this._start();
    }

    return () => {
      off();
      if (this.sse.count() === 0) {
        this._scheduleStop();
      }
    };
  }

  async refresh(): Promise<void> {
    if (this._collector) {
      await this._collector.slowNow();
      return;
    }
    // Offline or unsupported: a refresh is the user asking us to try again.
    this._pending = this._start();
    await this._pending;
  }

  dispose(): void {
    this._disposed = true;
    if (this._stopHandle !== null) {
      this._deps.cancel(this._stopHandle);
      this._stopHandle = null;
    }
    this._stopCollector();
    this.sse.closeAll();
  }

  private async _start(): Promise<void> {
    this._setStatus('connecting', null);

    let facts: HostFacts;
    try {
      facts = await this._deps.readFacts(this._deps.transport);
    } catch (error) {
      this._setStatus('offline', (error as Error).message);
      return;
    }
    if (this._disposed) {
      return;
    }

    this._facts = facts;
    if (!facts.linux) {
      this._setStatus(
        'unsupported',
        'Manage Server requires a Linux host (it reads /proc on the server).'
      );
      return;
    }

    const collector = this._deps.makeCollector(this._deps.transport, facts);
    collector.onSnapshot = snapshot => {
      this._lastSnapshot = snapshot;
      this._lastSeen = this._deps.now();
      this.sse.send('tick', { snapshot, history: collector.history().points() });
    };
    collector.onSlow = slow => {
      this._lastSlow = slow;
      this.sse.send('slow', slow);
    };
    collector.onError = error => {
      this._setStatus('offline', error.message);
    };
    collector.onClosed = () => {
      this._setStatus('offline', this._error || 'The connection closed.');
    };

    this._collector = collector;
    try {
      await collector.start();
    } catch (error) {
      this._collector = null;
      this._setStatus('offline', (error as Error).message);
      return;
    }
    if (this._disposed) {
      collector.stop();
      this._collector = null;
      return;
    }
    this._setStatus('online', null);
  }

  private _scheduleStop(): void {
    if (this._stopHandle !== null || !this._collector) {
      return;
    }
    this._stopHandle = this._deps.schedule(() => {
      this._stopHandle = null;
      // A subscriber may have arrived between the timer firing and now.
      if (this.sse.count() === 0) {
        this._stopCollector();
      }
    }, this._opts.graceMs);
  }

  private _stopCollector(): void {
    if (!this._collector) {
      return;
    }
    this._collector.stop();
    this._collector = null;
    if (this._status === 'online') {
      this._status = 'idle';
    }
  }

  private _setStatus(status: SessionStatus, error: string | null): void {
    this._status = status;
    this._error = error;
    this.sse.send('state', this.state());
  }

  private _sendStateTo(sink: SseSink): void {
    sink.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
  }

  private _sendTickTo(sink: SseSink, snapshot: Snapshot): void {
    const history = this._collector ? this._collector.history().points() : [];
    sink.write(`event: tick\ndata: ${JSON.stringify({ snapshot, history })}\n\n`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/session-test.ts`
Expected: PASS, 14 tests

If `HostFacts`, `Snapshot`, `SlowData` or `LoadPoint` do not carry the field names the test fixture uses, read `src/modules/monitor/types.ts` and correct the **test fixture** to match the real types. Do not change `types.ts`.

- [ ] **Step 5: Check types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/modules/serverManager/session.ts src/modules/serverManager/__tests__/session-test.ts
git commit -m "$(cat <<'EOF'
feat: add the managed session with a subscriber grace period

A browser reload drops and re-adds its SSE subscriber within milliseconds.
The grace period is what stops that from tearing down and rebuilding the
SSH sampler channel each time.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 6: HTTP server — auth, static serving, traversal defence

**Files:**
- Create: `src/modules/serverManager/httpServer.ts`
- Create: `src/modules/serverManager/bootstrap.ts`
- Test: `src/modules/serverManager/__tests__/httpServer-test.ts`

**Interfaces:**
- Consumes: `Route`, `matchRoute` (Task 2).
- Produces:
  - `interface Ctx { req; res; params: RouteParams; query: any; token: string; json(status, body): void; text(status, body, type?): void }`
  - `type Handler = (ctx: Ctx) => void | Promise<void>`
  - `interface ServerDeps { root: string; routes: Route<Handler>[]; hasToken(token: string): boolean; fallbackHtml(): string }`
  - `tokenFrom(query: any, headers: any): string`
  - `safeJoin(root: string, urlPath: string): string | null`
  - `contentType(file: string): string`
  - `createServer(deps: ServerDeps): http.Server`
  - `listen(server: http.Server): Promise<number>` — always binds `127.0.0.1`, port 0
  - `bootstrapHtml(): string` (from `bootstrap.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/httpServer-test.ts`:

```ts
import * as http from 'http';
import * as path from 'path';
import { tokenFrom, safeJoin, contentType, createServer, listen, Handler } from '../httpServer';
import { Route } from '../router';

describe('tokenFrom', () => {
  it('prefers the query parameter', () => {
    expect(tokenFrom({ t: 'from-query' }, { 'x-sftp-token': 'from-header' })).toBe('from-query');
  });

  it('falls back to the header', () => {
    expect(tokenFrom({}, { 'x-sftp-token': 'from-header' })).toBe('from-header');
  });

  it('is empty when neither is present', () => {
    expect(tokenFrom({}, {})).toBe('');
  });

  it('ignores a repeated query parameter parsed as an array', () => {
    expect(tokenFrom({ t: ['a', 'b'] }, {})).toBe('');
  });
});

describe('safeJoin', () => {
  const ROOT = path.resolve('/tmp/webui-root');

  it('resolves a plain file', () => {
    expect(safeJoin(ROOT, '/index.html')).toBe(path.join(ROOT, 'index.html'));
  });

  it('resolves a nested asset', () => {
    expect(safeJoin(ROOT, '/assets/app.js')).toBe(path.join(ROOT, 'assets', 'app.js'));
  });

  it('refuses a dot-dot escape', () => {
    expect(safeJoin(ROOT, '/../../etc/passwd')).toBeNull();
  });

  it('refuses a percent-encoded dot-dot escape', () => {
    expect(safeJoin(ROOT, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });

  it('refuses a sibling directory that merely shares a prefix', () => {
    expect(safeJoin(ROOT, '/../webui-root-evil/x')).toBeNull();
  });
});

describe('contentType', () => {
  it('maps the types the UI build produces', () => {
    expect(contentType('index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('app.css')).toBe('text/css; charset=utf-8');
    expect(contentType('logo.svg')).toBe('image/svg+xml');
    expect(contentType('font.woff2')).toBe('font/woff2');
  });

  it('falls back to octet-stream for anything unknown', () => {
    expect(contentType('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('createServer', () => {
  let server: http.Server;
  let port: number;

  const routes: Route<Handler>[] = [
    { method: 'GET', path: '/api/ok', handler: ctx => ctx.json(200, { ok: true, token: ctx.token }) },
    { method: 'GET', path: '/api/echo/:name', handler: ctx => ctx.json(200, { name: ctx.params.name }) },
    { method: 'GET', path: '/api/boom', handler: () => { throw new Error('handler exploded'); } },
  ];

  beforeAll(async () => {
    server = createServer({
      root: path.resolve('/tmp/does-not-exist-webui'),
      routes,
      hasToken: token => token === 'good-token',
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
    });
    port = await listen(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function get(pathname: string, headers: any = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      });
      req.on('error', reject);
    });
  }

  it('binds loopback only', () => {
    const address = server.address() as any;
    expect(address.address).toBe('127.0.0.1');
  });

  it('serves an API route with a valid token in the query', async () => {
    const res = await get('/api/ok?t=good-token');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, token: 'good-token' });
  });

  it('serves an API route with a valid token in the header', async () => {
    const res = await get('/api/ok', { 'x-sftp-token': 'good-token' });
    expect(res.status).toBe(200);
  });

  it('rejects an API route with no token', async () => {
    const res = await get('/api/ok');
    expect(res.status).toBe(401);
  });

  it('rejects an API route with a wrong token', async () => {
    const res = await get('/api/ok?t=wrong');
    expect(res.status).toBe(401);
  });

  it('passes route parameters to the handler', async () => {
    const res = await get('/api/echo/nginx?t=good-token');
    expect(JSON.parse(res.body)).toEqual({ name: 'nginx' });
  });

  it('returns 404 for an unknown API route even with a good token', async () => {
    const res = await get('/api/nope?t=good-token');
    expect(res.status).toBe(404);
  });

  it('turns a throwing handler into a 500 rather than killing the process', async () => {
    const res = await get('/api/boom?t=good-token');
    expect(res.status).toBe(500);
    expect(res.body).toContain('handler exploded');
  });

  it('serves the fallback page at the root without a token', async () => {
    // The HTML is not secret; the data behind /api is.
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bootstrap');
  });

  it('serves the fallback page for an unknown non-API path', async () => {
    const res = await get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('bootstrap');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/httpServer-test.ts`
Expected: FAIL — `Cannot find module '../httpServer'`

- [ ] **Step 3: Write the bootstrap page**

Create `src/modules/serverManager/bootstrap.ts`:

```ts
// The page served when no UI build exists in media/webui — which is every run
// until the milestone that adds the React app, and any run where the vite build
// was skipped. It proves the whole pipe end to end: token, session lookup,
// SSE, live snapshots.
//
// There is deliberately no interpolation anywhere in this string. The token
// comes from location.search in the browser, so nothing server-side is ever
// spliced into markup and there is no injection surface at all.
export function bootstrapHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Server Manager</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #0b0b0c; color: #e6e6e6;
         font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin-bottom: 20px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 999px;
            border: 1px solid #333; margin-bottom: 16px; }
  .online { color: #4ade80; border-color: #14532d; }
  .offline, .unsupported { color: #f87171; border-color: #7f1d1d; }
  .connecting, .idle { color: #fbbf24; border-color: #78350f; }
  pre { background: #141416; border: 1px solid #232326; border-radius: 8px;
        padding: 14px; overflow: auto; max-height: 40vh; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: #8a8a8a; margin: 22px 0 8px; }
</style>
</head>
<body>
<h1 id="host">Server Manager</h1>
<div class="sub" id="who">connecting…</div>
<div class="status idle" id="status">idle</div>
<h2>Facts</h2><pre id="facts">–</pre>
<h2>Latest snapshot</h2><pre id="tick">waiting for the first sample…</pre>
<h2>Slow lane</h2><pre id="slow">–</pre>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || sessionStorage.getItem('sftp-token') || '';
  if (params.get('t')) {
    sessionStorage.setItem('sftp-token', token);
    history.replaceState(null, '', location.pathname);
  }

  function show(id, value) {
    document.getElementById(id).textContent =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  function applyState(state) {
    var el = document.getElementById('status');
    el.className = 'status ' + state.status;
    el.textContent = state.error ? state.status + ' — ' + state.error : state.status;
    document.getElementById('host').textContent = state.profile.name;
    document.getElementById('who').textContent =
      state.profile.username + '@' + state.profile.host + ':' + state.profile.port;
    if (state.facts) { show('facts', state.facts); }
  }

  fetch('/api/session', { headers: { 'x-sftp-token': token } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(applyState)
    .catch(function (err) { show('status', 'cannot reach VS Code: ' + err.message); });

  var stream = new EventSource('/api/stream?t=' + encodeURIComponent(token));
  stream.addEventListener('state', function (e) { applyState(JSON.parse(e.data)); });
  stream.addEventListener('tick', function (e) { show('tick', JSON.parse(e.data).snapshot); });
  stream.addEventListener('slow', function (e) { show('slow', JSON.parse(e.data)); });
  stream.onerror = function () {
    var el = document.getElementById('status');
    el.className = 'status offline';
    el.textContent = 'VS Code disconnected';
  };
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Write the server**

Create `src/modules/serverManager/httpServer.ts`:

```ts
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { Route, RouteParams, matchRoute } from './router';

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: RouteParams;
  query: any;
  token: string;
  json(status: number, body: any): void;
  text(status: number, body: string, type?: string): void;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export interface ServerDeps {
  root: string;
  routes: Route<Handler>[];
  hasToken(token: string): boolean;
  fallbackHtml(): string;
}

const TYPES: { [ext: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// A repeated ?t= parses to an array; treating that as "no token" avoids having
// to decide which of two tokens the caller meant.
export function tokenFrom(query: any, headers: any): string {
  const fromQuery = query && query.t;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) {
    return fromQuery;
  }
  const fromHeader = headers && headers['x-sftp-token'];
  return typeof fromHeader === 'string' ? fromHeader : '';
}

// Decode first, then normalise, then prove the result is still under the root.
// Comparing against `root + sep` is what stops /../webui-root-evil from passing
// a naive startsWith check.
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (error) {
    return null;
  }
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  if (target !== base && target.indexOf(base + path.sep) !== 0) {
    return null;
  }
  return target;
}

function isApi(pathname: string): boolean {
  return pathname === '/api' || pathname.indexOf('/api/') === 0;
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';
    const token = tokenFrom(parsed.query, req.headers);

    const ctx: Ctx = {
      req,
      res,
      params: {},
      query: parsed.query,
      token,
      json(status, body) {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(payload);
      },
      text(status, body, type) {
        res.writeHead(status, {
          'content-type': type || 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
      },
    };

    // Only the data is secret. Static assets and the shell page are not, and
    // requiring a token for them would break every <script src> the UI emits.
    if (isApi(pathname)) {
      if (!deps.hasToken(token)) {
        ctx.text(401, 'Unauthorized');
        return;
      }
      const match = matchRoute(deps.routes, req.method || 'GET', pathname);
      if (!match) {
        ctx.text(404, 'Not found');
        return;
      }
      ctx.params = match.params;
      try {
        const result = match.handler(ctx);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(error => fail(ctx, error));
        }
      } catch (error) {
        fail(ctx, error as Error);
      }
      return;
    }

    serveStatic(deps, ctx, pathname);
  });
}

function fail(ctx: Ctx, error: Error): void {
  if (ctx.res.headersSent) {
    ctx.res.end();
    return;
  }
  ctx.text(500, error.message || 'Internal error');
}

function serveStatic(deps: ServerDeps, ctx: Ctx, pathname: string): void {
  const target = safeJoin(deps.root, pathname === '/' ? '/index.html' : pathname);
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    ctx.res.writeHead(200, { 'content-type': contentType(target) });
    fs.createReadStream(target).pipe(ctx.res);
    return;
  }
  // No build on disk, or a client-side route: hand back the shell page.
  ctx.text(200, deps.fallbackHtml(), 'text/html; charset=utf-8');
}

// Always loopback, always an OS-assigned port. There is no host or port
// parameter on purpose: there must be no way to bind this to 0.0.0.0.
export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      resolve(address.port);
    });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/httpServer-test.ts`
Expected: PASS, 20 tests

- [ ] **Step 6: Check types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add src/modules/serverManager/httpServer.ts src/modules/serverManager/bootstrap.ts src/modules/serverManager/__tests__/httpServer-test.ts
git commit -m "$(cat <<'EOF'
feat: add the loopback http server and bootstrap page

Auth guards /api only: the shell page and assets are not secret, and
requiring a token for them would break every asset request the UI build
emits. listen() takes no host or port so there is no way to bind
anything but 127.0.0.1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 7: The milestone-1 API surface

**Files:**
- Create: `src/modules/serverManager/routes.ts`
- Test: `src/modules/serverManager/__tests__/routes-test.ts`

**Interfaces:**
- Consumes: `Handler`, `Ctx` (Task 6), `Route` (Task 2), `ManagedSession` (Task 5).
- Produces:
  - `interface SessionLookup { get(token: string): ManagedSession | undefined }`
  - `interface RouteDeps { sessions: SessionLookup; pingMs: number; schedule(fn, ms): any; cancel(handle): void }`
  - `buildRoutes(deps: RouteDeps): Route<Handler>[]`

Capability flags are returned from `/api/session` so a later UI can grey out tabs that are not built yet. In this milestone every one of them is `false`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/serverManager/__tests__/routes-test.ts`:

```ts
import { buildRoutes } from '../routes';
import { matchRoute } from '../router';
import { Ctx, Handler } from '../httpServer';
import { Route } from '../router';

function fakeSession(overrides: any = {}) {
  const written: string[] = [];
  return {
    written,
    session: {
      id: 'abc',
      token: 'tok',
      state: () => ({
        id: 'abc',
        profile: { id: 'abc', name: 'prod', host: '10.0.0.5', port: 22, username: 'deploy' },
        status: 'online',
        error: null,
        facts: { hostname: 'web1', linux: true },
        interval: 2000,
        lastSeen: 99,
      }),
      activity: { entries: () => [{ at: 1, label: 'restart nginx', command: 'systemctl', code: 0, ms: 12, error: null }] },
      refresh: jest.fn(async () => undefined),
      subscribe: jest.fn(() => () => undefined),
      ...overrides,
    },
  };
}

function fakeCtx(token: string) {
  const res: any = {
    headers: null as any,
    ended: false,
    writeHead(status: number, headers: any) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
    },
    end(body?: string) {
      this.ended = true;
      if (body !== undefined) {
        this.body = body;
      }
    },
    on() {
      return this;
    },
    chunks: [] as string[],
    status: 0,
    body: '',
  };
  const ctx: Ctx = {
    req: { on: () => undefined } as any,
    res,
    params: {},
    query: {},
    token,
    json(status, body) {
      res.status = status;
      res.body = JSON.stringify(body);
    },
    text(status, body) {
      res.status = status;
      res.body = body;
    },
  };
  return { ctx, res };
}

function find(routes: Route<Handler>[], method: string, pathname: string): Handler {
  const match = matchRoute(routes, method, pathname);
  if (!match) {
    throw new Error(`no route for ${method} ${pathname}`);
  }
  return match.handler;
}

describe('buildRoutes', () => {
  let routes: Route<Handler>[];
  let store: Map<string, any>;

  beforeEach(() => {
    store = new Map();
    routes = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 1,
      cancel: () => undefined,
    });
  });

  it('returns the session state and capability flags', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/session')(ctx);

    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.status).toBe('online');
    expect(body.profile.host).toBe('10.0.0.5');
    expect(body.capabilities).toEqual({
      services: false,
      webserver: false,
      logs: false,
      terminal: false,
      database: false,
    });
  });

  it('never exposes the token in the session payload', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/session')(ctx);

    expect(res.body).not.toContain('tok');
  });

  it('answers 404 when the token maps to no session', async () => {
    const { ctx, res } = fakeCtx('stale');

    await find(routes, 'GET', '/api/session')(ctx);

    expect(res.status).toBe(404);
  });

  it('returns the host state', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/host')(ctx);

    expect(JSON.parse(res.body).facts.hostname).toBe('web1');
  });

  it('runs a refresh and reports ok', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'POST', '/api/host/refresh')(ctx);

    expect(session.refresh).toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('reports a refresh failure as a 500 with the message', async () => {
    const { session } = fakeSession({
      refresh: jest.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      }),
    });
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'POST', '/api/host/refresh')(ctx);

    expect(res.status).toBe(500);
    expect(res.body).toContain('ETIMEDOUT');
  });

  it('returns the activity entries', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/activity')(ctx);

    expect(JSON.parse(res.body).entries.length).toBe(1);
  });

  it('opens an event stream with the right headers and subscribes', async () => {
    const { session } = fakeSession();
    store.set('tok', session);
    const { ctx, res } = fakeCtx('tok');

    await find(routes, 'GET', '/api/stream')(ctx);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(session.subscribe).toHaveBeenCalled();
  });

  it('unsubscribes and stops the heartbeat when the client goes away', async () => {
    const unsubscribe = jest.fn();
    const { session } = fakeSession({ subscribe: jest.fn(() => unsubscribe) });
    store.set('tok', session);

    const cancel = jest.fn();
    routes = buildRoutes({
      sessions: { get: token => store.get(token) },
      pingMs: 25000,
      schedule: () => 7,
      cancel,
    });

    let closeHandler = () => undefined;
    const { ctx } = fakeCtx('tok');
    (ctx.req as any).on = (event: string, handler: any) => {
      if (event === 'close') {
        closeHandler = handler;
      }
    };

    await find(routes, 'GET', '/api/stream')(ctx);
    closeHandler();

    expect(unsubscribe).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/routes-test.ts`
Expected: FAIL — `Cannot find module '../routes'`

- [ ] **Step 3: Write the implementation**

Create `src/modules/serverManager/routes.ts`:

```ts
import { Route } from './router';
import { Ctx, Handler } from './httpServer';
import { ManagedSession } from './session';
import { SseSink } from './sse';

export interface SessionLookup {
  get(token: string): ManagedSession | undefined;
}

export interface RouteDeps {
  sessions: SessionLookup;
  pingMs: number;
  schedule(fn: () => void, ms: number): any;
  cancel(handle: any): void;
}

// Everything the later milestones will turn on. The UI reads these to decide
// which tabs are live, so an unfinished tab is greyed out rather than broken.
const CAPABILITIES = {
  services: false,
  webserver: false,
  logs: false,
  terminal: false,
  database: false,
};

function resolve(deps: RouteDeps, ctx: Ctx): ManagedSession | null {
  const session = deps.sessions.get(ctx.token);
  if (!session) {
    // The token authenticated but its session is gone — VS Code reloaded, or
    // the window outlived the workspace. 404 is the honest answer.
    ctx.text(404, 'That session is no longer open in VS Code.');
    return null;
  }
  return session;
}

export function buildRoutes(deps: RouteDeps): Route<Handler>[] {
  return [
    {
      method: 'GET',
      path: '/api/session',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        // state() carries no token, and must not start doing so.
        ctx.json(200, { ...session.state(), capabilities: CAPABILITIES });
      },
    },
    {
      method: 'GET',
      path: '/api/host',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        ctx.json(200, session.state());
      },
    },
    {
      method: 'POST',
      path: '/api/host/refresh',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        try {
          await session.refresh();
          ctx.json(200, { ok: true });
        } catch (error) {
          ctx.text(500, (error as Error).message);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        ctx.json(200, { entries: session.activity.entries() });
      },
    },
    {
      method: 'GET',
      path: '/api/stream',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }

        ctx.res.writeHead(200, {
          'content-type': 'text/event-stream',
          // no-transform matters: a compressing proxy would buffer the stream.
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });

        const sink: SseSink = {
          write: chunk => ctx.res.write(chunk),
          end: () => ctx.res.end(),
        };
        const unsubscribe = session.subscribe(sink);
        const heartbeat = deps.schedule(() => session.sse.ping(), deps.pingMs);

        ctx.req.on('close', () => {
          deps.cancel(heartbeat);
          unsubscribe();
        });
      },
    },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/routes-test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/serverManager/routes.ts src/modules/serverManager/__tests__/routes-test.ts
git commit -m "$(cat <<'EOF'
feat: add the milestone-1 server manager API surface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 8: Wire it up — command, contributions, and delete the webview

The one task that touches VS Code APIs. Everything testable was tested in Tasks 1–7; what is left is glue, plus one pure function (`browserCommand`) that is worth testing because it is three platforms wide.

**Files:**
- Create: `src/modules/serverManager/index.ts`
- Create: `src/commands/commandManageServer.ts`
- Test: `src/modules/serverManager/__tests__/browser-test.ts`
- Modify: `src/constants.ts`, `src/extension.ts:112-117`, `package.json`
- Delete: `src/modules/monitor/html.ts`, `src/modules/monitor/__tests__/html-test.ts`, `src/modules/monitor/index.ts`, `src/commands/commandOpenMonitoring.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `browserCommand(kind, url, platform): { cmd: string; args: string[] } | null`
  - `ensureSession(fileService: any, config: any): Promise<string>` — resolves to the URL to open
  - `openInBrowser(url: string): Promise<void>`
  - `disposeAll(): void`

- [ ] **Step 1: Write the failing test for the browser launcher**

Create `src/modules/serverManager/__tests__/browser-test.ts`:

```ts
import { browserCommand } from '../browser';

const URL = 'http://127.0.0.1:51234/?t=abc';

describe('browserCommand', () => {
  it('returns null for the default browser, so the caller uses openExternal', () => {
    expect(browserCommand('default', URL, 'darwin')).toBeNull();
  });

  it('opens a Chrome tab on macOS', () => {
    expect(browserCommand('chrome', URL, 'darwin')).toEqual({
      cmd: 'open',
      args: ['-a', 'Google Chrome', URL],
    });
  });

  it('opens a Chrome tab on Linux', () => {
    expect(browserCommand('chrome', URL, 'linux')).toEqual({
      cmd: 'google-chrome',
      args: [URL],
    });
  });

  it('opens a Chrome tab on Windows', () => {
    expect(browserCommand('chrome', URL, 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'chrome', URL],
    });
  });

  it('opens a chromeless app window on macOS', () => {
    expect(browserCommand('chrome-app', URL, 'darwin')).toEqual({
      cmd: 'open',
      args: ['-na', 'Google Chrome', '--args', `--app=${URL}`],
    });
  });

  it('opens a chromeless app window on Linux', () => {
    expect(browserCommand('chrome-app', URL, 'linux')).toEqual({
      cmd: 'google-chrome',
      args: [`--app=${URL}`],
    });
  });

  it('opens a chromeless app window on Windows', () => {
    expect(browserCommand('chrome-app', URL, 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'chrome', `--app=${URL}`],
    });
  });

  it('falls back to the default browser on an unknown platform', () => {
    expect(browserCommand('chrome', URL, 'aix' as any)).toBeNull();
  });

  it('falls back to the default browser for an unknown setting value', () => {
    expect(browserCommand('netscape' as any, URL, 'darwin')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/serverManager/__tests__/browser-test.ts`
Expected: FAIL — `Cannot find module '../browser'`

- [ ] **Step 3: Write the browser launcher**

Create `src/modules/serverManager/browser.ts`:

```ts
export type BrowserKind = 'chrome' | 'default' | 'chrome-app';

export interface BrowserLaunch {
  cmd: string;
  args: string[];
}

// Returning null means "no idea, let VS Code's openExternal handle it" — which
// is also the honest answer for an unknown platform or a setting value we do
// not recognise.
export function browserCommand(
  kind: BrowserKind,
  url: string,
  platform: NodeJS.Platform
): BrowserLaunch | null {
  const app = kind === 'chrome-app';
  if (kind !== 'chrome' && !app) {
    return null;
  }

  // The empty string after `start` is the window title. Without it, `start`
  // treats a quoted URL as the title and opens nothing.
  switch (platform) {
    case 'darwin':
      return app
        ? { cmd: 'open', args: ['-na', 'Google Chrome', '--args', `--app=${url}`] }
        : { cmd: 'open', args: ['-a', 'Google Chrome', url] };
    case 'linux':
      return app
        ? { cmd: 'google-chrome', args: [`--app=${url}`] }
        : { cmd: 'google-chrome', args: [url] };
    case 'win32':
      return app
        ? { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', `--app=${url}`] }
        : { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', url] };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/modules/serverManager/__tests__/browser-test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Write the module entry point**

Create `src/modules/serverManager/index.ts`:

```ts
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import logger from '../../logger';
import { Collector } from '../monitor/collector';
import { sshTransport, readFacts } from '../monitor/transport';
import { HostFacts } from '../monitor/types';
import { MonitorTransport } from '../monitor/collector';
import { profileId, redactProfile } from './registry';
import { ManagedSession } from './session';
import { createServer, listen } from './httpServer';
import { bootstrapHtml } from './bootstrap';
import { buildRoutes } from './routes';
import { browserCommand, BrowserKind } from './browser';

const GRACE_MS = 30000;
const PING_MS = 25000;

interface Running {
  server: http.Server;
  port: number;
}

let running: Running | null = null;
const byToken = new Map<string, ManagedSession>();
const byProfile = new Map<string, string>();

function settings() {
  const cfg = vscode.workspace.getConfiguration('sftp.serverManager');
  return {
    browser: cfg.get<BrowserKind>('browser', 'chrome'),
    interval: cfg.get<number>('interval', 2000),
    slowInterval: cfg.get<number>('slowInterval', 15000),
    historyMinutes: cfg.get<number>('historyMinutes', 60),
  };
}

async function ensureServer(): Promise<Running> {
  if (running) {
    return running;
  }
  // media/webui does not exist until the UI milestone; until then every request
  // falls through to the bootstrap page, which is exactly what we want.
  const root = path.join(__dirname, '..', 'media', 'webui');
  const server = createServer({
    root,
    routes: buildRoutes({
      sessions: { get: token => byToken.get(token) },
      pingMs: PING_MS,
      schedule: (fn, ms) => setInterval(fn, ms),
      cancel: handle => clearInterval(handle),
    }),
    hasToken: token => byToken.has(token),
    fallbackHtml: bootstrapHtml,
  });
  const port = await listen(server);
  running = { server, port };
  logger.info(`server manager listening on 127.0.0.1:${port}`, 'serverManager');
  return running;
}

// Resolves to the URL to open. A second invocation on the same profile returns
// the same session and the same token, so it re-focuses rather than
// double-sampling the host.
export async function ensureSession(fileService: any, config: any): Promise<string> {
  const { port } = await ensureServer();
  const id = profileId(fileService.workspace, config);

  const existingToken = byProfile.get(id);
  if (existingToken) {
    return `http://127.0.0.1:${port}/?t=${existingToken}`;
  }

  const cfg = settings();
  const transport = sshTransport(fileService, config);
  const token = crypto.randomBytes(32).toString('hex');
  const session = new ManagedSession(
    redactProfile(fileService.workspace, config),
    token,
    {
      transport,
      readFacts: (t: MonitorTransport) => readFacts(t, config.host),
      makeCollector: (t: MonitorTransport, facts: HostFacts) =>
        new Collector(t, {
          pageSize: facts.pageSize,
          clockTicks: 100,
          interval: cfg.interval,
          slowInterval: cfg.slowInterval,
          historyMinutes: cfg.historyMinutes,
        }),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      now: () => Date.now(),
    },
    { graceMs: GRACE_MS, interval: cfg.interval }
  );

  session.activity.onEntry = entry =>
    logger.info(`${entry.label}: ${entry.command} -> ${entry.code}`, 'serverManager');

  byToken.set(token, session);
  byProfile.set(id, token);
  return `http://127.0.0.1:${port}/?t=${token}`;
}

export async function openInBrowser(target: string): Promise<void> {
  const launch = browserCommand(settings().browser, target, process.platform);
  if (!launch) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  try {
    const child = spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' });
    child.on('error', async error => {
      // Chrome is not installed, or is not where we guessed. Fall back rather
      // than fail the command.
      logger.warn(`chrome launch failed (${error.message}); using the default browser`, 'serverManager');
      await vscode.env.openExternal(vscode.Uri.parse(target));
    });
    child.unref();
  } catch (error) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  }
}

export function disposeAll(): void {
  byToken.forEach(session => session.dispose());
  byToken.clear();
  byProfile.clear();
  if (running) {
    running.server.close();
    running = null;
  }
}
```

- [ ] **Step 6: Write the command**

Create `src/commands/commandManageServer.ts`:

```ts
import * as vscode from 'vscode';
import { COMMAND_MANAGE_SERVER } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { ensureSession, openInBrowser } from '../modules/serverManager';

async function open(fileService: any, config: any): Promise<void> {
  if (config.protocol && config.protocol !== 'sftp') {
    // FTP has no exec channel, so there is nothing to manage.
    vscode.window.showErrorMessage('Manage Server requires an SFTP (SSH) connection.');
    return;
  }
  try {
    const url = await ensureSession(fileService, config);
    await openInBrowser(url);
  } catch (error) {
    vscode.window.showErrorMessage(`Manage Server: ${(error as Error).message}`);
  }
}

export default checkCommand({
  id: COMMAND_MANAGE_SERVER,

  async handleCommand(exploreItem?: ExplorerRoot) {
    if (exploreItem && exploreItem.explorerContext) {
      const { config, fileService } = exploreItem.explorerContext;
      await open(fileService, config);
      return;
    }

    // Invoked from the command palette: pick among the SFTP connections, the
    // same way "Open SSH in Terminal" does.
    const items = getAllFileService().reduce<
      { label: string; description: string; config: any; fileService: any }[]
    >((result, fileService) => {
      const config = fileService.getConfig();
      if (config.protocol === 'sftp') {
        result.push({
          label: config.name || config.remotePath,
          description: config.host,
          config,
          fileService,
        });
      }
      return result;
    }, []);

    if (items.length <= 0) {
      vscode.window.showInformationMessage('SFTP: no SFTP connection to manage.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a connection…',
    });
    if (!picked) {
      return;
    }
    await open(picked.fileService, picked.config);
  },
});
```

- [ ] **Step 7: Update constants and the deactivate hook**

In `src/constants.ts`, replace the `COMMAND_OPEN_MONITORING` line with:

```ts
export const COMMAND_MANAGE_SERVER = 'sftp.manageServer';
```

In `src/extension.ts`, add the import beside the existing `vpnTunnel` import on line 9:

```ts
import * as serverManager from './modules/serverManager';
```

and add one line to `deactivate()` (lines 112-117):

```ts
export function deactivate() {
  fileActivityMonitor.destory();
  getAllFileService().forEach(disposeFileService);
  vpnTunnel.disposeAll();
  dbConnectionManager.disposeAll();
  serverManager.disposeAll();
}
```

- [ ] **Step 8: Delete the webview**

```bash
git rm src/modules/monitor/html.ts \
       src/modules/monitor/__tests__/html-test.ts \
       src/modules/monitor/index.ts \
       src/commands/commandOpenMonitoring.ts
```

- [ ] **Step 9: Update package.json**

Four edits:

1. In `contributes.commands` (around line 165), replace the `sftp.openMonitoring` entry with:

```jsonc
{
  "command": "sftp.manageServer",
  "title": "Manage Server",
  "category": "SFTP"
}
```

2. In `contributes.menus.commandPalette` (around line 547), change `"command": "sftp.openMonitoring"` to `"command": "sftp.manageServer"`, leaving its `when` clause as it is.

3. In `contributes.menus["view/item/context"]` (around line 866), change `"command": "sftp.openMonitoring"` to `"command": "sftp.manageServer"`. **Leave `"group": "navigation@1"` exactly as it is** — that is what keeps the entry directly below *Open SSH in Terminal* (`navigation@0`).

4. In `contributes.configuration.properties`, delete `sftp.monitor.interval`, `sftp.monitor.slowInterval` and `sftp.monitor.historyMinutes` (lines 83-95) and add:

```jsonc
"sftp.serverManager.browser": {
  "type": "string",
  "enum": ["chrome", "default", "chrome-app"],
  "default": "chrome",
  "description": "How Manage Server opens the browser. 'chrome' opens a normal Chrome tab, 'default' uses your default browser, 'chrome-app' opens a standalone Chrome window with no address bar."
},
"sftp.serverManager.interval": {
  "type": "number",
  "default": 2000,
  "description": "Milliseconds between live metric samples."
},
"sftp.serverManager.slowInterval": {
  "type": "number",
  "default": 15000,
  "description": "Milliseconds between slow-lane samples (disks, processes, addresses)."
},
"sftp.serverManager.historyMinutes": {
  "type": "number",
  "default": 60,
  "description": "Minutes of metric history held in memory for the charts. History is not persisted across VS Code restarts."
}
```

- [ ] **Step 10: Verify the whole suite and the build**

Run: `npx jest`
Expected: every suite passes except the known pre-existing `sync --update with time offset` failure. In particular, the 11 surviving `src/modules/monitor/__tests__/*-test.ts` files must pass **without having been edited** — that is the proof the data layer was reused rather than rewritten.

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output. A dangling import of `../modules/monitor` or `COMMAND_OPEN_MONITORING` shows up here.

Run: `npm run compile`
Expected: webpack succeeds.

- [ ] **Step 11: Commit**

```bash
git add src/modules/serverManager/index.ts src/modules/serverManager/browser.ts \
        src/modules/serverManager/__tests__/browser-test.ts \
        src/commands/commandManageServer.ts src/constants.ts src/extension.ts package.json
git commit -m "$(cat <<'EOF'
feat: add the Manage Server command and delete the monitoring webview

The command takes the menu slot Open Monitoring occupied, directly below
Open SSH in Terminal. The monitor data layer is reused unchanged; only
the webview presentation is gone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 9: Manual verification and documentation

**Files:**
- Modify: `README.md:73-110`

- [ ] **Step 1: Verify against a real server**

Launch the extension host (F5 in VS Code, or `npm run dev` and then F5) against a workspace with an SFTP profile pointing at a Linux host, and check each of these:

1. Right-click the connection root in the Remote Explorer. **Manage Server** appears directly below *Open SSH in Terminal*.
2. Click it. Chrome opens on `http://127.0.0.1:<port>/?t=<token>`.
3. The page shows the profile name, `user@host:port`, and a green **online** badge within a few seconds.
4. The **Latest snapshot** block updates roughly every 2 seconds.
5. The **Slow lane** block populates within ~15 seconds.
6. The URL bar shows no `?t=` after load — the page strips it into `sessionStorage`.
7. Reload the page. It reconnects with the stored token, and the SFTP output channel shows **no** new connection being made — the grace period held the SSH channel open.
8. Close the tab, wait 40 seconds, reopen the URL from history. It reconnects and starts a fresh collector.
9. Open `http://127.0.0.1:<port>/api/session` in a private window with no token. It returns **401**.
10. Run **SFTP: Manage Server** from the command palette with no selection. The quick-pick lists SFTP connections only.
11. Run Manage Server twice on the same profile. The second run opens the same URL and does not create a second session — check the output channel for a single "listening" line and no duplicate sampler.
12. Try it against an FTP profile. It refuses with "Manage Server requires an SFTP (SSH) connection."
13. Close VS Code with the tab still open. The page flips to **VS Code disconnected**.

Record anything that fails and fix it before continuing.

- [ ] **Step 2: Replace the README section**

In `README.md`, change the feature-table row on line 73 from `Live monitoring dashboard` to `Manage Server (**Linux servers only**)`, adjust the sentence on line 79 that refers to "the monitoring dashboard", and replace the whole `## Monitoring` section (lines 82-110) with:

```markdown
## Manage Server

Right-click a connection root in the Remote Explorer → **Manage Server** (or run
`SFTP: Manage Server` from the command palette) to manage that server from your browser.

VS Code starts a small HTTP server on `127.0.0.1` — loopback only, never exposed to your
network — and opens Chrome on a token-authenticated page for that one connection. Everything it
shows is collected over the connection's existing SSH channel: no agent is installed on the
server, and no new service runs there.

The page currently shows live host facts and a 2-second metric stream. Services, web server,
logs and terminal management follow in the next releases.

Metric history lives in memory only and is not persisted across VS Code restarts.

Settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `sftp.serverManager.browser` | `chrome` | `chrome`, `default`, or `chrome-app` for a chromeless window |
| `sftp.serverManager.interval` | `2000` | Milliseconds between live samples |
| `sftp.serverManager.slowInterval` | `15000` | Milliseconds between slow-lane samples |
| `sftp.serverManager.historyMinutes` | `60` | Minutes of in-memory history for the charts |

Requires an SFTP (SSH) connection — FTP has no exec channel — and a Linux host, because
collection reads `/proc`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: document Manage Server and drop the Open Monitoring section

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

## Self-Review

**Spec coverage.** Walking the spec section by section:

| Spec section | Covered by |
|---|---|
| Why embedded, no child process | Task 8 — `ensureSession` drives `sshTransport(fileService, config)` |
| No native modules | Global Constraints; no dependency is added |
| Sessions, `profileId`, second invocation | Tasks 1, 5, 8 |
| Grace period on disconnect | Task 5 |
| Idle server shutdown | **Deferred.** `disposeAll()` on `deactivate()` covers the real leak; the 5-minute idle shutdown is cosmetic while there is one server and no dependencies, and it lands with the UI milestone that can actually observe tab closes. Noted here so it is not lost. |
| SSE transport, no Express | Tasks 3, 6, 7 |
| Command and menu wiring, `navigation@1` | Task 8 |
| Browser opening, three modes, fallback | Task 8 |
| Deletions | Task 8 |
| Redaction allowlist | Task 1 |
| Loopback binding | Task 6 — `listen()` takes no host parameter |
| Token auth on `/api/*` | Tasks 6, 7 |
| Activity log, sudo mapping | Task 4 (`sudoHint` has no caller until the Services milestone — built now because it is pure, cheap, and the Services task should not have to invent it under time pressure) |
| Non-Linux host handling | Task 5 — `unsupported` status |
| Settings | Task 8 |
| README | Task 9 |
| Ops layer, UI, terminal, logs, VPN port | Later milestones, explicitly out of scope |

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N". Every code step carries the actual code.

**Type consistency.** `RedactedProfile` (Task 1) is consumed by `ManagedSession` (Task 5) and `redactProfile` (Task 8) with the same field names. `SseSink` (Task 3) is what `ManagedSession.subscribe` (Task 5) and the `/api/stream` handler (Task 7) both pass. `Route<Handler>` (Tasks 2, 6) is what `buildRoutes` (Task 7) returns and `createServer` (Task 6) consumes. `CollectorLike` (Task 5) is satisfied structurally by the real `Collector` — verified against its public methods `start`, `stop`, `slowNow`, `history` and its four `on*` fields.

**One deviation from the spec, deliberate.** The spec's command wiring showed `/#/host/<id>`. This plan uses `?t=<token>` with no host in the path, because the token already identifies the session and a path-based id would let one window request another window's host. `profileId()` is still used, to deduplicate sessions. The spec should be amended to match.
