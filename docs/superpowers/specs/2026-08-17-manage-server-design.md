# Manage Server — browser-based server manager

## Goal

Replace the **Open Monitoring** webview with **Manage Server**: a right-click entry on a Remote
Explorer connection, directly below *Open SSH in Terminal*, that starts a local HTTP server inside
the extension host and opens a full server-management UI in Chrome.

The UI manages **one server per invocation** — the profile you launched it from. It covers live
metrics, systemd services, nginx/apache virtual hosts, logs, and an interactive terminal, all over
the connection's **existing** SSH channel. No agent is installed on the server.

A second requirement is served in the same work: connections that are IP-restricted go through a
WireGuard SOCKS5 tunnel, and that tunnel must use a **stable port** across restarts.

## Decisions

| Question | Decision |
|---|---|
| Server location | Embedded in the extension host — no child process, no second SSH pool |
| Scope | One host per invocation; the sidebar's SERVERS list shows only that profile |
| Multiple hosts | Each invocation creates its own session and its own browser window |
| Metric history | Live only — the existing in-memory `History` ring; nothing persists across restarts |
| Native modules | None. `better-sqlite3` from the reference app is **not** ported |
| Alerts | Out of scope |
| Database tab | Visible but disabled in this release; wired up in the next |
| Browser | Chrome, as a normal tab, by default |
| Old webview | Deleted |

## Reference implementation

`/opt/homebrew/var/www/Local/Server-manager` — a standalone Node + React app (~1,800 lines of
server, ~2,400 of client). Its `server/ops.js` and `client/` are the basis for this work. Its
`server/ssh.js`, `server/db.js`, `server/hosts.js`, `server/crypto.js`, `server/poller.js` and
`server/collectors.js` are **not** ported: the extension already has better equivalents.

## What is reused

The monitor module's data layer is kept intact and is the reason this is tractable:

| File | Role | Change |
|---|---|---|
| `src/modules/monitor/probe.ts` | Remote sampler script, slow batch, host facts | none |
| `src/modules/monitor/frame.ts` | TICK/END framing, section split | none |
| `src/modules/monitor/parse.ts` | `/proc`, `df`, `ps`, `ip addr` parsers | none |
| `src/modules/monitor/metrics.ts` | Rate/delta math, `History` ring | none |
| `src/modules/monitor/collector.ts` | Fast + slow lane orchestration | none |
| `src/modules/monitor/transport.ts` | SSH transport adapter | none |
| `src/modules/monitor/types.ts` | Snapshot/slow-data types | extended |
| `src/core/remote-client/sshClient.ts` | SSH with VPN, hops, `exec`, `execStream` | add `shell()` |
| `src/core/vpnTunnel.ts` | wireproxy SOCKS5 tunnel, refcounted | fixed port |
| `src/core/sshAccess.ts` | `getSshClient(fileService, config)` | none |
| `src/modules/serviceManager/` | Profile registry across workspace folders | none |

Its 11 remaining test files stay green unchanged.

## What is deleted

- `src/modules/monitor/html.ts` (460 lines of hand-written webview HTML/JS)
- `src/modules/monitor/__tests__/html-test.ts`
- `src/modules/monitor/index.ts` — webview session plumbing, replaced by the server manager session
- `src/commands/commandOpenMonitoring.ts`
- `COMMAND_OPEN_MONITORING` in `src/constants.ts`
- The `sftp.openMonitoring` entries in `package.json` (`contributes.commands` line ~165,
  `commandPalette` line ~547, `view/item/context` line ~866)

No alias is kept. The command is new, the menu slot is the same.

---

## Architecture

### Why embedded

The extension host is a Node process. An `http.Server` started inside it can answer API calls by
driving the **existing** `SSHClient` instances that `getSshClient(fileService, config)` already
returns. That means:

- Zero duplicated SSH code, and no second copy of your credentials on disk or in memory.
- The VPN tunnel is already handled: `SSHClient.connect()` calls `vpnTunnel.acquire()` and routes
  the socket through the SOCKS5 proxy (`sshClient.ts:55`, `_makeVpnSock` at `:348`). The refcount
  already pairs correctly with `end()`.
- No second install step for anyone who installs the VSIX.

Spawning the standalone app as a child process was rejected: it would need its own `node_modules`,
its own ssh2 pool, its own VPN logic and its own copy of `sftp.json` — three sources of truth for
one connection.

### The one hard constraint

**No native modules.** A native addon must match the exact Node ABI VS Code ships, per platform,
and rebuilding it per release is a maintenance cost this project should not take on. This rules out
`better-sqlite3`, and with it the reference app's 14-day metric history.

