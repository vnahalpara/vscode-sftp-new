# Live server monitoring dashboard ("Open Monitoring")

## Goal

Add an **Open Monitoring** entry to the Remote Explorer root context menu, directly below
*Open SSH in Terminal*, that opens a live interactive dashboard for that connection in a new
editor tab: CPU, load, memory, network, storage, processes, plus access/error log analysis for
spotting attack traffic.

Everything is collected over the connection's existing SSH channel. No agent is installed on the
server, no new service runs there, and nothing outside `/proc` and standard coreutils is required.

## Decisions

| Question | Decision |
|---|---|
| Metric scope | Full parity with the reference design, including the IP Location card |
| Refresh | 2s fast lane; keeps polling while the tab is hidden; stops only on dispose |
| Interactivity | Sort/filter/pause/inspect **plus** process kill and service start/stop/restart |
| Remote OS | Linux only (`/proc`-based); other platforms get an explicit unsupported message |
| Collection | Hybrid — one persistent streamed sampler for cheap `/proc` reads, one-shot `exec` for slow probes and all actions |
| Charts | Hand-rolled inline SVG + canvas, zero dependencies |
| Log sources | Auto-detected candidates, overridable via `monitor.logs` in `sftp.json` |
| IP geolocation | Live APIs with a three-provider fallback chain, resolved **on demand**, aggressively cached to disk |

## Command wiring

- `COMMAND_OPEN_MONITORING = 'sftp.openMonitoring'` in `src/constants.ts`.
- `src/commands/commandOpenMonitoring.ts` — auto-registered by the `command*.ts` `require.context`
  in `src/initCommands.ts`; no manual registration.
- Handler mirrors `commandOpenSshConnection`: accepts an optional `ExplorerRoot`, reads
  `explorerContext.{config, fileService}`, and falls back to a `showQuickPick` over all SFTP
  services when invoked from the command palette with no node.
- Non-SFTP configs are rejected before any work: FTP has no exec channel, so monitoring is
  impossible. The message names the reason rather than failing silently.
- `package.json`: entry in `contributes.commands` (`title: "Open Monitoring"`, `category: "SFTP"`),
  and in `view/item/context` under `group: "navigation@1"` with
  `when: "view == remoteExplorer && viewItem == root"` so it renders immediately after
  *Open SSH in Terminal* (`navigation@0`).

## Module layout

New `src/modules/monitor/`. The split keeps every correctness-critical computation in a pure
module that jest can exercise without VS Code or a server.

| File | Responsibility | Pure? |
|---|---|---|
| `index.ts` | `openMonitor(fileService, config)`; panel lifecycle, one panel per connection, message routing, disposal | no |
| `collector.ts` | Owns the streamed sampler channel, the slow-lane timer, and previous-sample state; emits `Snapshot` | no |
| `probe.ts` | Builders for every remote shell string (sampler loop, slow batch, session facts, log aggregation, actions) | yes |
| `parse.ts` | Parsers for `/proc/stat`, `meminfo`, `loadavg`, `uptime`, `net/dev`, `diskstats`, `[pid]/stat`, `df -PT`, `ps`, `ip -o -4 addr`, `os-release`, `cpuinfo` | yes |
| `metrics.ts` | Delta math (CPU%, net B/s, disk B/s + IOPS + latency), process matching, history ring buffer | yes |
| `logs.ts` | Cutoff computation, parsing of aggregation output, error-log line parsing and grouping | yes |
| `actions.ts` | Kill and service control with pre-flight verification | mixed |
| `geo.ts` | Provider chain, rate governor, persistent cache, reserved-range short circuit | mixed |
| `html.ts` | Webview markup, CSS, and client script | yes (string) |

`src/core/remote-client/sshClient.ts` gains one method:

```ts
// Run a command and expose its stream, so callers can read output incrementally and
// write to stdin while it runs. `exec` buffers until close and cannot do either.
execStream(cmd: string): Promise<ClientChannel>
```

## Metric collection

### The sampler channel

One `execStream` channel carries a loop **paced from our side over stdin**:

```sh
while read -r -t 300 _; do
  echo "==TICK $(date +%s%3N)"
  echo "--stat";  cat /proc/stat
  echo "--mem";   cat /proc/meminfo
  echo "--load";  cat /proc/loadavg /proc/uptime
  echo "--net";   cat /proc/net/dev
  echo "--disk";  cat /proc/diskstats
  echo "--pids";  head -1 /proc/[0-9]*/stat 2>/dev/null
  echo "==END"
done
```