History is therefore the existing in-memory `History` ring only, sized by
`sftp.serverManager.historyMinutes` (default 60). At the 2 s fast-lane cadence that is 1,800 points
— ample for the charts. Charts start empty when a window opens and fill as it runs.

### Sessions

A **session** is one profile being managed. It is keyed by
`sha1(workspaceFolderPath + name + host + port)` — not the display name, so two workspace folders
with same-named profiles do not collide.

- The HTTP server is a singleton, started lazily on the first Manage Server invocation.
- Each session gets its own random 32-byte token, and **the token is what identifies the session**
  on every request. The opening URL is `http://127.0.0.1:<port>/?t=<token>` — there is no host id
  in the path, so one window can never request another window's host.
- Invoking Manage Server on a second profile creates a **second session** and opens a second Chrome
  window with its own token. The first keeps running. Each window's sidebar shows only its own
  profile, which is exactly the requested behaviour and needs no special-casing.
- Invoking it twice on the *same* profile reuses the existing session and token rather than
  double-sampling the host.
- A session owns one `Collector`. It starts when a browser tab connects to that session's SSE
  stream and stops after a 30 s grace period once the last tab for it disconnects — so a page
  reload does not tear down the SSH channel.
- The server stops when every session has been idle for 5 minutes, and on `deactivate()`.

### Transport

| Channel | Mechanism | Why |
|---|---|---|
| Metric pushes | Server-Sent Events, `GET /api/stream` | One-way, no dependency, reconnects natively |
| Actions | Plain `POST` | Nothing more is needed |
| Terminal, live log follow | WebSocket via `ws` | Bidirectional and byte-oriented |

**Express is not used.** A ~120-line router over `node:http` avoids Express's dynamic `require`s,
which are a known webpack hazard, and avoids the dependency entirely.

**New runtime dependency: `ws` only.** Its optional native deps `bufferutil` and `utf-8-validate`
are added to `webpack.config.js` externals so the production build does not try to bundle them.

---

## Command and menu wiring

`src/constants.ts`:

```ts
export const COMMAND_MANAGE_SERVER = 'sftp.manageServer';
```

`src/commands/commandManageServer.ts` — auto-registered by the `command*.ts` `require.context` in
`src/initCommands.ts`, mirroring `commandOpenMonitoring.ts`'s shape: accepts an optional
`ExplorerRoot`, reads `explorerContext.{config, fileService}`, and falls back to a `showQuickPick`
over all SFTP services when invoked from the palette with no node. Non-SFTP configs are rejected up
front with a message naming the reason — FTP has no exec channel.

```ts
const url = await serverManager.ensureSession(fileService, config);
await serverManager.openInBrowser(url);
```

`package.json` — the new command takes the slot `sftp.openMonitoring` occupies today, so it renders
immediately after *Open SSH in Terminal* (`navigation@0`):

```jsonc
{ "command": "sftp.manageServer", "title": "Manage Server", "category": "SFTP" }
```

```jsonc
{ "command": "sftp.manageServer", "group": "navigation@1",
  "when": "view == remoteExplorer && viewItem == root" }
```

### Opening the browser

`sftp.serverManager.browser`, default `chrome`:

| Value | Behaviour |
|---|---|
| `chrome` *(default)* | Opens a normal Chrome tab — macOS `open -a "Google Chrome" <url>`, Linux `google-chrome <url>`, Windows `start chrome <url>` |
| `default` | `vscode.env.openExternal(Uri.parse(url))` — whatever the OS default browser is |
| `chrome-app` | `open -na "Google Chrome" --args --app=<url>` — a chromeless standalone window |

If the Chrome invocation fails (not installed, different path), fall back to `openExternal` and log
the reason rather than failing the command.

---

## New files

```
src/modules/serverManager/
  index.ts          session lifecycle, ensureSession, openInBrowser, dispose
  httpServer.ts     node:http, router, static serving, token auth, WS upgrade
  routes.ts         the REST surface
  sse.ts            event-stream fan-out per session
  session.ts        one profile: Collector, ssh client, activity log, subscribers
  registry.ts       profile id derivation + redaction for the wire
  activity.ts       in-memory ring of privileged commands, mirrored to the output channel
  ops/
    services.ts     systemctl list/status/start/stop/restart/reload
    webserver.ts    nginx|apache detection, vhost parsing, cert expiry, configtest
    logs.ts         log discovery, tail, live follow
    shell.ts        interactive PTY channel
  __tests__/        fixture-driven parser tests, mirroring the monitor module

webui/              React source (port of the reference client/) — tracked, .vscodeignore'd
media/webui/        vite build output — gitignored, produced by npm run build:webui
```