Pacing from stdin rather than a remote `sleep` gives three properties at once:

1. Changing the interval needs no channel restart — we just change our write cadence.
2. Pause/resume is stopping and resuming writes; no server-side state.
3. The loop terminates on EOF when we close the channel, so a closed panel cannot orphan a shell
   on the server. `-t 300` is the fallback for an unclean disconnect: it self-terminates after five
   minutes of silence.

The reader buffers on `==TICK` / `==END` so a snapshot split across TCP reads is never parsed
half-complete. A block that fails to parse is logged and dropped; one bad tick never kills the feed.

### Probes and cadence

| Lane | Source | Cadence | Feeds |
|---|---|---|---|
| Fast (streamed) | `/proc/stat` | 2s | aggregate and per-core CPU%, user/system/nice/iowait/steal split |
| | `/proc/meminfo` | 2s | memory donut, swap bar |
| | `/proc/loadavg`, `/proc/uptime` | 2s | load chart (1m/5m/15m), uptime |
| | `/proc/net/dev` | 2s | per-interface B/s up and down, totals since boot |
| | `/proc/diskstats` | 2s | read/write B/s, IOPS, latency, totals since boot |
| | `/proc/[pid]/stat` | 2s | instantaneous per-process CPU%, RSS, threads |
| Slow (one-shot `exec`) | `df -PT`, `ps -eo pid,user,args`, `ip -o -4 addr` | 10s | mounts and filesystem types, process user and full args, interface addresses |
| Session facts (one-shot) | `/etc/os-release`, `/proc/cpuinfo`, `uname -m`, `nproc` | on open | OS badge, CPU model, architecture, core count |

Both intervals are settings (`sftp.monitor.interval`, `sftp.monitor.slowInterval`).

### Process CPU: instantaneous, not lifetime average

`ps -eo pcpu` reports CPU averaged over the process's **entire lifetime**. A job that saturated a
core an hour ago and is now idle still ranks at the top, and something spiking right now ranks low.
That makes the table actively misleading for the question it exists to answer.

So process CPU is computed the way `htop` does it: `utime + stime` from `/proc/[pid]/stat`, deltaed
between consecutive ticks and divided by elapsed jiffies × core count. `head -1 /proc/[0-9]*/stat`
collects every process in a single command. The 10s slow lane supplies only the columns that don't
change (user, full argv, thread count), keeping the fast lane cheap.

### Delta rules

`metrics.ts` handles three cases explicitly, because each produces a visibly wrong number otherwise:

- **First tick** — no previous sample, so every rate renders as `—`, never as a spike from zero.
- **Counter regression** — a counter that moved backwards means a reboot, a device reset, or a
  32-bit wrap. That delta is discarded rather than emitted as a negative or enormous rate.
- **Pid reuse** — processes are matched on pid **plus** start time (field 22 of `/proc/[pid]/stat`),
  so a recycled pid can't inherit the previous process's CPU delta. The same identity pair is what
  makes the kill rail below safe.

### History

A rolling ring buffer in `metrics.ts` sized to hold 5 minutes at the current interval (150 samples
at 2s), matching the reference design's load-chart span. It lives extension-side, so history
survives webview disposal when the tab is backgrounded and restored.

## Log analytics

### Discovery

One probe command `test -r` each candidate:

- `/var/log/nginx/{access,error}.log`
- `/var/log/apache2/{access,error}.log`
- `/var/log/httpd/{access_log,error_log}`
- `<remotePath>/var/log/*.log` and `<remotePath>/var/report` (Magento)

Readability is checked, not just existence — on many hosts the SFTP user cannot read
`/var/log/nginx`, and the panel must say "found but not readable by `<user>`" instead of rendering
an empty table that looks like zero traffic.

`monitor.logs` in `sftp.json` adds to or overrides the detected set:

```jsonc
"monitor": {
  "logs": [
    { "label": "shop access", "path": "/var/log/nginx/shop.access.log", "kind": "access" },
    { "label": "shop errors", "path": "/var/log/nginx/shop.error.log",  "kind": "error" }
  ],
  "services": ["nginx", "php8.1-fpm", "mysql", "redis"]
}
```

### Access log: single pass, two rankings

Filtering and aggregation both run on the server; only ranked rows cross the wire. One `awk`:

1. parses the combined-format timestamp `[10/Oct/2000:13:55:36 -0700]`,
2. drops lines older than the cutoff epoch passed in as a variable,
3. accumulates three maps — requests by URL, requests by IP, and distinct URLs per IP,
4. at `END`, selects its own top-N by repeatedly taking the max and deleting it (N ≤ 25, so the
   cost is trivial and no `sort` or temp file is needed),
5. prints at most `2N` tagged lines plus a totals line.

**Portability constraint:** Ubuntu and Debian ship **mawk**, which has no `mktime` or `strftime`.
The timestamp→epoch conversion is therefore arithmetic — a days-from-civil computation plus a month
map, honouring the `±hhmm` offset present in the field — which behaves identically on mawk, gawk,
and busybox awk. No `mktime`, `strftime`, `asort`, or gawk-only extension appears anywhere in the
generated commands.

### Bounded scanning

A whole log is never read. The command stats the file first and reads at most the last 64MB via
`tail -c` (`sftp.monitor.logScanBytes`), under `nice -n 19` and `ionice -c3` when present so
analysis never competes with the site being diagnosed.

When the requested window starts before the oldest scanned line, the panel states it plainly —
"scanned the last 64MB of 3.2GB; results may be partial for 24h" — rather than presenting a
truncated ranking as complete.

### Controls

- Window: `5m`, `15m`, `30m`, `1h`, `2h`, `5h`, `24h`.
- Limit: `5`, `10`, `25` rows.
- Runs on demand and on any control change — never on the 2s tick. Log scanning is far too heavy
  for the fast lane.

### Top-IPs table

Per row: request count, share of window total, distinct URLs hit, that IP's most-hit URL, and the
reveal affordance. Distinct-URL count is the cheapest way to tell a broad crawler from a
credential-stuffer hammering one endpoint.

### Error log

Latest N lines within the window, severity-highlighted, with timestamp parsing for the three shapes
that actually occur in this stack:

- nginx — `2024/01/01 12:00:00 [error] 123#0: ...`
- monolog / Magento — `[2024-01-01T12:00:00.000000+00:00] main.ERROR: ...`
- PHP — `[01-Jan-2024 12:00:00 UTC] PHP Fatal error: ...`

An unrecognised format shows a plain tail with the window selector disabled, rather than filtering
on a guess and silently hiding lines.

**Group similar** toggle: normalises digits, hex ids, and path segments in the message and counts
repeats, so "this fatal fired 4,000 times in 15 minutes" surfaces instead of being buried in a tail.

## IP geolocation

### Provider chain

Tried in order, first success wins: **ipwho.is** (HTTPS, no key) → **ipapi.co** (HTTPS, no key) →
**ip-api.com** (HTTP only on the free tier, and the only one with a batch endpoint — up to 100 IPs
per POST counting as one request). Order is a setting (`sftp.monitor.geoProviders`) so a user can
drop a provider entirely.

**ip-api.com's free tier is HTTP-only and licensed for non-commercial use.** It is therefore last
in the default chain and its plaintext transport is documented in the README; it is kept because
its batch endpoint is what makes "Resolve all" cheap.

All requests are issued from the **extension host** with Node `http`/`https`. The webview never
makes them: its CSP blocks external hosts, and keeping the chain out of page context keeps
provider behaviour testable.

### Rate governor

A token bucket per provider, plus a cooldown that respects ip-api's `X-Rl`/`X-Ttl` headers and any
`429`, so a throttled provider is skipped until its window resets instead of being retried and
burning the rest of the chain on a single lookup. Requests carry a 5s timeout; a timeout counts as
a provider failure and advances the chain.

### Cache

A single JSON store in `context.globalStoragePath`, shared across all connections, panels, and
sessions, fronted by an in-memory `Map` and flushed debounced 2s after a change.

- Entry: `{country, countryCode, city, org, provider, fetchedAt}` — provider and timestamp so a
  wrong-looking answer is traceable.
- TTL 30 days (`sftp.monitor.geoCacheDays`, `0` = never expire). An IP's country effectively never
  changes, so hits stay hits for a long time.
- Bounded to 20k entries with LRU eviction (`lru-cache` is already a dependency), so a long attack
  with a churning IP set cannot grow the file without limit.
- **Reserved ranges** — `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`
  — resolve locally and are never sent to any provider.