---

## The UI

A port of the reference `client/`: same dark theme, same card and chart language, same tab bar.

```
Server Manager          │  local-test                    ● Online   [Refresh now]
agentless · over SSH    │  root@127.0.0.1:2222 · Ubuntu 24.04.4 LTS · 6.18.5
                        │
  Dashboard             │  Overview  Services  Web server  Logs  Terminal
  Activity              │  ─────────
  Database    (soon)    │  [ CPU ] [ Memory ] [ Disk ] [ Load ] [ Uptime ]
  Servers & settings    │  … charts, filesystems, top processes …
                        │
  SERVERS               │
  ● local-test          │   ← only the launched profile
```

### Sidebar pages

| Page | Content |
|---|---|
| **Dashboard** | The host card — status, facts, the five headline stats, quick links into each tab |
| **Activity** | Every privileged command run, with exit code and duration; mirrored to the SFTP output channel |
| **Database** | Rendered, visibly disabled, labelled "coming in the next release" |
| **Servers & settings** | This profile's config, **redacted**, plus the server-manager settings |

### Tabs

| Tab | Content |
|---|---|
| **Overview** | Headline stats, CPU (per-core), memory, load average, network throughput, filesystems, top processes, network interfaces |
| **Services** | systemd units with status, filter, and start/stop/restart/reload behind a confirmation |
| **Web server** | nginx and apache cards with version, unit and controls; vhost table with server name, listen, document root, TLS expiry, and a View button that shows the config file |
| **Logs** | Discovered log files and journald units; tail and live follow |
| **Terminal** | xterm.js over the session's existing SSH connection |

### Chart time range

The reference app's `1 hour / 6 hours / 24 hours / 7 days` selector cannot exist without persisted
history. It becomes **`5 min / 15 min / 60 min`**, capped by `historyMinutes`.

### Build

- `npm run build:webui` → `vite build`, `build.outDir: media/webui`, `base: './'` so assets resolve
  under the token-scoped URL.
- `vscode:prepublish` runs `build:webui` before webpack.
- `.vscodeignore` keeps `media/webui/**`, excludes `webui/**`.
- Recharts goes in its own lazy chunk. The reference client is ~250 KB gzipped; acceptable against
  the current 2.7 MB VSIX.

---

## Ops layer

`ops/services.ts`, `ops/webserver.ts`, `ops/logs.ts` and `ops/shell.ts` are near-direct ports of the
reference `server/ops.js` (310 lines), with `exec(host, cmd)` swapped for `ssh.exec(cmd)`.

Two details from the reference implementation that must survive the port, because both were bugs
found and fixed there:

1. **The nginx comment stripper.** Without it, Ubuntu's commented-out default HTTPS block parses as
   a real virtual host.
2. **The brace-matching vhost extractor.** Nested `location` blocks break naive regex extraction.

Also ported: the apache `<VirtualHost>` reader, the `openssl x509 -enddate` certificate check, and
the `df` / `systemctl` output parsers.

Each parser gets fixture-driven tests in `src/modules/serverManager/__tests__/`, matching the
discipline of `parse-cpu-test.ts` and `parse-io-test.ts`. The parsers are where the bugs live; the
transport is not.

### `SSHClient.shell()`

```ts
shell(opts: { cols: number; rows: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    this._client.shell({ term: 'xterm-256color', ...opts },
      (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}
```

This rides the **already-authenticated ssh2 connection**. Unlike *Open SSH in Terminal*, which
spawns a real `ssh` process with the configured `ssh_prefix` (typically `sshpass -p …`), there is no
`sshpass` and no password on a command line.

---

## API surface

All routes are session-scoped; the session id comes from the token-bearing request.

```
GET  /api/session                        token check, profile facts, capabilities
GET  /api/stream                         SSE: snapshots, slow data, activity events
GET  /api/host                           redacted profile + connection state
POST /api/host/refresh                   force a slow-lane sample
GET  /api/services                       systemd units
POST /api/services/:unit/:action         start | stop | restart | reload
GET  /api/webserver                      nginx/apache detection + status
GET  /api/webserver/:kind/vhosts         parsed vhosts + cert expiry
POST /api/webserver/:kind/test           configtest
GET  /api/logs                           discovered files + journald units
GET  /api/file?path=                     read a config file (the View button)
GET  /api/activity                       recent privileged commands
WS   /ws/terminal                        interactive shell
WS   /ws/logs?file=|unit=                live follow
```

---

## Security