- **Negative caching** for 10 minutes, so an IP all three providers failed on doesn't re-burn the
  chain on every click.

### Resolution is on demand

Nothing is resolved automatically. Each IP row has a reveal affordance; "Resolve all" batches the
visible 5/10/25 into one ip-api `/batch` request when that provider is active, or sequential
lookups otherwise. Steady-state watching costs zero requests, and no IP leaves the machine unless
the user asks.

The server's own IP for the IP Location card comes from the interface address already collected by
`ip -o -4 addr` (on a typical VPS the interface address *is* the public IP), with
`curl -s ifconfig.me` as an explicit, user-triggered fallback for NAT'd hosts.

## Control actions

Both actions run through ordinary one-shot `exec` — not the sampler stream — so each has a clean
request/response with an exit code, and each is preceded by a modal confirmation.

### Kill

1. Modal confirm showing pid, user, and full argv.
2. **Re-verify before signalling**: re-read `/proc/<pid>/stat` and compare pid *and* start time
   against what was displayed. If it doesn't match, the process died and the pid may have been
   reused — the action aborts with "that process no longer exists" and never signals.
3. `kill -TERM`, then a status re-check; `kill -KILL` only on a second explicit confirmation.
4. Never automatic, never retried, never batched across multiple pids.

### Service control

- Only names in `monitor.services` from `sftp.json` are offered. There is no free-text service
  field — an allowlist means a typo cannot restart something arbitrary.
- Actions: `start`, `stop`, `restart`, plus a read-only `status`. Uses `systemctl` when present,
  reporting clearly when it is not rather than guessing at an init system.
- `sudo` is used only when `monitor.sudo` is `true` in `sftp.json`, and only as `sudo -n`
  (non-interactive): a host needing a password fails fast with a readable message instead of
  hanging on an invisible prompt.
- Every action — command, exit code, stdout, stderr — is logged to the SFTP output channel, so
  there is always a record of what the dashboard did to a live server.

### Residual risk (accepted)

This turns a monitoring view into a control plane for production hosts. The rails above (modal
confirm, identity re-verification, allowlist, no free text, non-interactive sudo, full audit log)
reduce but do not eliminate the chance of an unintended stop or restart on a live server. This was
an explicit product decision.

## Webview UI

Layout follows the reference design top to bottom:

1. **Header** — hostname, distro badge from `os-release`, uptime, and three ring gauges (CPU, RAM, Disk).
2. **CPU Usage** — aggregate percentage, per-core bar grid, CPU model and architecture, and the
   user/system/nice/iowait/steal breakdown.
3. **CPU Load** — three-series line chart (1m/5m/15m) over the 5-minute history, with hover readout.
4. **Processes** — sortable, filterable table: pid, process, args, threads, user, CPU%, memory.
5. **Memory Usage** — used/cached/free donut with total in the centre, plus the swap bar.
6. **Network Usage** — per interface: address, up/down rates, totals since boot.
7. **Storage** — per mount: usage bar, filesystem type, and read/write speed, latency, IOPS, totals.
8. **IP Location** — server IP with country (city and org when a provider supplies them).
9. **Logs** — source selector, window and limit selectors, then *Top URLs* and *Top IPs* side by
   side for access logs, or the line list with the group-similar toggle for error logs.

Rendering is hand-rolled: inline SVG for gauges, donuts, and bars; a small canvas renderer for the
load chart. No dependencies, no `localResourceRoots`, no webpack asset step. All colour comes from
`var(--vscode-*)` so light and dark themes both work, consistent with `dbDataBrowser`.

The client script does **presentation only** — formatting, sorting, filtering. Every number it
renders was computed in `metrics.ts`, so every number is unit-testable. Sorting and filtering act on
the last snapshot, so they respond instantly instead of waiting for a tick.

### Message protocol

Host → webview: `init` (session facts, detected logs, settings), `tick` (fast snapshot), `slow`
(mounts, process metadata), `logResult`, `logError`, `geo`, `actionResult`, `connection` (up/down),
`state` (paused, interval).

Webview → host: `ready`, `setInterval`, `pause`, `resume`, `refreshLogs`, `revealIp`, `revealIps`,
`kill`, `service`, `copy`.

## Configuration

### `sftp.json` (per connection)

Added to `configScheme` in `src/modules/config.ts` and to `schema/definitions.json` for editor
IntelliSense:

```
monitor: {
  logs: [{ label, path, kind: 'access' | 'error', format? }],
  services: string[],
  sudo: boolean
}
```