`sftp.json` holds plaintext passwords and, in some profiles, a GitLab token. A local HTTP server
that can reach them needs care:

- **Bind `127.0.0.1` only.** Never `0.0.0.0`, not even behind a setting.
- **Per-session random 32-byte token.** Passed once as `?t=` on the opening URL, then held in
  `sessionStorage` and sent on every API call and WebSocket upgrade. Port plus token together
  defeat "any local process can curl your API".
- **Auth applies to `/api/*` and `/ws/*` only.** The shell page and its assets are not secret — the
  data behind them is — and requiring a token for asset requests would break every `<script src>`
  the UI build emits.
- **The API never returns `password`, `ssh_prefix`, `git.password`, or `database[].password`.**
  Redaction happens in `registry.ts` at the boundary, not in the UI.
- **Every privileged action is logged** to the Activity ring and the SFTP output channel.
- **`sudo` failures are mapped, not swallowed.** `sudo: a password is required` becomes a message
  naming the host and user and the sudoers rule needed, rather than an empty panel.
- The token dies with the VS Code session, so a browser tab left open after VS Code exits cannot
  attach to a later one.

---

## VPN fixed port

Today `vpnTunnel.getFreePort()` returns a random free port unless `vpn.socksPort` is set
(`vpnTunnel.ts:68`, `:123`), so the proxy moves on every restart. Three changes:

**1. Deterministic port** derived from the WireGuard config path, so the same file always gets the
same port:

```ts
function derivePort(key: string, range: [number, number]): number {
  const h = crypto.createHash('sha256').update(key).digest();
  return range[0] + (h.readUInt16BE(0) % (range[1] - range[0] + 1));
}
```

An explicit `vpn.socksPort` still wins. If the derived port is occupied by something that is not a
SOCKS5 proxy, fall back to `getFreePort()` rather than failing.

**2. Adopt a live tunnel.** If the derived port is occupied *and* answers a SOCKS5 handshake, reuse
it instead of starting a second wireproxy. This is what makes the port survive an extension reload
with a tunnel already up.

**3. Export `portFor(vpn): number | undefined`,** as a read-only view of tunnel state.
*(Correction, post-implementation: it has no production caller. The terminal's `ProxyCommand` takes
the port from its own `acquire()` return, which is authoritative and cannot be undefined; the server
manager UI and the status-bar item were never built. The export is kept for the lifecycle tests,
which have no other way to observe whether a tunnel is tracked.)*

New settings:

```jsonc
"sftp.vpn.portRange": { "type": "string", "default": "21000-21999" },
"sftp.vpn.keepAlive": { "type": "boolean", "default": true }
```

**The server manager needs no VPN code of its own.** It resolves connections through
`getSshClient()` → `SSHClient.connect()`, which already acquires the tunnel and routes through
SOCKS. The fixed port is for convenience and tunnel reuse, not a prerequisite — which is why it is
scheduled as its own phase and cannot block the UI work.

While in this file: `commandOpenSshConnection.ts` acquires the tunnel and releases on terminal
close, but closing the *window* rather than the terminal never fires `onDidCloseTerminal`.
`disposeAll()` on deactivate covers it; the reason gets a comment.

---

## Settings

```jsonc
"sftp.serverManager.browser":        { "enum": ["chrome", "default", "chrome-app"], "default": "chrome" },
"sftp.serverManager.interval":       { "type": "number", "default": 2000 },
"sftp.serverManager.slowInterval":   { "type": "number", "default": 15000 },
"sftp.serverManager.historyMinutes": { "type": "number", "default": 60 },
"sftp.serverManager.idleTimeout":    { "type": "number", "default": 300000 },
"sftp.vpn.portRange":                { "type": "string", "default": "21000-21999" },
"sftp.vpn.keepAlive":                { "type": "boolean", "default": true }
```

`sftp.monitor.interval`, `sftp.monitor.slowInterval` and `sftp.monitor.historyMinutes`
(`package.json` lines 83–95) are removed; their `sftp.serverManager.*` equivalents above replace
them one-for-one. No migration shim — the feature they configured is being deleted in the same
release.

---

## Error handling

| Failure | Behaviour |
|---|---|
| Non-SFTP profile | Command refuses up front, naming the reason |
| SSH connect fails | Session opens; the UI shows Offline with the error text and a Retry button |
| Connection drops mid-session | `Collector` already restarts cleanly (`bca8f9e`); SSE emits a status event and the UI shows reconnecting |
| Remote is not Linux | `/api/session` reports unsupported; the UI shows a single explanatory panel instead of empty cards |
| `sudo` required | Mapped message naming host, user and the sudoers rule needed |
| nginx and apache both absent | Web server tab renders an empty state, not an error |
| Chrome not installed | Falls back to `openExternal`, logs why |
| Browser tab outlives VS Code | SSE reconnect fails; the UI shows "VS Code disconnected" |
| Port in use | OS assigns the HTTP port, so this cannot happen for the server; only the VPN port is deterministic, and it falls back |

## Testing

- **Parsers** — fixture-driven tests per `ops/*` module, in the style of the monitor module's
  `parse-*-test.ts`. Fixtures include the commented-out nginx HTTPS block and a nested `location`.
- **Router** — table-driven tests over the `node:http` router: token missing, token wrong, unknown
  route, session not found.
- **Redaction** — an explicit test asserting no secret field survives `registry.ts`.
- **Session lifecycle** — collector starts on first subscriber, stops after the grace period, and a
  reload inside the grace period does not restart the SSH channel.
- **VPN port** — `derivePort` is stable for a given key and inside the range; explicit `socksPort`
  wins; occupied-and-not-SOCKS falls back. Extends the existing `test/vpnTunnel.spec.js`.
- The 11 surviving monitor test files must stay green untouched — that is the check that the data
  layer really was reused rather than rewritten.

## Cloudflare cache purge

Gated on the profile carrying BOTH `CLOUDFLARE_ZONE_ID` and
`CLOUDFLARE_API_TOKEN`, the same both-or-neither rule the root lane uses. One
without the other is a half-finished edit, not a configuration.

**The call runs from the extension host, over HTTPS, never over SSH.** This is
the load-bearing decision in this feature. Shelling out to `curl -H
"Authorization: Bearer <token>"` on the managed host would place the API token
in that host's process table, where any other user on the box can read it from
`ps`, and potentially into shell history and audit logs. It would also require
the server to have outbound internet and curl, neither of which is a safe
assumption. Cloudflare is the operator's concern, not the server's, so the
request is made by Node's built-in `https` module inside the extension. No new
runtime dependency.

**The token is never exposed.** It must not appear in `RedactedProfile` (which
is serialized straight to the browser), in any activity-log entry, or in any
error message surfaced to the UI. `ops/exec.ts` already carries a warning about
this exact hazard -- it logs commands verbatim and notes that a future builder
passing a secret must redact before reaching it. The Cloudflare op sidesteps
that by never being a shell command at all, but it still logs to the activity
log and so must log only the zone id (an identifier, not a credential) and the
outcome. Cloudflare's own error responses occasionally echo request context, so
the error path is asserted against token leakage too, not just the success path.

**Zone identity is shown before purging.** `GET /zones/{id}` returns the zone's
name, so the confirmation can say which domain is about to be purged rather than
asking the user to trust an opaque 32-character id.

**Purge everything is the only mode in this phase.** The confirmation states
plainly that it evicts the entire zone cache and that every subsequent request
falls through to the origin until it refills, which on a busy site is a load
spike. Purging by URL is the natural follow-up -- an SFTP extension knows
exactly which files were just uploaded -- and is deliberately deferred rather
than designed in now.

## Phases

Each ships independently.

| # | Phase | Deliverable |
|---|---|---|
| 1 | Server skeleton | `httpServer.ts`, token auth, static serving; `sftp.manageServer` opens Chrome on a placeholder page; old webview and command deleted |
| 2 | Session + stream | `session.ts`, `Collector` per session, SSE, redaction, `/api/session`, `/api/host` |
| 3 | UI shell | React app, sidebar, Dashboard, Overview tab with per-core CPU, disk IOPS/latency and per-process CPU |
| 4 | Services | `ops/services.ts`, Services tab, confirmations, Activity page |
| 5 | Web server | `ops/webserver.ts`, vhost table, cert expiry, configtest, reload |
| 6 | Logs + Terminal | WS channels, `SSHClient.shell()`, xterm tab |
| 7 | VPN fixed port | Deterministic port, tunnel adoption, `portFor()`, settings |
| 8 | Cloudflare purge | `ops/cloudflare.ts`, capability gate, zone lookup, confirmed purge |
| 9 | Polish | README, CHANGELOG, version bump, VSIX build, `.vscodeignore` |

Roughly 7–8 working days. Phases 1–3 alone already surpass the deleted webview.

## Out of scope

- Persisted metric history — deliberately dropped with `better-sqlite3`
- Alerts and webhooks
- Cloudflare purge-by-URL (phase 8 ships purge-everything only)
- Managing more than one host from a single window
- The Database tab's functionality — placeholder only, next release
- Windows or macOS remote hosts; `/proc`-based collection is Linux-only, as today