### VS Code settings

| Setting | Default | Purpose |
|---|---|---|
| `sftp.monitor.interval` | `2000` | Fast-lane tick, ms |
| `sftp.monitor.slowInterval` | `10000` | Slow-lane tick, ms |
| `sftp.monitor.historyMinutes` | `5` | Chart history span |
| `sftp.monitor.logScanBytes` | `67108864` | Cap on bytes tailed per log analysis |
| `sftp.monitor.geoProviders` | `["ipwho.is","ipapi.co","ip-api.com"]` | Fallback chain and order |
| `sftp.monitor.geoCacheDays` | `30` | Geo cache TTL; `0` = never expire |

## Testing

The pure modules carry the correctness weight and are tested with fixtures captured from a real
Ubuntu host, in `src/modules/monitor/__tests__/`:

- **`parse.ts`** — every parser against real fixture text, including a single-core `/proc/stat`, a
  host with no swap, `df` output with a filesystem name long enough to wrap, and a `[pid]/stat`
  whose `comm` field contains spaces and parentheses (the classic parser bug).
- **`metrics.ts`** — first tick yields no rates; counter regression is discarded; pid reuse does not
  inherit CPU; per-core percentages sum sensibly; ring buffer evicts at capacity.
- **`logs.ts`** — cutoff computation for each window; parsing of aggregation output; all three error
  formats plus an unrecognised one; group-similar normalisation.
- **`probe.ts`** — generated commands contain no gawk-only function, and shell metacharacters in
  paths and service names are quoted via the existing `shellSingle`.
- **awk verification** — a test runs the generated aggregation command against a fixture log using
  the local `awk` (present on macOS and Linux CI), asserting the rankings. This is the only way to
  keep the trickiest generated code honest; the test skips itself if `awk` is unavailable.
- **`geo.ts`** — with an injected HTTP stub: chain advances on `429`, on timeout, and on malformed
  JSON; cache hit issues no request; reserved ranges short-circuit; negative cache suppresses
  retries within the TTL.
- **`actions.ts`** — identity mismatch refuses to signal; non-allowlisted service name is rejected.

Not unit-tested, verified manually against a real server: panel lifecycle, stream framing under
real network conditions, and the visual layout.

## Edge cases

- **FTP connection** — command rejected up front with the reason.
- **Non-Linux server** — detected from `os-release`/`uname`; panel shows "monitoring requires a
  Linux host" instead of empty cards.
- **Container or restricted host** — missing `/proc/diskstats` or unreadable `/proc/[pid]/stat`
  greys out the affected card only; the rest keeps working.
- **Connection drops mid-session** — collector stops, panel shows a disconnected state with a
  Reconnect button wired to the existing `fileService.reconnect()`.
- **Second invocation for the same connection** — reveals the existing panel; never double-samples.
- **VPN-routed connection** — everything rides the existing SSH channel, so the tunnel is used
  automatically; geo API calls go direct from the extension host, not through the tunnel.
- **Very large process count** — the fast lane collects all pids but only the top 200 by CPU are
  sent to the webview.
- **Clock skew between server and workstation** — log cutoffs are computed from the *server's*
  `date +%s`, captured at open, not from local time.

## Non-goals (v1)

- Rotated or gzipped log predecessors.
- macOS or BSD servers.
- Historical metric storage across sessions; history is in-memory and per panel.
- Alerting or thresholds.
- Docker container and per-service resource breakdowns.
- Free-text remote command execution — that is what *Open SSH in Terminal* is for.

## Milestones

1. **Metrics core** — `execStream`, collector, `parse.ts`, `metrics.ts`, command wiring, and a
   dashboard rendering CPU, load, memory, network, storage, processes.
2. **Log analytics** — discovery, access aggregation with the two rankings, error log with window,
   limit, and grouping controls.
3. **Geolocation** — provider chain, governor, cache, reveal and Resolve-all.
4. **Control actions** — kill and service control with all rails, behind the confirmations above.

Each milestone is independently shippable and independently verifiable against a real server.

## Version / packaging

Minor bump to **1.21.0** on completion of milestone 1, with subsequent milestones as `1.21.x`.
README gains a Monitoring section documenting the `monitor` config block, the geo provider chain
and its non-commercial ip-api caveat, and the Linux-only requirement. The platform-support table
gains a Monitoring row.
