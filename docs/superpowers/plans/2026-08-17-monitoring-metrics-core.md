# Monitoring Dashboard — Milestone 1: Metrics Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an **Open Monitoring** command on the Remote Explorer root that opens a live dashboard showing CPU, load, memory, network, storage, and processes for that SSH connection.

**Architecture:** One persistent SSH exec channel streams cheap `/proc` reads on a 2s cadence, paced from our side over stdin; a 10s one-shot `exec` lane supplies slow facts (`df`, `ps`, `ip addr`). All parsing and all delta arithmetic live in pure modules under `src/modules/monitor/`; the webview receives finished numbers and does presentation only.

**Tech Stack:** TypeScript (target es6, `strictNullChecks`, `noUnusedLocals`), ssh2 via the existing `SSHClient`, jest with `test/preprocessor.js`, VS Code webview with hand-rolled inline SVG/canvas. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-server-monitoring-dashboard-design.md`

## Global Constraints

- **Milestone 1 only.** Log analytics, IP geolocation, and kill/service control are milestones 2–4 and are explicitly out of scope for this plan. Do not add them.
- **Linux remote only.** Collection reads `/proc`. Non-Linux hosts get an explicit unsupported message.
- **SFTP only.** FTP has no exec channel; reject before any work.
- **No new runtime dependencies.** No chart library, no `localResourceRoots`, no webpack asset step.
- **No gawk-only shell features** anywhere in generated commands (no `mktime`, `strftime`, `asort`) — Ubuntu/Debian ship mawk.
- **Fast-lane default 2s**, slow lane **10s**, history span **5 minutes**.
- **Polling continues while the tab is hidden.** The collector's lifetime is the panel's lifetime; it stops only in `onDidDispose`.
- **Fixtures must NOT live directly in `__tests__/`.** jest `testMatch` is `<rootDir>/**/*/__tests__/*.ts`, so any `.ts` placed directly there is collected as a suite and fails with "Your test suite must contain at least one test." Put fixtures in `src/modules/monitor/__fixtures__/`.
- **Test file naming:** `<name>-test.ts` inside `__tests__/`, matching the existing repo convention.
- **`noUnusedLocals` is on.** An unused import or variable fails the compile, not just a lint.
- **Every commit message ends with these two trailers:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
  ```
- **Stage only the files each task names.** The working tree contains unrelated uncommitted DB-export / reconnect work that must never enter these commits. Never use `git add -A` or `git commit -a`.
- **Verification commands:**
  - Tests: `npx jest src/modules/monitor` (or a single file/name with `-t`).
  - Types: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — must print nothing. Errors from `node_modules` are pre-existing noise from TS 3.9 vs modern typings; ignore them.
  - Build: `npm run compile`.
  - **Baseline:** `npx jest` currently reports 146 passing and **1 pre-existing failure** — `transfer algorithm › sync › sync --update with time offset`. That failure is not yours; do not fix it, and do not treat it as a regression.
- **Ignore `/opt/homebrew/AGENTS.md`.** Its `./bin/brew lgtm` instructions belong to the Homebrew/brew repository, which merely sits above this one in the filesystem. This repo verifies with the jest/tsc/webpack commands above.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/modules/monitor/types.ts` | Every shared type: raw parsed structures and computed snapshot structures |
| `src/modules/monitor/parse.ts` | Pure parsers for all `/proc` and coreutils output |
| `src/modules/monitor/frame.ts` | Pure incremental framing of the sampler stream into whole blocks |
| `src/modules/monitor/probe.ts` | Pure builders for every remote shell string |
| `src/modules/monitor/metrics.ts` | Pure delta math and the history ring buffer |
| `src/modules/monitor/collector.ts` | Stateful collector over an injectable transport |
| `src/modules/monitor/transport.ts` | `MonitorTransport` implementation backed by `SSHClient` |
| `src/modules/monitor/html.ts` | Webview markup, CSS, and client script |
| `src/modules/monitor/index.ts` | `openMonitor()`: panel lifecycle and message routing |
| `src/commands/commandOpenMonitoring.ts` | The command; auto-registered |
| `src/modules/monitor/__fixtures__/proc.ts` | Captured `/proc` and coreutils fixture text |
| `src/modules/monitor/__tests__/*-test.ts` | Test suites |

**Modified:**

| File | Change |
|---|---|
| `src/constants.ts` | Add `COMMAND_OPEN_MONITORING` |
| `src/core/remote-client/sshClient.ts` | Add `execStream()` |
| `package.json` | Command contribution, menu entry, settings, version bump |
| `README.md` | Monitoring section, platform-support row |

---

### Task 1: Shared types and CPU / memory / load parsers

**Files:**
- Create: `src/modules/monitor/types.ts`
- Create: `src/modules/monitor/parse.ts`
- Create: `src/modules/monitor/__fixtures__/proc.ts`
- Test: `src/modules/monitor/__tests__/parse-cpu-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RawCpu`, `RawCpuLine`, `RawMem`, `RawLoad` types; `parseStat(text): RawCpu`, `parseMeminfo(text): RawMem`, `parseLoadavg(text): RawLoad`, `parseUptime(text): number`.

- [ ] **Step 1: Write the fixtures**

Create `src/modules/monitor/__fixtures__/proc.ts`:

```ts
// Captured from a real Ubuntu 22.04 host. Kept verbatim (including trailing
// spaces and column alignment) so parsers are tested against reality.

export const STAT_8CORE = `cpu  461534 1834 122900 226255632 62901 0 4561 0 0 0
cpu0 57692 229 15362 28281954 7862 0 570 0 0 0
cpu1 57691 229 15362 28281953 7862 0 570 0 0 0
cpu2 57692 229 15363 28281954 7862 0 570 0 0 0
cpu3 57691 229 15362 28281953 7862 0 570 0 0 0
cpu4 57692 229 15363 28281954 7862 0 570 0 0 0
cpu5 57691 229 15362 28281953 7862 0 570 0 0 0
cpu6 57692 229 15362 28281954 7862 0 570 0 0 0
cpu7 57693 231 15364 28281957 7869 0 571 0 0 0
intr 1234567 0 0 0
ctxt 987654321
btime 1700000000
processes 456789
procs_running 2
procs_blocked 0
softirq 55555 0 11111 0 2222 0 0 3333 0 0 4444
`;

// Second sample, ~2s later: cpu0 gained 100 user jiffies and 900 idle jiffies.
export const STAT_8CORE_NEXT = `cpu  461634 1834 122900 226256532 62901 0 4561 0 0 0
cpu0 57792 229 15362 28282854 7862 0 570 0 0 0
cpu1 57691 229 15362 28281953 7862 0 570 0 0 0
cpu2 57692 229 15363 28281954 7862 0 570 0 0 0
cpu3 57691 229 15362 28281953 7862 0 570 0 0 0
cpu4 57692 229 15363 28281954 7862 0 570 0 0 0
cpu5 57691 229 15362 28281953 7862 0 570 0 0 0
cpu6 57692 229 15362 28281954 7862 0 570 0 0 0
cpu7 57693 231 15364 28281957 7869 0 571 0 0 0
intr 1234599 0 0 0
`;

// A single-core host: only "cpu" and "cpu0".
export const STAT_1CORE = `cpu  100 0 50 900 10 0 0 0 0 0
cpu0 100 0 50 900 10 0 0 0 0 0
intr 1 0
`;

// Values chosen to match the reference design: 7.75G total, 52% used,
// 31% cached, 15% free, swap 371M of 1024M.
export const MEMINFO = `MemTotal:        8125000 kB
MemFree:         1237000 kB
MemAvailable:    3600000 kB
Buffers:          120000 kB
Cached:          2400000 kB
SwapCached:        10000 kB
Active:          4000000 kB
Inactive:        2000000 kB
SwapTotal:       1048576 kB
SwapFree:         668576 kB
Shmem:             80000 kB
SReclaimable:     100000 kB
`;

// A host with swap disabled.
export const MEMINFO_NO_SWAP = `MemTotal:        1000000 kB
MemFree:          500000 kB
MemAvailable:     600000 kB
Buffers:               0 kB
Cached:           200000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
Shmem:                 0 kB
SReclaimable:          0 kB
`;

export const LOADAVG = `0.07 0.06 0.01 2/456 123456
`;

export const UPTIME = `1234567.89 9876543.21
`;
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/monitor/__tests__/parse-cpu-test.ts`:

```ts
import { parseStat, parseMeminfo, parseLoadavg, parseUptime } from '../parse';
import { STAT_8CORE, STAT_1CORE, MEMINFO, MEMINFO_NO_SWAP, LOADAVG, UPTIME } from '../__fixtures__/proc';

describe('parseStat', () => {
  it('reads the aggregate line', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.total.user).toBe(461534);
    expect(cpu.total.nice).toBe(1834);
    expect(cpu.total.system).toBe(122900);
    expect(cpu.total.idle).toBe(226255632);
    expect(cpu.total.iowait).toBe(62901);
    expect(cpu.total.steal).toBe(0);
  });

  it('reads every per-core line in order', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.cores.length).toBe(8);
    expect(cpu.cores[0].user).toBe(57692);
    expect(cpu.cores[7].user).toBe(57693);
  });

  it('ignores non-cpu lines', () => {
    const cpu = parseStat(STAT_8CORE);
    expect(cpu.cores.every(c => typeof c.idle === 'number')).toBe(true);
  });

  it('handles a single-core host', () => {
    const cpu = parseStat(STAT_1CORE);
    expect(cpu.cores.length).toBe(1);
    expect(cpu.total.user).toBe(100);
  });

  it('sums busy and total jiffies per line', () => {
    const cpu = parseStat(STAT_1CORE);
    // user+nice+system+idle+iowait+irq+softirq+steal = 100+0+50+900+10 = 1060
    expect(cpu.total.totalJiffies).toBe(1060);
    // busy excludes idle and iowait => 150
    expect(cpu.total.busyJiffies).toBe(150);
  });
});

describe('parseMeminfo', () => {
  it('converts kB fields to bytes', () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.total).toBe(8125000 * 1024);
    expect(m.free).toBe(1237000 * 1024);
    expect(m.available).toBe(3600000 * 1024);
  });

  it('folds buffers and reclaimable slab into the cached bucket, minus shmem', () => {
    const m = parseMeminfo(MEMINFO);
    // 120000 + 2400000 + 100000 - 80000 = 2540000 kB
    expect(m.cached).toBe(2540000 * 1024);
  });

  it('reads swap', () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.swapTotal).toBe(1048576 * 1024);
    expect(m.swapFree).toBe(668576 * 1024);
  });

  it('handles a host with no swap without dividing by zero', () => {
    const m = parseMeminfo(MEMINFO_NO_SWAP);
    expect(m.swapTotal).toBe(0);
    expect(m.swapFree).toBe(0);
  });

  it('treats missing optional fields as zero', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n');
    expect(m.total).toBe(1000 * 1024);
    expect(m.cached).toBe(0);
    expect(m.swapTotal).toBe(0);
  });
});

describe('parseLoadavg', () => {
  it('reads the three averages', () => {
    expect(parseLoadavg(LOADAVG)).toEqual({ one: 0.07, five: 0.06, fifteen: 0.01 });
  });
});

describe('parseUptime', () => {
  it('reads seconds since boot', () => {
    expect(parseUptime(UPTIME)).toBe(1234567.89);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/parse-cpu-test.ts`
Expected: FAIL — `Cannot find module '../parse'`.

- [ ] **Step 4: Write the types**

Create `src/modules/monitor/types.ts`:

```ts
// ---- raw parsed structures (straight off the wire, no arithmetic) ----

export interface RawCpuLine {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
  // Derived once at parse time so delta math never re-sums fields.
  totalJiffies: number;
  busyJiffies: number;
}

export interface RawCpu {
  total: RawCpuLine;
  cores: RawCpuLine[];
}

export interface RawMem {
  total: number;
  free: number;
  available: number;
  // Buffers + Cached + SReclaimable - Shmem, the bucket htop shows as cached.
  cached: number;
  swapTotal: number;
  swapFree: number;
}

export interface RawLoad {
  one: number;
  five: number;
  fifteen: number;
}
```

- [ ] **Step 5: Write the parsers**

Create `src/modules/monitor/parse.ts`:

```ts
import { RawCpu, RawCpuLine, RawMem, RawLoad } from './types';

function num(s: string | undefined): number {
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

function cpuLine(fields: string[]): RawCpuLine {
  // /proc/stat cpu fields, in order: user nice system idle iowait irq softirq
  // steal guest guest_nice. guest/guest_nice are already counted inside
  // user/nice, so they are deliberately excluded from the totals.
  const line: RawCpuLine = {
    user: num(fields[0]),
    nice: num(fields[1]),
    system: num(fields[2]),
    idle: num(fields[3]),
    iowait: num(fields[4]),
    irq: num(fields[5]),
    softirq: num(fields[6]),
    steal: num(fields[7]),
    totalJiffies: 0,
    busyJiffies: 0,
  };
  line.totalJiffies =
    line.user + line.nice + line.system + line.idle + line.iowait + line.irq + line.softirq + line.steal;
  line.busyJiffies = line.totalJiffies - line.idle - line.iowait;
  return line;
}

export function parseStat(text: string): RawCpu {
  const empty = cpuLine([]);
  const result: RawCpu = { total: empty, cores: [] };
  text.split('\n').forEach(raw => {
    if (raw.substr(0, 3) !== 'cpu') {
      return;
    }
    const parts = raw.trim().split(/\s+/);
    const label = parts[0];
    const fields = parts.slice(1);
    if (label === 'cpu') {
      result.total = cpuLine(fields);
    } else {
      // cpu0, cpu1, ... arrive in order; index by the label's number so a gap
      // (offlined core) can't shift later cores into the wrong slot.
      const idx = num(label.substr(3));
      result.cores[idx] = cpuLine(fields);
    }
  });
  // Drop holes left by offlined cores so consumers can rely on a dense array.
  result.cores = result.cores.filter(Boolean);
  return result;
}

export function parseMeminfo(text: string): RawMem {
  const kb: { [key: string]: number } = {};
  text.split('\n').forEach(line => {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) {
      kb[m[1]] = num(m[2]);
    }
  });
  const k = (key: string) => (kb[key] || 0) * 1024;
  return {
    total: k('MemTotal'),
    free: k('MemFree'),
    available: k('MemAvailable'),
    cached: k('Buffers') + k('Cached') + k('SReclaimable') - k('Shmem'),
    swapTotal: k('SwapTotal'),
    swapFree: k('SwapFree'),
  };
}

export function parseLoadavg(text: string): RawLoad {
  const parts = text.trim().split(/\s+/);
  return { one: num(parts[0]), five: num(parts[1]), fifteen: num(parts[2]) };
}

export function parseUptime(text: string): number {
  return num(text.trim().split(/\s+/)[0]);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/parse-cpu-test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 7: Verify types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/modules/monitor/types.ts src/modules/monitor/parse.ts \
        src/modules/monitor/__fixtures__/proc.ts \
        src/modules/monitor/__tests__/parse-cpu-test.ts
git commit -m "feat: add /proc cpu, memory and load parsers for monitoring"
```

---

### Task 2: Network, disk and process parsers

**Files:**
- Modify: `src/modules/monitor/types.ts`
- Modify: `src/modules/monitor/parse.ts`
- Modify: `src/modules/monitor/__fixtures__/proc.ts`
- Test: `src/modules/monitor/__tests__/parse-io-test.ts`

**Interfaces:**
- Consumes: `num` helper and existing parsers from Task 1.
- Produces: `RawNetIf`, `RawDisk`, `RawProc` types; `parseNetDev(text): RawNetIf[]`, `parseDiskstats(text): RawDisk[]`, `parsePidStats(text): RawProc[]`.

- [ ] **Step 1: Add fixtures**

Append to `src/modules/monitor/__fixtures__/proc.ts`:

```ts
// Note line 3: a large byte counter runs right up against the colon with no
// space, which is why the parser must split on the first colon rather than
// on whitespace.
export const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    1234    0    0    0     0          0         0  1234567    1234    0    0    0     0       0          0
  eth0: 4500000000 3210000    0    0    0     0          0         0 1845000000 2100000    0    0    0     0       0          0
 ens5:9999999999 1111    0    0    0     0          0         0 8888888888    2222    0    0    0     0       0          0
`;

// Same interfaces 2s later: eth0 received 2000 bytes and sent 1696 bytes.
export const NET_DEV_NEXT = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    1234    0    0    0     0          0         0  1234567    1234    0    0    0     0       0          0
  eth0: 4500002000 3210020    0    0    0     0          0         0 1845001696 2100010    0    0    0     0       0          0
 ens5:9999999999 1111    0    0    0     0          0         0 8888888888    2222    0    0    0     0       0          0
`;

// major minor name reads merged sectors_read ms_read writes merged
// sectors_written ms_write in_flight io_ms weighted_ms ...
export const DISKSTATS = ` 252       0 vda 500000 1000 20000000 400000 800000 2000 120000000 900000 0 300000 1300000
 252       1 vda1 499000 900 19900000 399000 799000 1900 119000000 899000 0 299000 1290000
   7       0 loop0 10 0 80 5 0 0 0 0 0 5 5
`;

// 2s later on vda1: 100 more reads covering 1600 sectors in 20ms,
// 50 more writes covering 800 sectors in 10ms.
export const DISKSTATS_NEXT = ` 252       0 vda 500100 1000 20001600 400020 800050 2000 120000800 900010 0 300030 1300030
 252       1 vda1 499100 900 19901600 399020 799050 1900 119000800 899010 0 299030 1290030
   7       0 loop0 10 0 80 5 0 0 0 0 0 5 5
`;

// Output shape of `head -1 /proc/[0-9]*/stat`. The third entry's comm field
// contains both spaces and parentheses — the classic /proc/pid/stat parser bug.
export const PID_STATS = `==> /proc/1/stat <==
1 (systemd) S 0 1 1 0 -1 4194560 20000 100000 50 100 300 900 200 400 20 0 1 0 5 170000000 3200 18446744073709551615 1 1 0 0 0 0 0 671173123 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/831/stat <==
831 (mariadbd) S 1 831 831 0 -1 4194304 900000 0 0 0 45000 12000 0 0 20 0 9 0 900 3400000000 25100 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/209906/stat <==
209906 (meili (search) x) S 1 209906 209906 0 -1 4194304 5000 0 0 0 600 300 0 0 20 0 23 0 12000 700000000 12288 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0
`;

// 2s later: pid 1 unchanged; mariadbd burned 100 utime + 20 stime jiffies;
// pid 209906 was replaced by a different process reusing the same pid
// (note the different starttime field: 999999 instead of 12000).
export const PID_STATS_NEXT = `==> /proc/1/stat <==
1 (systemd) S 0 1 1 0 -1 4194560 20000 100000 50 100 300 900 200 400 20 0 1 0 5 170000000 3200 18446744073709551615 1 1 0 0 0 0 0 671173123 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/831/stat <==
831 (mariadbd) S 1 831 831 0 -1 4194304 900000 0 0 0 45100 12020 0 0 20 0 9 0 900 3400000000 25100 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/209906/stat <==
209906 (impostor) S 1 209906 209906 0 -1 4194304 5000 0 0 0 5000 5000 0 0 20 0 4 0 999999 700000000 4096 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0
`;
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/monitor/__tests__/parse-io-test.ts`:

```ts
import { parseNetDev, parseDiskstats, parsePidStats } from '../parse';
import { NET_DEV, DISKSTATS, PID_STATS } from '../__fixtures__/proc';

describe('parseNetDev', () => {
  it('parses every interface', () => {
    const ifs = parseNetDev(NET_DEV);
    expect(ifs.map(i => i.name)).toEqual(['lo', 'eth0', 'ens5']);
  });

  it('reads rx and tx byte counters', () => {
    const eth = parseNetDev(NET_DEV).filter(i => i.name === 'eth0')[0];
    expect(eth.rxBytes).toBe(4500000000);
    expect(eth.txBytes).toBe(1845000000);
  });

  it('handles a counter butted against the colon with no space', () => {
    const ens = parseNetDev(NET_DEV).filter(i => i.name === 'ens5')[0];
    expect(ens.rxBytes).toBe(9999999999);
    expect(ens.txBytes).toBe(8888888888);
  });

  it('ignores the two header lines', () => {
    expect(parseNetDev(NET_DEV).length).toBe(3);
  });
});

describe('parseDiskstats', () => {
  it('parses devices and partitions', () => {
    expect(parseDiskstats(DISKSTATS).map(d => d.name)).toEqual(['vda', 'vda1', 'loop0']);
  });

  it('converts sectors to bytes at 512 bytes per sector', () => {
    const vda1 = parseDiskstats(DISKSTATS).filter(d => d.name === 'vda1')[0];
    expect(vda1.readBytes).toBe(19900000 * 512);
    expect(vda1.writeBytes).toBe(119000000 * 512);
  });

  it('reads io counts and service times', () => {
    const vda1 = parseDiskstats(DISKSTATS).filter(d => d.name === 'vda1')[0];
    expect(vda1.reads).toBe(499000);
    expect(vda1.writes).toBe(799000);
    expect(vda1.readMs).toBe(399000);
    expect(vda1.writeMs).toBe(899000);
  });

  it('ignores short or malformed lines', () => {
    expect(parseDiskstats('252 0 vda 1 2\n\n').length).toBe(0);
  });
});

describe('parsePidStats', () => {
  it('parses one entry per process', () => {
    expect(parsePidStats(PID_STATS).map(p => p.pid)).toEqual([1, 831, 209906]);
  });

  it('reads comm, cpu jiffies, threads, starttime and rss pages', () => {
    const maria = parsePidStats(PID_STATS).filter(p => p.pid === 831)[0];
    expect(maria.comm).toBe('mariadbd');
    expect(maria.utime).toBe(45000);
    expect(maria.stime).toBe(12000);
    expect(maria.threads).toBe(9);
    expect(maria.startTime).toBe(900);
    expect(maria.rssPages).toBe(25100);
  });

  it('handles a comm containing spaces and parentheses', () => {
    const weird = parsePidStats(PID_STATS).filter(p => p.pid === 209906)[0];
    expect(weird.comm).toBe('meili (search) x');
    expect(weird.utime).toBe(600);
    expect(weird.stime).toBe(300);
    expect(weird.threads).toBe(23);
    expect(weird.startTime).toBe(12000);
  });

  it('skips entries whose stat line is truncated', () => {
    const text = '==> /proc/5/stat <==\n5 (short) S 0 1\n';
    expect(parsePidStats(text)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/parse-io-test.ts`
Expected: FAIL — `parseNetDev is not a function`.

- [ ] **Step 4: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
export interface RawNetIf {
  name: string;
  rxBytes: number;
  txBytes: number;
}

export interface RawDisk {
  name: string;
  reads: number;
  writes: number;
  readBytes: number;
  writeBytes: number;
  readMs: number;
  writeMs: number;
}

export interface RawProc {
  pid: number;
  comm: string;
  utime: number;
  stime: number;
  threads: number;
  // Field 22: jiffies after boot at which the process started. Together with
  // pid it forms a stable identity across ticks, which is what makes pid reuse
  // detectable.
  startTime: number;
  rssPages: number;
}
```

- [ ] **Step 5: Add the parsers**

Append to `src/modules/monitor/parse.ts`:

```ts
export function parseNetDev(text: string): RawNetIf[] {
  const out: RawNetIf[] = [];
  text.split('\n').forEach(line => {
    const colon = line.indexOf(':');
    if (colon === -1) {
      return;
    }
    const name = line.slice(0, colon).trim();
    // The header rows also contain a colon ("Inter-|", " face |"); a real
    // interface name has no space or pipe in it.
    if (!name || /[\s|]/.test(name)) {
      return;
    }
    const f = line.slice(colon + 1).trim().split(/\s+/);
    if (f.length < 9) {
      return;
    }
    out.push({ name, rxBytes: num(f[0]), txBytes: num(f[8]) });
  });
  return out;
}

export function parseDiskstats(text: string): RawDisk[] {
  const out: RawDisk[] = [];
  text.split('\n').forEach(line => {
    const f = line.trim().split(/\s+/);
    // major minor name + at least the 11 legacy stat fields.
    if (f.length < 14) {
      return;
    }
    out.push({
      name: f[2],
      reads: num(f[3]),
      readBytes: num(f[5]) * 512,
      readMs: num(f[6]),
      writes: num(f[7]),
      writeBytes: num(f[9]) * 512,
      writeMs: num(f[10]),
    });
  });
  return out;
}

export function parsePidStats(text: string): RawProc[] {
  const out: RawProc[] = [];
  text.split('\n').forEach(line => {
    const open = line.indexOf('(');
    // comm can itself contain '(' and ')', so the closing paren is the LAST one.
    const close = line.lastIndexOf(')');
    if (open === -1 || close === -1 || close < open) {
      return;
    }
    const pid = num(line.slice(0, open).trim());
    if (!pid) {
      return;
    }
    const comm = line.slice(open + 1, close);
    // Fields after comm are 3..52; index 0 here is field 3 (state).
    const rest = line.slice(close + 2).trim().split(/\s+/);
    if (rest.length < 22) {
      return;
    }
    out.push({
      pid,
      comm,
      utime: num(rest[11]),
      stime: num(rest[12]),
      threads: num(rest[17]),
      startTime: num(rest[19]),
      rssPages: num(rest[21]),
    });
  });
  return out;
}
```

Add `RawNetIf, RawDisk, RawProc` to the existing `./types` import at the top of `parse.ts`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/parse-io-test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Verify types and full suite**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — no output.
Run: `npx jest src/modules/monitor` — all monitor suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/monitor/types.ts src/modules/monitor/parse.ts \
        src/modules/monitor/__fixtures__/proc.ts \
        src/modules/monitor/__tests__/parse-io-test.ts
git commit -m "feat: add /proc net, disk and process parsers for monitoring"
```

---

### Task 3: Slow-lane and session-fact parsers

**Files:**
- Modify: `src/modules/monitor/types.ts`, `src/modules/monitor/parse.ts`, `src/modules/monitor/__fixtures__/proc.ts`
- Test: `src/modules/monitor/__tests__/parse-facts-test.ts`

**Interfaces:**
- Produces: `RawMount`, `RawPsRow`, `RawAddr`, `HostFacts` types; `parseDf(text): RawMount[]`, `parsePs(text): RawPsRow[]`, `parseAddr(text): RawAddr[]`, `parseOsRelease(text): {prettyName, id}`, `parseCpuModel(text): string`.

- [ ] **Step 1: Add fixtures**

Append to `src/modules/monitor/__fixtures__/proc.ts`:

```ts
// `df -PT -B1`. -P forces one line per filesystem; -B1 reports bytes.
// The final mount point deliberately contains a space.
export const DF = `Filesystem     Type     1B-blocks        Used   Available Capacity Mounted on
/dev/vda1      ext4   111669149696 25554579456 80530636800      25% /
tmpfs          tmpfs    4160000000           0  4160000000       0% /dev/shm
/dev/vdb1      xfs    536870912000 10737418240 526133493760       2% /mnt/my data
overlay        overlay 111669149696 25554579456 80530636800      25% /var/lib/docker/overlay2/abc/merged
`;

// `ps -eo pid=,user=,nlwp=,args=` — no header, args last since it contains spaces.
export const PS = `    1 root         1 /sbin/init
  831 mysql        9 /usr/sbin/mariadbd
209906 meilise+    23 /usr/local/bin/meilisearch --http-addr 127.0.0.1:7700
`;

export const IP_ADDR = `1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: eth0    inet 66.154.126.186/24 brd 66.154.126.255 scope global eth0\\       valid_lft forever preferred_lft forever
`;

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 22.04.5 LTS (Jammy Jellyfish)"
NAME="Ubuntu"
VERSION_ID="22.04"
ID=ubuntu
ID_LIKE=debian
`;

export const CPUINFO = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz
cpu MHz\t\t: 2599.998
processor\t: 1
model name\t: Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz
`;

// An ARM host, where /proc/cpuinfo has no "model name" field at all.
export const CPUINFO_ARM = `processor\t: 0
BogoMIPS\t: 50.00
Features\t: fp asimd evtstrm
CPU implementer\t: 0x41
`;
```

- [ ] **Step 2: Write the failing test**

Create `src/modules/monitor/__tests__/parse-facts-test.ts`:

```ts
import { parseDf, parsePs, parseAddr, parseOsRelease, parseCpuModel } from '../parse';
import { DF, PS, IP_ADDR, OS_RELEASE, CPUINFO, CPUINFO_ARM } from '../__fixtures__/proc';

describe('parseDf', () => {
  it('drops pseudo filesystems', () => {
    expect(parseDf(DF).map(m => m.mount)).toEqual(['/', '/mnt/my data']);
  });

  it('reads device, type and byte totals', () => {
    const root = parseDf(DF)[0];
    expect(root.device).toBe('/dev/vda1');
    expect(root.fstype).toBe('ext4');
    expect(root.totalBytes).toBe(111669149696);
    expect(root.usedBytes).toBe(25554579456);
  });

  it('keeps mount points containing spaces intact', () => {
    expect(parseDf(DF)[1].mount).toBe('/mnt/my data');
  });

  it('maps a device path to its diskstats name', () => {
    expect(parseDf(DF)[0].deviceName).toBe('vda1');
  });

  it('ignores the header row', () => {
    expect(parseDf(DF).length).toBe(2);
  });
});

describe('parsePs', () => {
  it('reads pid, user, threads and full args', () => {
    const rows = parsePs(PS);
    expect(rows.length).toBe(3);
    expect(rows[2].pid).toBe(209906);
    expect(rows[2].user).toBe('meilise+');
    expect(rows[2].threads).toBe(23);
    expect(rows[2].args).toBe('/usr/local/bin/meilisearch --http-addr 127.0.0.1:7700');
  });

  it('ignores blank lines', () => {
    expect(parsePs('\n\n').length).toBe(0);
  });
});

describe('parseAddr', () => {
  it('maps interface names to addresses', () => {
    expect(parseAddr(IP_ADDR)).toEqual([
      { name: 'lo', address: '127.0.0.1/8' },
      { name: 'eth0', address: '66.154.126.186/24' },
    ]);
  });
});

describe('parseOsRelease', () => {
  it('reads the pretty name unquoted', () => {
    expect(parseOsRelease(OS_RELEASE).prettyName).toBe('Ubuntu 22.04.5 LTS (Jammy Jellyfish)');
  });

  it('reads the distro id', () => {
    expect(parseOsRelease(OS_RELEASE).id).toBe('ubuntu');
  });

  it('falls back to empty strings when the file is missing', () => {
    expect(parseOsRelease('')).toEqual({ prettyName: '', id: '' });
  });
});

describe('parseCpuModel', () => {
  it('reads the first model name', () => {
    expect(parseCpuModel(CPUINFO)).toBe('Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz');
  });

  it('returns an empty string when there is no model name field', () => {
    expect(parseCpuModel(CPUINFO_ARM)).toBe('');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/parse-facts-test.ts`
Expected: FAIL — `parseDf is not a function`.

- [ ] **Step 4: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
export interface RawMount {
  device: string;
  // Basename of `device`, which is how /proc/diskstats names it (vda1, nvme0n1p2).
  deviceName: string;
  fstype: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface RawPsRow {
  pid: number;
  user: string;
  threads: number;
  args: string;
}

export interface RawAddr {
  name: string;
  address: string;
}

export interface HostFacts {
  hostname: string;
  prettyName: string;
  distroId: string;
  cpuModel: string;
  arch: string;
  cores: number;
  pageSize: number;
  // The server's own clock at open, so log windows and uptime never depend on
  // the workstation's clock being correct.
  serverEpochMs: number;
  linux: boolean;
}
```

- [ ] **Step 5: Add the parsers**

Append to `src/modules/monitor/parse.ts`:

```ts
// Filesystems that are memory, image or container overlays rather than storage
// the operator can run out of.
const PSEUDO_FS = [
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'overlay',
  'proc',
  'sysfs',
  'ramfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'autofs',
  'efivarfs',
  'fuse.snapfuse',
];

export function parseDf(text: string): RawMount[] {
  const out: RawMount[] = [];
  text.split('\n').forEach((line, i) => {
    if (i === 0 || !line.trim()) {
      return;
    }
    // Six fixed columns, then the mount point — which may contain spaces, so it
    // is everything remaining rather than field seven.
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) {
      return;
    }
    const fstype = m[2];
    if (PSEUDO_FS.indexOf(fstype) !== -1) {
      return;
    }
    const device = m[1];
    out.push({
      device,
      deviceName: device.slice(device.lastIndexOf('/') + 1),
      fstype,
      totalBytes: num(m[3]),
      usedBytes: num(m[4]),
      mount: m[7].trim(),
    });
  });
  return out;
}

export function parsePs(text: string): RawPsRow[] {
  const out: RawPsRow[] = [];
  text.split('\n').forEach(line => {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      return;
    }
    out.push({ pid: num(m[1]), user: m[2], threads: num(m[3]), args: m[4] });
  });
  return out;
}

export function parseAddr(text: string): RawAddr[] {
  const out: RawAddr[] = [];
  text.split('\n').forEach(line => {
    const m = /^\d+:\s+(\S+)\s+inet\s+(\S+)/.exec(line);
    if (m) {
      out.push({ name: m[1], address: m[2] });
    }
  });
  return out;
}

export function parseOsRelease(text: string): { prettyName: string; id: string } {
  const get = (key: string) => {
    const m = new RegExp('^' + key + '=(.*)$', 'm').exec(text);
    return m ? m[1].replace(/^"|"$/g, '') : '';
  };
  return { prettyName: get('PRETTY_NAME'), id: get('ID') };
}

export function parseCpuModel(text: string): string {
  const m = /^model name\s*:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/parse-facts-test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 7: Commit**

```bash
git add src/modules/monitor/types.ts src/modules/monitor/parse.ts \
        src/modules/monitor/__fixtures__/proc.ts \
        src/modules/monitor/__tests__/parse-facts-test.ts
git commit -m "feat: add df, ps, addr and host fact parsers for monitoring"
```

---

### Task 4: Stream framing

**Files:**
- Create: `src/modules/monitor/frame.ts`
- Test: `src/modules/monitor/__tests__/frame-test.ts`

**Interfaces:**
- Produces: `TICK`, `END`, `MAX_BLOCK_BYTES` constants; `class Framer { push(chunk: string): string[] }`; `splitSections(block: string): {at: number; sections: {[name: string]: string}}`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/frame-test.ts`:

```ts
import { Framer, splitSections } from '../frame';

const block = (ms: number) =>
  `==TICK ${ms}\n--stat\ncpu  1 2 3 4 5 0 0 0 0 0\n--mem\nMemTotal: 100 kB\n==END\n`;

describe('Framer', () => {
  it('returns a whole block delivered in one chunk', () => {
    const f = new Framer();
    expect(f.push(block(1000)).length).toBe(1);
  });

  it('returns nothing until the terminator arrives', () => {
    const f = new Framer();
    expect(f.push('==TICK 1000\n--stat\ncpu 1 2 3 4\n')).toEqual([]);
  });

  it('reassembles a block split across chunks', () => {
    const f = new Framer();
    const whole = block(1000);
    const mid = Math.floor(whole.length / 2);
    expect(f.push(whole.slice(0, mid))).toEqual([]);
    const done = f.push(whole.slice(mid));
    expect(done.length).toBe(1);
    expect(done[0]).toContain('MemTotal');
  });

  it('returns two blocks arriving in a single chunk', () => {
    const f = new Framer();
    expect(f.push(block(1000) + block(3000)).length).toBe(2);
  });

  it('splits one byte at a time', () => {
    const f = new Framer();
    const whole = block(1000);
    let got: string[] = [];
    for (let i = 0; i < whole.length; i++) {
      got = got.concat(f.push(whole[i]));
    }
    expect(got.length).toBe(1);
  });

  it('discards leading noise before the first tick', () => {
    const f = new Framer();
    expect(f.push('bash: warning: setlocale failed\n' + block(1000)).length).toBe(1);
  });

  it('drops the buffer instead of growing without bound when no terminator arrives', () => {
    const f = new Framer();
    const junk = '==TICK 1\n' + 'x'.repeat(1024);
    let out: string[] = [];
    for (let i = 0; i < 5000; i++) {
      out = out.concat(f.push(junk));
    }
    expect(out).toEqual([]);
    expect(f.buffered()).toBeLessThan(6 * 1024 * 1024);
  });

  it('recovers and frames the next block after an overflow reset', () => {
    const f = new Framer();
    f.push('==TICK 1\n' + 'x'.repeat(5 * 1024 * 1024));
    expect(f.push(block(2000)).length).toBe(1);
  });
});

describe('splitSections', () => {
  it('reads the server timestamp from the tick line', () => {
    expect(splitSections(block(1700000000123)).at).toBe(1700000000123);
  });

  it('keys each section body by its marker', () => {
    const s = splitSections(block(1000)).sections;
    expect(s.stat.trim()).toBe('cpu  1 2 3 4 5 0 0 0 0 0');
    expect(s.mem.trim()).toBe('MemTotal: 100 kB');
  });

  it('returns an empty section map for a block with no markers', () => {
    expect(splitSections('==TICK 5\n==END\n').sections).toEqual({});
  });

  it('returns at = 0 when the tick line has no timestamp', () => {
    expect(splitSections('==TICK\n--stat\nx\n==END\n').at).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/frame-test.ts`
Expected: FAIL — `Cannot find module '../frame'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/monitor/frame.ts`:

```ts
export const TICK = '==TICK';
export const END = '==END';

// A snapshot is a few tens of kB even on a host with thousands of processes.
// Anything past this means the stream desynchronised (a shell error, a binary
// blob), so the buffer is dropped rather than grown until the window dies.
export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;

export class Framer {
  private _buf = '';

  buffered(): number {
    return this._buf.length;
  }

  // Feed a chunk of stdout; returns every complete block it completes, in order.
  push(chunk: string): string[] {
    this._buf += chunk;
    const blocks: string[] = [];

    for (;;) {
      const start = this._buf.indexOf(TICK);
      if (start === -1) {
        // Nothing useful buffered. Keep only a tail long enough to hold a
        // marker split across chunks.
        if (this._buf.length > TICK.length) {
          this._buf = this._buf.slice(-TICK.length);
        }
        break;
      }
      if (start > 0) {
        // Drop noise emitted before the loop started (login banners, warnings).
        this._buf = this._buf.slice(start);
      }
      const end = this._buf.indexOf(END);
      if (end === -1) {
        if (this._buf.length > MAX_BLOCK_BYTES) {
          this._buf = '';
        }
        break;
      }
      blocks.push(this._buf.slice(0, end));
      this._buf = this._buf.slice(end + END.length);
    }

    return blocks;
  }
}

export interface Block {
  at: number;
  sections: { [name: string]: string };
}

// Turn "==TICK 1700000000123\n--stat\n...\n--mem\n..." into a timestamp plus a
// map of section name to body.
export function splitSections(block: string): Block {
  const lines = block.split('\n');
  let at = 0;
  const sections: { [name: string]: string } = {};
  let current = '';
  let buf: string[] = [];

  const flush = () => {
    if (current) {
      sections[current] = buf.join('\n');
    }
    buf = [];
  };

  lines.forEach(line => {
    if (line.indexOf(TICK) === 0) {
      const n = Number(line.slice(TICK.length).trim());
      at = isFinite(n) ? n : 0;
      return;
    }
    if (line.indexOf('--') === 0 && line.indexOf(' ') === -1) {
      flush();
      current = line.slice(2).trim();
      return;
    }
    buf.push(line);
  });
  flush();

  return { at, sections };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/frame-test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/monitor/frame.ts src/modules/monitor/__tests__/frame-test.ts
git commit -m "feat: add incremental framing for the monitor sampler stream"
```

---

### Task 5: Remote command builders

**Files:**
- Create: `src/modules/monitor/probe.ts`
- Test: `src/modules/monitor/__tests__/probe-test.ts`

**Interfaces:**
- Consumes: `TICK`, `END` from `./frame`; `shellSingle` from `../../core/dbExec`.
- Produces: `samplerScript(idleTimeoutSec: number): string`, `slowBatchCommand(): string`, `factsCommand(): string`, `FACT_MARKERS`, `SLOW_MARKERS`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/probe-test.ts`:

```ts
import { samplerScript, slowBatchCommand, factsCommand } from '../probe';

const GAWK_ONLY = /\b(mktime|strftime|asort|asorti|gensub)\s*\(/;

describe('samplerScript', () => {
  it('is paced by stdin rather than a remote sleep', () => {
    const s = samplerScript(300);
    expect(s).toContain('while read');
    expect(s).not.toContain('sleep');
  });

  it('applies the idle timeout so an orphaned loop self-terminates', () => {
    expect(samplerScript(300)).toContain('-t 300');
  });

  it('emits the tick and end markers', () => {
    const s = samplerScript(300);
    expect(s).toContain('==TICK');
    expect(s).toContain('==END');
  });

  it('reads every fast-lane source', () => {
    const s = samplerScript(300);
    ['/proc/stat', '/proc/meminfo', '/proc/loadavg', '/proc/uptime', '/proc/net/dev', '/proc/diskstats'].forEach(
      p => expect(s).toContain(p)
    );
    expect(s).toContain('/proc/[0-9]*/stat');
  });

  it('labels each section with a marker the framer understands', () => {
    const s = samplerScript(300);
    ['--stat', '--mem', '--load', '--net', '--disk', '--pids'].forEach(m => expect(s).toContain(m));
  });

  it('uses no gawk-only awk functions', () => {
    expect(GAWK_ONLY.test(samplerScript(300))).toBe(false);
  });
});

describe('slowBatchCommand', () => {
  it('collects mounts in bytes, processes and addresses', () => {
    const c = slowBatchCommand();
    expect(c).toContain('df -PT -B1');
    expect(c).toContain('ps -eo pid=,user=,nlwp=,args=');
    expect(c).toContain('ip -o -4 addr');
  });

  it('labels each section', () => {
    const c = slowBatchCommand();
    ['--df', '--ps', '--addr'].forEach(m => expect(c).toContain(m));
  });

  it('tolerates a missing ip command instead of failing the batch', () => {
    expect(slowBatchCommand()).toContain('2>/dev/null');
  });
});

describe('factsCommand', () => {
  it('collects the one-per-session facts', () => {
    const c = factsCommand();
    expect(c).toContain('/etc/os-release');
    expect(c).toContain('/proc/cpuinfo');
    expect(c).toContain('uname -m');
    expect(c).toContain('uname -s');
    expect(c).toContain('nproc');
    expect(c).toContain('getconf PAGESIZE');
    expect(c).toContain('hostname');
    expect(c).toContain('date +%s%3N');
  });

  it('labels each section', () => {
    const c = factsCommand();
    ['--os', '--cpu', '--arch', '--kernel', '--cores', '--page', '--host', '--now'].forEach(m =>
      expect(c).toContain(m)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/probe-test.ts`
Expected: FAIL — `Cannot find module '../probe'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/monitor/probe.ts`:

```ts
import { TICK, END } from './frame';

// The fast lane. Paced from our side: each newline we write to stdin produces
// exactly one snapshot. That means the interval can change with no restart,
// pause is simply not writing, and closing the channel ends the loop (read
// hits EOF) so a closed panel cannot leave a shell running on the server.
// `-t <idle>` is the backstop for an unclean disconnect.
export function samplerScript(idleTimeoutSec: number): string {
  return [
    `while read -r -t ${idleTimeoutSec} _; do`,
    `  echo "${TICK} $(date +%s%3N)"`,
    `  echo "--stat"; cat /proc/stat`,
    `  echo "--mem"; cat /proc/meminfo`,
    `  echo "--load"; cat /proc/loadavg`,
    `  echo "--up"; cat /proc/uptime`,
    `  echo "--net"; cat /proc/net/dev`,
    `  echo "--disk"; cat /proc/diskstats`,
    `  echo "--pids"; head -1 /proc/[0-9]*/stat 2>/dev/null`,
    `  echo "${END}"`,
    `done`,
  ].join('\n');
}

// The slow lane: everything that changes rarely or costs a process spawn.
// Each command is individually tolerant of absence so one missing binary
// cannot empty the whole batch.
export function slowBatchCommand(): string {
  return [
    `echo "--df"; df -PT -B1 2>/dev/null`,
    `echo "--ps"; ps -eo pid=,user=,nlwp=,args= 2>/dev/null`,
    `echo "--addr"; ip -o -4 addr 2>/dev/null`,
  ].join('; ');
}

// Collected once when the panel opens.
export function factsCommand(): string {
  return [
    `echo "--os"; cat /etc/os-release 2>/dev/null`,
    `echo "--cpu"; cat /proc/cpuinfo 2>/dev/null`,
    `echo "--arch"; uname -m`,
    `echo "--kernel"; uname -s`,
    `echo "--cores"; nproc 2>/dev/null`,
    `echo "--page"; getconf PAGESIZE 2>/dev/null`,
    `echo "--host"; hostname 2>/dev/null`,
    `echo "--now"; date +%s%3N`,
  ].join('; ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/probe-test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/monitor/probe.ts src/modules/monitor/__tests__/probe-test.ts
git commit -m "feat: add remote probe command builders for monitoring"
```

---

### Task 6: CPU, memory and load metrics

**Files:**
- Create: `src/modules/monitor/metrics.ts`
- Modify: `src/modules/monitor/types.ts`
- Test: `src/modules/monitor/__tests__/metrics-cpu-test.ts`

**Interfaces:**
- Consumes: `RawCpu`, `RawMem`, `RawLoad` from `./types`.
- Produces: `CpuMetrics`, `MemMetrics` types; `cpuMetrics(prev: RawCpu | null, cur: RawCpu): CpuMetrics | null`, `memMetrics(raw: RawMem): MemMetrics`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/metrics-cpu-test.ts`:

```ts
import { parseStat, parseMeminfo } from '../parse';
import { cpuMetrics, memMetrics } from '../metrics';
import { STAT_8CORE, STAT_8CORE_NEXT, STAT_1CORE, MEMINFO, MEMINFO_NO_SWAP } from '../__fixtures__/proc';

describe('cpuMetrics', () => {
  it('returns null on the first sample because there is no delta yet', () => {
    expect(cpuMetrics(null, parseStat(STAT_8CORE))).toBe(null);
  });

  it('computes aggregate busy percentage from the delta', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    // aggregate delta: user +100, idle +900 => 100 busy of 1000 total = 10%
    expect(m.total).toBeCloseTo(10, 5);
  });

  it('computes per-core percentages', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    expect(m.cores.length).toBe(8);
    expect(m.cores[0]).toBeCloseTo(10, 5);
    // Cores 1-7 did not move at all.
    expect(m.cores[1]).toBe(0);
  });

  it('breaks the delta down by state', () => {
    const m = cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_8CORE_NEXT))!;
    expect(m.breakdown.user).toBeCloseTo(10, 5);
    expect(m.breakdown.system).toBe(0);
    expect(m.breakdown.iowait).toBe(0);
    expect(m.breakdown.steal).toBe(0);
  });

  it('returns zeroes rather than NaN when no jiffies elapsed', () => {
    const same = parseStat(STAT_8CORE);
    const m = cpuMetrics(same, parseStat(STAT_8CORE))!;
    expect(m.total).toBe(0);
    expect(m.cores[0]).toBe(0);
  });

  it('discards the delta when counters go backwards', () => {
    // A reboot resets /proc/stat to small values; the previous sample is larger.
    expect(cpuMetrics(parseStat(STAT_8CORE), parseStat(STAT_1CORE))).toBe(null);
  });

  it('discards the delta when the core count changes', () => {
    const prev = parseStat(STAT_1CORE);
    const cur = parseStat(STAT_8CORE_NEXT);
    // Counters grew, but 1 core became 8 — samples are not comparable.
    expect(cpuMetrics(prev, cur)).toBe(null);
  });

  it('clamps a percentage above 100 that rounding could produce', () => {
    const prev = parseStat('cpu 0 0 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0\n');
    const cur = parseStat('cpu 100 0 0 0 0 0 0 0\ncpu0 100 0 0 0 0 0 0 0\n');
    const m = cpuMetrics(prev, cur)!;
    expect(m.total).toBe(100);
  });
});

describe('memMetrics', () => {
  it('derives the used bucket as total minus free minus cached', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.total).toBe(8125000 * 1024);
    expect(m.free).toBe(1237000 * 1024);
    expect(m.cached).toBe(2540000 * 1024);
    expect(m.used).toBe((8125000 - 1237000 - 2540000) * 1024);
  });

  it('computes percentages that sum to about 100', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.usedPct + m.cachedPct + m.freePct).toBeCloseTo(100, 5);
    expect(Math.round(m.usedPct)).toBe(52);
    expect(Math.round(m.cachedPct)).toBe(31);
    expect(Math.round(m.freePct)).toBe(15);
  });

  it('computes swap used and percentage', () => {
    const m = memMetrics(parseMeminfo(MEMINFO));
    expect(m.swapUsed).toBe((1048576 - 668576) * 1024);
    expect(Math.round(m.swapPct)).toBe(36);
  });

  it('reports zero swap percentage when swap is disabled', () => {
    const m = memMetrics(parseMeminfo(MEMINFO_NO_SWAP));
    expect(m.swapTotal).toBe(0);
    expect(m.swapPct).toBe(0);
  });

  it('never returns a negative used bucket', () => {
    const m = memMetrics({ total: 1000, free: 800, available: 900, cached: 500, swapTotal: 0, swapFree: 0 });
    expect(m.used).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/metrics-cpu-test.ts`
Expected: FAIL — `Cannot find module '../metrics'`.

- [ ] **Step 3: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
export interface CpuMetrics {
  total: number;
  cores: number[];
  breakdown: {
    user: number;
    system: number;
    nice: number;
    iowait: number;
    steal: number;
  };
}

export interface MemMetrics {
  total: number;
  used: number;
  cached: number;
  free: number;
  usedPct: number;
  cachedPct: number;
  freePct: number;
  swapTotal: number;
  swapUsed: number;
  swapPct: number;
}
```

- [ ] **Step 4: Write the implementation**

Create `src/modules/monitor/metrics.ts`:

```ts
import { RawCpu, RawCpuLine, RawMem, CpuMetrics, MemMetrics } from './types';

function pct(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  const p = (part / whole) * 100;
  // Jiffy counters are sampled non-atomically across cores, so a delta can
  // land a hair over 100%. Clamp rather than render an impossible number.
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

function busyPct(prev: RawCpuLine, cur: RawCpuLine): number {
  return pct(cur.busyJiffies - prev.busyJiffies, cur.totalJiffies - prev.totalJiffies);
}

// Returns null when the two samples are not comparable: no previous sample,
// counters that moved backwards (reboot or 32-bit wrap), or a changed core
// count. Emitting a delta in any of those cases produces a visible fake spike.
export function cpuMetrics(prev: RawCpu | null, cur: RawCpu): CpuMetrics | null {
  if (!prev) {
    return null;
  }
  if (prev.cores.length !== cur.cores.length) {
    return null;
  }
  if (cur.total.totalJiffies < prev.total.totalJiffies || cur.total.busyJiffies < prev.total.busyJiffies) {
    return null;
  }

  const span = cur.total.totalJiffies - prev.total.totalJiffies;
  const delta = (key: 'user' | 'system' | 'nice' | 'iowait' | 'steal') =>
    pct(cur.total[key] - prev.total[key], span);

  return {
    total: busyPct(prev.total, cur.total),
    cores: cur.cores.map((core, i) => busyPct(prev.cores[i], core)),
    breakdown: {
      user: delta('user'),
      system: delta('system'),
      nice: delta('nice'),
      iowait: delta('iowait'),
      steal: delta('steal'),
    },
  };
}

// Memory is absolute, not a rate, so it needs no previous sample.
export function memMetrics(raw: RawMem): MemMetrics {
  const cached = raw.cached > 0 ? raw.cached : 0;
  const used = Math.max(0, raw.total - raw.free - cached);
  const swapUsed = Math.max(0, raw.swapTotal - raw.swapFree);
  return {
    total: raw.total,
    used,
    cached,
    free: raw.free,
    usedPct: pct(used, raw.total),
    cachedPct: pct(cached, raw.total),
    freePct: pct(raw.free, raw.total),
    swapTotal: raw.swapTotal,
    swapUsed,
    swapPct: pct(swapUsed, raw.swapTotal),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/metrics-cpu-test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/monitor/metrics.ts src/modules/monitor/types.ts \
        src/modules/monitor/__tests__/metrics-cpu-test.ts
git commit -m "feat: add cpu and memory metric derivation for monitoring"
```

---

### Task 7: Network and disk rate metrics

**Files:**
- Modify: `src/modules/monitor/metrics.ts`, `src/modules/monitor/types.ts`
- Test: `src/modules/monitor/__tests__/metrics-io-test.ts`

**Interfaces:**
- Produces: `NetMetrics`, `DiskMetrics` types; `netMetrics(prev, cur, elapsedMs): NetMetrics[]`, `diskMetrics(prev, cur, elapsedMs): DiskMetrics[]`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/metrics-io-test.ts`:

```ts
import { parseNetDev, parseDiskstats } from '../parse';
import { netMetrics, diskMetrics } from '../metrics';
import { NET_DEV, NET_DEV_NEXT, DISKSTATS, DISKSTATS_NEXT } from '../__fixtures__/proc';

describe('netMetrics', () => {
  it('returns null rates on the first sample', () => {
    const m = netMetrics(null, parseNetDev(NET_DEV), 2000);
    const eth = m.filter(i => i.name === 'eth0')[0];
    expect(eth.rxBps).toBe(null);
    expect(eth.txBps).toBe(null);
  });

  it('always reports absolute totals even without a previous sample', () => {
    const eth = netMetrics(null, parseNetDev(NET_DEV), 2000).filter(i => i.name === 'eth0')[0];
    expect(eth.rxTotal).toBe(4500000000);
    expect(eth.txTotal).toBe(1845000000);
  });

  it('computes bytes per second from the delta and elapsed time', () => {
    const eth = netMetrics(parseNetDev(NET_DEV), parseNetDev(NET_DEV_NEXT), 2000).filter(
      i => i.name === 'eth0'
    )[0];
    expect(eth.rxBps).toBe(1000); // 2000 bytes over 2s
    expect(eth.txBps).toBe(848); // 1696 bytes over 2s
  });

  it('drops the loopback interface', () => {
    expect(netMetrics(null, parseNetDev(NET_DEV), 2000).map(i => i.name)).toEqual(['eth0', 'ens5']);
  });

  it('reports null rather than a negative rate when a counter resets', () => {
    const eth = netMetrics(parseNetDev(NET_DEV_NEXT), parseNetDev(NET_DEV), 2000).filter(
      i => i.name === 'eth0'
    )[0];
    expect(eth.rxBps).toBe(null);
  });

  it('reports null rates when elapsed time is zero', () => {
    const eth = netMetrics(parseNetDev(NET_DEV), parseNetDev(NET_DEV_NEXT), 0).filter(
      i => i.name === 'eth0'
    )[0];
    expect(eth.rxBps).toBe(null);
  });

  it('ignores an interface that appeared since the previous sample', () => {
    const prev = parseNetDev(NET_DEV).filter(i => i.name !== 'ens5');
    const ens = netMetrics(prev, parseNetDev(NET_DEV_NEXT), 2000).filter(i => i.name === 'ens5')[0];
    expect(ens.rxBps).toBe(null);
  });
});

describe('diskMetrics', () => {
  it('computes read and write throughput', () => {
    const vda1 = diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000).filter(
      d => d.name === 'vda1'
    )[0];
    expect(vda1.readBps).toBe((1600 * 512) / 2); // 409600
    expect(vda1.writeBps).toBe((800 * 512) / 2); // 204800
  });

  it('computes iops', () => {
    const vda1 = diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000).filter(
      d => d.name === 'vda1'
    )[0];
    expect(vda1.readIops).toBe(50); // 100 reads over 2s
    expect(vda1.writeIops).toBe(25); // 50 writes over 2s
  });

  it('computes average latency as service time per io', () => {
    const vda1 = diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000).filter(
      d => d.name === 'vda1'
    )[0];
    expect(vda1.readLatencyMs).toBeCloseTo(0.2, 5); // 20ms / 100 reads
    expect(vda1.writeLatencyMs).toBeCloseTo(0.2, 5); // 10ms / 50 writes
  });

  it('reports zero latency rather than NaN when no io occurred', () => {
    const loop = diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000).filter(
      d => d.name === 'loop0'
    )[0];
    expect(loop.readLatencyMs).toBe(0);
    expect(loop.readIops).toBe(0);
  });

  it('reports absolute totals since boot', () => {
    const vda1 = diskMetrics(null, parseDiskstats(DISKSTATS), 2000).filter(d => d.name === 'vda1')[0];
    expect(vda1.readTotal).toBe(19900000 * 512);
    expect(vda1.writeTotal).toBe(119000000 * 512);
    expect(vda1.readBps).toBe(null);
  });

  it('reports null rates when counters go backwards', () => {
    const vda1 = diskMetrics(parseDiskstats(DISKSTATS_NEXT), parseDiskstats(DISKSTATS), 2000).filter(
      d => d.name === 'vda1'
    )[0];
    expect(vda1.readBps).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/metrics-io-test.ts`
Expected: FAIL — `netMetrics is not a function`.

- [ ] **Step 3: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
// Rate fields are `number | null`. null means "not computable from these two
// samples" — first tick, counter reset, or a device that just appeared — and
// renders as an em dash rather than as a zero the operator would read as idle.
export interface NetMetrics {
  name: string;
  rxBps: number | null;
  txBps: number | null;
  rxTotal: number;
  txTotal: number;
  address?: string;
}

export interface DiskMetrics {
  name: string;
  readBps: number | null;
  writeBps: number | null;
  readIops: number | null;
  writeIops: number | null;
  readLatencyMs: number | null;
  writeLatencyMs: number | null;
  readTotal: number;
  writeTotal: number;
}
```

- [ ] **Step 4: Write the implementation**

Append to `src/modules/monitor/metrics.ts`:

```ts
// Per-second rate from two counter samples. Returns null when the pair cannot
// produce a meaningful rate, so callers never show a fabricated zero.
function rate(prevVal: number | undefined, curVal: number, elapsedMs: number): number | null {
  if (prevVal === undefined || elapsedMs <= 0) {
    return null;
  }
  const delta = curVal - prevVal;
  if (delta < 0) {
    return null;
  }
  return delta / (elapsedMs / 1000);
}

function byName<T extends { name: string }>(rows: T[] | null): { [name: string]: T } {
  const map: { [name: string]: T } = {};
  (rows || []).forEach(r => {
    map[r.name] = r;
  });
  return map;
}

export function netMetrics(prev: RawNetIf[] | null, cur: RawNetIf[], elapsedMs: number): NetMetrics[] {
  const before = byName(prev);
  return cur
    // Loopback traffic tells the operator nothing about the server's network.
    .filter(i => i.name !== 'lo')
    .map(i => {
      const p = before[i.name];
      return {
        name: i.name,
        rxBps: rate(p && p.rxBytes, i.rxBytes, elapsedMs),
        txBps: rate(p && p.txBytes, i.txBytes, elapsedMs),
        rxTotal: i.rxBytes,
        txTotal: i.txBytes,
      };
    });
}

export function diskMetrics(prev: RawDisk[] | null, cur: RawDisk[], elapsedMs: number): DiskMetrics[] {
  const before = byName(prev);
  return cur.map(d => {
    const p = before[d.name];
    const readIops = rate(p && p.reads, d.reads, elapsedMs);
    const writeIops = rate(p && p.writes, d.writes, elapsedMs);
    // Latency is service time per completed io over the same interval, not a
    // per-second rate, so it is computed from the raw deltas.
    const readOps = p ? d.reads - p.reads : 0;
    const writeOps = p ? d.writes - p.writes : 0;
    const readMs = p ? d.readMs - p.readMs : 0;
    const writeMs = p ? d.writeMs - p.writeMs : 0;
    return {
      name: d.name,
      readBps: rate(p && p.readBytes, d.readBytes, elapsedMs),
      writeBps: rate(p && p.writeBytes, d.writeBytes, elapsedMs),
      readIops,
      writeIops,
      readLatencyMs: readIops === null ? null : readOps > 0 ? readMs / readOps : 0,
      writeLatencyMs: writeIops === null ? null : writeOps > 0 ? writeMs / writeOps : 0,
      readTotal: d.readBytes,
      writeTotal: d.writeBytes,
    };
  });
}
```

Extend the `./types` import at the top of `metrics.ts` to include `RawNetIf, RawDisk, NetMetrics, DiskMetrics`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/metrics-io-test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/monitor/metrics.ts src/modules/monitor/types.ts \
        src/modules/monitor/__tests__/metrics-io-test.ts
git commit -m "feat: add network and disk rate metrics for monitoring"
```

---

### Task 8: Process metrics and history buffer

**Files:**
- Modify: `src/modules/monitor/metrics.ts`, `src/modules/monitor/types.ts`
- Test: `src/modules/monitor/__tests__/metrics-proc-test.ts`

**Interfaces:**
- Produces: `ProcMetrics`, `LoadPoint` types; `MAX_PROCS`; `procMetrics(prev, cur, elapsedMs, opts): ProcMetrics[]`, `class History { push(p: LoadPoint): void; points(): LoadPoint[]; resize(capacity: number): void }`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/metrics-proc-test.ts`:

```ts
import { parsePidStats } from '../parse';
import { procMetrics, History, MAX_PROCS } from '../metrics';
import { PID_STATS, PID_STATS_NEXT } from '../__fixtures__/proc';

const OPTS = { cores: 4, pageSize: 4096, clockTicks: 100 };

describe('procMetrics', () => {
  it('returns null cpu on the first sample but still lists processes', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    expect(rows.length).toBe(3);
    expect(rows[0].cpuPct).toBe(null);
  });

  it('converts rss pages to bytes', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    const maria = rows.filter(p => p.pid === 831)[0];
    expect(maria.rssBytes).toBe(25100 * 4096);
  });

  it('computes cpu percent from utime+stime deltas', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    const maria = rows.filter(p => p.pid === 831)[0];
    // 120 jiffies over 2s at 100 ticks/sec = 120/200 = 60% of one core.
    expect(maria.cpuPct).toBeCloseTo(60, 5);
  });

  it('reports zero for a process that used no cpu', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    expect(rows.filter(p => p.pid === 1)[0].cpuPct).toBe(0);
  });

  it('does not attribute cpu to a reused pid', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    const impostor = rows.filter(p => p.pid === 209906)[0];
    // Same pid, different starttime: a different process, so no delta exists.
    expect(impostor.comm).toBe('impostor');
    expect(impostor.cpuPct).toBe(null);
  });

  it('carries the identity pair needed to verify a process later', () => {
    const rows = procMetrics(null, parsePidStats(PID_STATS), 2000, OPTS);
    const maria = rows.filter(p => p.pid === 831)[0];
    expect(maria.startTime).toBe(900);
  });

  it('sorts by cpu descending, then by rss descending', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, OPTS);
    expect(rows[0].pid).toBe(831);
  });

  it('caps the list at MAX_PROCS', () => {
    const many: string[] = [];
    for (let pid = 1; pid <= MAX_PROCS + 50; pid++) {
      many.push(`==> /proc/${pid}/stat <==`);
      many.push(
        `${pid} (p${pid}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 ${pid} 0 0 0 20 0 1 0 5 0 100 ` +
          '0 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0'
      );
    }
    const rows = procMetrics(null, parsePidStats(many.join('\n')), 2000, OPTS);
    expect(rows.length).toBe(MAX_PROCS);
  });

  it('divides by core count so a fully busy 4-core host reads 100 percent per core', () => {
    const rows = procMetrics(parsePidStats(PID_STATS), parsePidStats(PID_STATS_NEXT), 2000, {
      cores: 1,
      pageSize: 4096,
      clockTicks: 100,
    });
    // Same 120 jiffies, but the percentage is of one core either way: cpuPct is
    // per-core-normalised, matching htop's default display.
    expect(rows.filter(p => p.pid === 831)[0].cpuPct).toBeCloseTo(60, 5);
  });
});

describe('History', () => {
  it('returns points in insertion order', () => {
    const h = new History(3);
    h.push({ at: 1, one: 0.1, five: 0.2, fifteen: 0.3 });
    h.push({ at: 2, one: 0.4, five: 0.5, fifteen: 0.6 });
    expect(h.points().map(p => p.at)).toEqual([1, 2]);
  });

  it('evicts the oldest point at capacity', () => {
    const h = new History(2);
    h.push({ at: 1, one: 0, five: 0, fifteen: 0 });
    h.push({ at: 2, one: 0, five: 0, fifteen: 0 });
    h.push({ at: 3, one: 0, five: 0, fifteen: 0 });
    expect(h.points().map(p => p.at)).toEqual([2, 3]);
  });

  it('keeps the newest points when shrinking capacity', () => {
    const h = new History(4);
    [1, 2, 3, 4].forEach(at => h.push({ at, one: 0, five: 0, fifteen: 0 }));
    h.resize(2);
    expect(h.points().map(p => p.at)).toEqual([3, 4]);
  });

  it('never drops below a capacity of one', () => {
    const h = new History(0);
    h.push({ at: 1, one: 0, five: 0, fifteen: 0 });
    expect(h.points().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/metrics-proc-test.ts`
Expected: FAIL — `procMetrics is not a function`.

- [ ] **Step 3: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
export interface ProcMetrics {
  pid: number;
  startTime: number;
  comm: string;
  cpuPct: number | null;
  rssBytes: number;
  threads: number;
  user?: string;
  args?: string;
}

export interface LoadPoint {
  at: number;
  one: number;
  five: number;
  fifteen: number;
}
```

- [ ] **Step 4: Write the implementation**

Append to `src/modules/monitor/metrics.ts`:

```ts
// A host with thousands of processes would bloat every postMessage; the table
// only ever shows the busiest anyway.
export const MAX_PROCS = 200;

export interface ProcOpts {
  cores: number;
  pageSize: number;
  // USER_HZ, effectively always 100 on Linux; injected so tests are explicit.
  clockTicks: number;
}

export function procMetrics(
  prev: RawProc[] | null,
  cur: RawProc[],
  elapsedMs: number,
  opts: ProcOpts
): ProcMetrics[] {
  // Identity is pid + startTime, so a recycled pid cannot inherit the previous
  // occupant's cpu time.
  const before: { [key: string]: RawProc } = {};
  (prev || []).forEach(p => {
    before[p.pid + ':' + p.startTime] = p;
  });

  const ticks = opts.clockTicks > 0 ? opts.clockTicks : 100;
  const elapsedTicks = (elapsedMs / 1000) * ticks;

  const rows = cur.map(p => {
    const p0 = before[p.pid + ':' + p.startTime];
    let cpuPct: number | null = null;
    if (p0 && elapsedTicks > 0) {
      const used = p.utime + p.stime - (p0.utime + p0.stime);
      cpuPct = used < 0 ? null : pct(used, elapsedTicks);
    }
    return {
      pid: p.pid,
      startTime: p.startTime,
      comm: p.comm,
      cpuPct,
      rssBytes: p.rssPages * opts.pageSize,
      threads: p.threads,
    };
  });

  rows.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.rssBytes - a.rssBytes);
  return rows.slice(0, MAX_PROCS);
}

// Fixed-capacity rolling window of load samples. Lives extension-side so chart
// history survives the webview being disposed while the tab is backgrounded.
export class History {
  private _points: LoadPoint[] = [];
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = Math.max(1, capacity);
  }

  push(point: LoadPoint): void {
    this._points.push(point);
    if (this._points.length > this._capacity) {
      this._points = this._points.slice(this._points.length - this._capacity);
    }
  }

  points(): LoadPoint[] {
    return this._points;
  }

  resize(capacity: number): void {
    this._capacity = Math.max(1, capacity);
    if (this._points.length > this._capacity) {
      this._points = this._points.slice(this._points.length - this._capacity);
    }
  }
}
```

Extend the `./types` import in `metrics.ts` to include `RawProc, ProcMetrics, LoadPoint`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/metrics-proc-test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Run the whole monitor suite and typecheck**

Run: `npx jest src/modules/monitor` — all suites pass.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — no output.

- [ ] **Step 7: Commit**

```bash
git add src/modules/monitor/metrics.ts src/modules/monitor/types.ts \
        src/modules/monitor/__tests__/metrics-proc-test.ts
git commit -m "feat: add process metrics and load history buffer for monitoring"
```

---

### Task 9: Snapshot assembly

**Files:**
- Modify: `src/modules/monitor/metrics.ts`, `src/modules/monitor/types.ts`
- Test: `src/modules/monitor/__tests__/snapshot-test.ts`

**Interfaces:**
- Consumes: every parser and metric function from Tasks 1–8; `splitSections` from `./frame`.
- Produces: `Snapshot`, `SampleState`, `SlowData` types; `emptyState(): SampleState`, `buildSnapshot(state, block, opts): Snapshot | null` (mutates `state` to hold the new raw sample).

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/snapshot-test.ts`:

```ts
import { emptyState, buildSnapshot } from '../metrics';
import {
  STAT_8CORE,
  STAT_8CORE_NEXT,
  MEMINFO,
  LOADAVG,
  UPTIME,
  NET_DEV,
  NET_DEV_NEXT,
  DISKSTATS,
  DISKSTATS_NEXT,
  PID_STATS,
  PID_STATS_NEXT,
} from '../__fixtures__/proc';

const OPTS = { cores: 8, pageSize: 4096, clockTicks: 100 };

function block(at: number, next: boolean): string {
  return [
    `==TICK ${at}`,
    '--stat',
    next ? STAT_8CORE_NEXT : STAT_8CORE,
    '--mem',
    MEMINFO,
    '--load',
    LOADAVG,
    '--up',
    UPTIME,
    '--net',
    next ? NET_DEV_NEXT : NET_DEV,
    '--disk',
    next ? DISKSTATS_NEXT : DISKSTATS,
    '--pids',
    next ? PID_STATS_NEXT : PID_STATS,
  ].join('\n');
}

describe('buildSnapshot', () => {
  it('produces absolute values but no rates from the first block', () => {
    const state = emptyState();
    const snap = buildSnapshot(state, block(1000, false), OPTS)!;
    expect(snap.cpu).toBe(null);
    expect(snap.mem.total).toBe(8125000 * 1024);
    expect(snap.load).toEqual({ one: 0.07, five: 0.06, fifteen: 0.01 });
    expect(snap.uptimeSec).toBe(1234567.89);
    expect(snap.net[0].rxBps).toBe(null);
  });

  it('produces rates from the second block', () => {
    const state = emptyState();
    buildSnapshot(state, block(1000, false), OPTS);
    const snap = buildSnapshot(state, block(3000, true), OPTS)!;
    expect(snap.cpu!.total).toBeCloseTo(10, 5);
    expect(snap.net.filter(n => n.name === 'eth0')[0].rxBps).toBe(1000);
    expect(snap.disks.filter(d => d.name === 'vda1')[0].readIops).toBe(50);
    expect(snap.procs.filter(p => p.pid === 831)[0].cpuPct).toBeCloseTo(60, 5);
  });

  it('uses the server timestamps to compute elapsed time, not local time', () => {
    const state = emptyState();
    buildSnapshot(state, block(1000, false), OPTS);
    // 1000 -> 5000 is 4s, so the same byte delta halves the rate.
    const snap = buildSnapshot(state, block(5000, true), OPTS)!;
    expect(snap.net.filter(n => n.name === 'eth0')[0].rxBps).toBe(500);
    expect(snap.at).toBe(5000);
  });

  it('returns null for a block with no usable sections', () => {
    expect(buildSnapshot(emptyState(), '==TICK 1000\n', OPTS)).toBe(null);
  });

  it('survives a block missing an optional section', () => {
    const state = emptyState();
    const partial = ['==TICK 1000', '--stat', STAT_8CORE, '--mem', MEMINFO, '--load', LOADAVG].join('\n');
    const snap = buildSnapshot(state, partial, OPTS)!;
    expect(snap.mem.total).toBeGreaterThan(0);
    expect(snap.disks).toEqual([]);
    expect(snap.procs).toEqual([]);
  });

  it('ignores a block whose timestamp is not newer than the previous one', () => {
    const state = emptyState();
    buildSnapshot(state, block(3000, false), OPTS);
    expect(buildSnapshot(state, block(3000, true), OPTS)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/snapshot-test.ts`
Expected: FAIL — `emptyState is not a function`.

- [ ] **Step 3: Add the types**

Append to `src/modules/monitor/types.ts`:

```ts
export interface SlowData {
  mounts: RawMount[];
  psRows: RawPsRow[];
  addrs: RawAddr[];
}

export interface Snapshot {
  // Server clock in ms, straight from the sampler's `date +%s%3N`.
  at: number;
  cpu: CpuMetrics | null;
  mem: MemMetrics;
  load: RawLoad;
  uptimeSec: number;
  net: NetMetrics[];
  disks: DiskMetrics[];
  procs: ProcMetrics[];
}

// The previous raw sample, carried between ticks so rates can be derived.
export interface SampleState {
  at: number;
  cpu: RawCpu | null;
  net: RawNetIf[] | null;
  disks: RawDisk[] | null;
  procs: RawProc[] | null;
}
```

- [ ] **Step 4: Write the implementation**

Append to `src/modules/monitor/metrics.ts`:

```ts
export function emptyState(): SampleState {
  return { at: 0, cpu: null, net: null, disks: null, procs: null };
}

// Parse one framed block into a Snapshot, deriving every rate against `state`,
// then advance `state` to this sample. Returns null when the block carries
// nothing usable or arrives out of order.
export function buildSnapshot(state: SampleState, block: string, opts: ProcOpts): Snapshot | null {
  const { at, sections } = splitSections(block);
  if (!sections.stat || !sections.mem) {
    return null;
  }
  // A non-monotonic timestamp means a duplicated or reordered block; deriving
  // rates from it would produce a divide-by-zero or a negative interval.
  if (state.at && at <= state.at) {
    return null;
  }

  const elapsedMs = state.at ? at - state.at : 0;
  const cpu = parseStat(sections.stat);
  const net = sections.net ? parseNetDev(sections.net) : [];
  const disks = sections.disk ? parseDiskstats(sections.disk) : [];
  const procs = sections.pids ? parsePidStats(sections.pids) : [];

  const snapshot: Snapshot = {
    at,
    cpu: cpuMetrics(state.cpu, cpu),
    mem: memMetrics(parseMeminfo(sections.mem)),
    load: sections.load ? parseLoadavg(sections.load) : { one: 0, five: 0, fifteen: 0 },
    uptimeSec: sections.up ? parseUptime(sections.up) : 0,
    net: netMetrics(state.net, net, elapsedMs),
    disks: diskMetrics(state.disks, disks, elapsedMs),
    procs: procMetrics(state.procs, procs, elapsedMs, opts),
  };

  state.at = at;
  state.cpu = cpu;
  state.net = net;
  state.disks = disks;
  state.procs = procs;

  return snapshot;
}
```

Add to the top of `metrics.ts`:

```ts
import { splitSections } from './frame';
import {
  parseStat,
  parseMeminfo,
  parseLoadavg,
  parseUptime,
  parseNetDev,
  parseDiskstats,
  parsePidStats,
} from './parse';
```

and extend the `./types` import with `Snapshot, SampleState`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/snapshot-test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/monitor/metrics.ts src/modules/monitor/types.ts \
        src/modules/monitor/__tests__/snapshot-test.ts
git commit -m "feat: assemble monitor snapshots from framed sampler blocks"
```

---

### Task 10: Collector over an injectable transport

**Files:**
- Create: `src/modules/monitor/collector.ts`
- Test: `src/modules/monitor/__tests__/collector-test.ts`

**Interfaces:**
- Consumes: `Framer` from `./frame`; `samplerScript`, `slowBatchCommand` from `./probe`; `buildSnapshot`, `emptyState`, `History` from `./metrics`; `parseDf`, `parsePs`, `parseAddr` from `./parse`.
- Produces: `MonitorTransport`, `SamplerChannel`, `CollectorOpts` interfaces; `class Collector` with `start()`, `stop()`, `setInterval(ms)`, `pause()`, `resume()`, `isPaused()`, `history()`, and the callbacks `onSnapshot`, `onSlow`, `onClosed`, `onError`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/collector-test.ts`:

```ts
import { Collector, MonitorTransport, SamplerChannel } from '../collector';
import { Snapshot, SlowData } from '../types';
import {
  STAT_8CORE,
  STAT_8CORE_NEXT,
  MEMINFO,
  LOADAVG,
  UPTIME,
  NET_DEV,
  NET_DEV_NEXT,
  DISKSTATS,
  DISKSTATS_NEXT,
  PID_STATS,
  PID_STATS_NEXT,
  DF,
  PS,
  IP_ADDR,
} from '../__fixtures__/proc';

function block(at: number, next: boolean): string {
  return [
    `==TICK ${at}`,
    '--stat', next ? STAT_8CORE_NEXT : STAT_8CORE,
    '--mem', MEMINFO,
    '--load', LOADAVG,
    '--up', UPTIME,
    '--net', next ? NET_DEV_NEXT : NET_DEV,
    '--disk', next ? DISKSTATS_NEXT : DISKSTATS,
    '--pids', next ? PID_STATS_NEXT : PID_STATS,
    '==END',
  ].join('\n');
}

class FakeChannel implements SamplerChannel {
  writes: string[] = [];
  closed = false;
  private _data: (chunk: string) => void = () => undefined;
  private _close: () => void = () => undefined;

  onData(cb: (chunk: string) => void) { this._data = cb; }
  onClose(cb: () => void) { this._close = cb; }
  write(s: string) { this.writes.push(s); }
  close() { this.closed = true; this._close(); }

  // test helpers
  emit(chunk: string) { this._data(chunk); }
  serverClose() { this._close(); }
}

class FakeTransport implements MonitorTransport {
  channel = new FakeChannel();
  execs: string[] = [];
  openError: Error | null = null;
  execError: Error | null = null;

  async openSampler(): Promise<SamplerChannel> {
    if (this.openError) { throw this.openError; }
    return this.channel;
  }

  async exec(cmd: string) {
    this.execs.push(cmd);
    if (this.execError) { throw this.execError; }
    return {
      stdout: ['--df', DF, '--ps', PS, '--addr', IP_ADDR].join('\n'),
      stderr: '',
      code: 0,
    };
  }
}

const OPTS = { cores: 8, pageSize: 4096, clockTicks: 100, interval: 2000, slowInterval: 10000, historyMinutes: 5 };

function collector(t: MonitorTransport) {
  return new Collector(t, OPTS);
}

describe('Collector', () => {
  it('requests the first sample as soon as it starts', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    expect(t.channel.writes.length).toBe(1);
    c.stop();
  });

  it('emits a snapshot for each complete block', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    const seen: Snapshot[] = [];
    c.onSnapshot = s => seen.push(s);
    await c.start();
    t.channel.emit(block(1000, false));
    t.channel.emit(block(3000, true));
    expect(seen.length).toBe(2);
    expect(seen[1].cpu!.total).toBeCloseTo(10, 5);
    c.stop();
  });

  it('requests the next sample only after the previous one arrives', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    expect(t.channel.writes.length).toBe(1);
    t.channel.emit(block(1000, false));
    // The pacing timer, not the block itself, issues the next request.
    expect(t.channel.writes.length).toBe(1);
    c.tickNow();
    expect(t.channel.writes.length).toBe(2);
    c.stop();
  });

  it('appends each load reading to history', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    t.channel.emit(block(1000, false));
    t.channel.emit(block(3000, true));
    expect(c.history().points().length).toBe(2);
    expect(c.history().points()[0].one).toBe(0.07);
    c.stop();
  });

  it('stops requesting samples while paused and resumes afterwards', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    c.pause();
    c.tickNow();
    expect(t.channel.writes.length).toBe(1);
    expect(c.isPaused()).toBe(true);
    c.resume();
    expect(t.channel.writes.length).toBe(2);
    c.stop();
  });

  it('emits slow data parsed from the batch command', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let slow: SlowData | null = null;
    c.onSlow = s => { slow = s; };
    await c.start();
    await c.slowNow();
    expect(slow!.mounts.map(m => m.mount)).toEqual(['/', '/mnt/my data']);
    expect(slow!.psRows.length).toBe(3);
    expect(slow!.addrs.filter(a => a.name === 'eth0')[0].address).toBe('66.154.126.186/24');
    c.stop();
  });

  it('closes the channel and stops timers on stop', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    c.stop();
    expect(t.channel.closed).toBe(true);
    c.tickNow();
    expect(t.channel.writes.length).toBe(1);
  });

  it('reports a channel that closes from the server side', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let closed = false;
    c.onClosed = () => { closed = true; };
    await c.start();
    t.channel.serverClose();
    expect(closed).toBe(true);
  });

  it('surfaces a failure to open the sampler', async () => {
    const t = new FakeTransport();
    t.openError = new Error('channel refused');
    const c = collector(t);
    let msg = '';
    c.onError = e => { msg = e.message; };
    await c.start();
    expect(msg).toBe('channel refused');
  });

  it('reports a slow-lane failure without stopping the fast lane', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    let msg = '';
    c.onError = e => { msg = e.message; };
    await c.start();
    t.execError = new Error('ps not found');
    await c.slowNow();
    expect(msg).toBe('ps not found');
    t.channel.emit(block(1000, false));
    expect(c.history().points().length).toBe(1);
    c.stop();
  });

  it('resizes history when the interval changes so the span stays 5 minutes', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    await c.start();
    // 5 minutes at 2s = 150 samples; at 5s = 60 samples.
    expect(c.historyCapacity()).toBe(150);
    c.setInterval(5000);
    expect(c.historyCapacity()).toBe(60);
    c.stop();
  });

  it('ignores a malformed block without breaking the stream', async () => {
    const t = new FakeTransport();
    const c = collector(t);
    const seen: Snapshot[] = [];
    c.onSnapshot = s => seen.push(s);
    await c.start();
    t.channel.emit('==TICK 500\ngarbage\n==END\n');
    t.channel.emit(block(1000, false));
    expect(seen.length).toBe(1);
    c.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/collector-test.ts`
Expected: FAIL — `Cannot find module '../collector'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/monitor/collector.ts`:

```ts
import { Framer } from './frame';
import { samplerScript, slowBatchCommand } from './probe';
import { buildSnapshot, emptyState, History, ProcOpts } from './metrics';
import { parseDf, parsePs, parseAddr } from './parse';
import { splitSections } from './frame';
import { SampleState, Snapshot, SlowData } from './types';

// Seconds of silence after which the remote loop exits on its own. Covers an
// unclean disconnect where the channel close never reaches the server.
const IDLE_TIMEOUT_SEC = 300;

export interface SamplerChannel {
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
  write(s: string): void;
  close(): void;
}

export interface MonitorTransport {
  openSampler(cmd: string): Promise<SamplerChannel>;
  exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface CollectorOpts extends ProcOpts {
  interval: number;
  slowInterval: number;
  historyMinutes: number;
}

export class Collector {
  onSnapshot: (s: Snapshot) => void = () => undefined;
  onSlow: (s: SlowData) => void = () => undefined;
  onClosed: () => void = () => undefined;
  onError: (e: Error) => void = () => undefined;

  private _transport: MonitorTransport;
  private _opts: CollectorOpts;
  private _framer = new Framer();
  private _state: SampleState = emptyState();
  private _history: History;
  private _channel: SamplerChannel | null = null;
  private _fastTimer: any = null;
  private _slowTimer: any = null;
  private _paused = false;
  private _stopped = false;

  constructor(transport: MonitorTransport, opts: CollectorOpts) {
    this._transport = transport;
    this._opts = opts;
    this._history = new History(this._capacityFor(opts.interval));
  }

  async start(): Promise<void> {
    try {
      this._channel = await this._transport.openSampler(samplerScript(IDLE_TIMEOUT_SEC));
    } catch (error) {
      this.onError(error as Error);
      return;
    }
    if (this._stopped) {
      // stop() landed while the channel was still opening.
      this._channel.close();
      return;
    }

    this._channel.onData(chunk => {
      this._framer.push(chunk).forEach(block => this._handleBlock(block));
    });
    this._channel.onClose(() => {
      this._channel = null;
      this._clearTimers();
      if (!this._stopped) {
        this.onClosed();
      }
    });

    this.tickNow();
    this._fastTimer = setInterval(() => this.tickNow(), this._opts.interval);
    this._slowTimer = setInterval(() => this.slowNow(), this._opts.slowInterval);
    await this.slowNow();
  }

  // Ask the remote loop for one snapshot. Public so the panel can force a
  // refresh and so tests can advance without real timers.
  tickNow(): void {
    if (this._stopped || this._paused || !this._channel) {
      return;
    }
    this._channel.write('\n');
  }

  async slowNow(): Promise<void> {
    if (this._stopped) {
      return;
    }
    try {
      const res = await this._transport.exec(slowBatchCommand());
      const { sections } = splitSections(res.stdout);
      this.onSlow({
        mounts: sections.df ? parseDf(sections.df) : [],
        psRows: sections.ps ? parsePs(sections.ps) : [],
        addrs: sections.addr ? parseAddr(sections.addr) : [],
      });
    } catch (error) {
      // A failing slow lane greys out a card; it must not kill the fast lane.
      this.onError(error as Error);
    }
  }

  setInterval(ms: number): void {
    this._opts.interval = ms;
    this._history.resize(this._capacityFor(ms));
    if (this._fastTimer) {
      clearInterval(this._fastTimer);
      this._fastTimer = setInterval(() => this.tickNow(), ms);
    }
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    this.tickNow();
  }

  isPaused(): boolean {
    return this._paused;
  }

  history(): History {
    return this._history;
  }

  historyCapacity(): number {
    return this._capacityFor(this._opts.interval);
  }

  stop(): void {
    this._stopped = true;
    this._clearTimers();
    if (this._channel) {
      // Closing stdin ends the remote `read` loop, so no shell is left behind.
      this._channel.close();
      this._channel = null;
    }
  }

  private _capacityFor(intervalMs: number): number {
    const span = this._opts.historyMinutes * 60 * 1000;
    return Math.max(1, Math.floor(span / Math.max(1, intervalMs)));
  }

  private _clearTimers(): void {
    if (this._fastTimer) {
      clearInterval(this._fastTimer);
      this._fastTimer = null;
    }
    if (this._slowTimer) {
      clearInterval(this._slowTimer);
      this._slowTimer = null;
    }
  }

  private _handleBlock(block: string): void {
    const snapshot = buildSnapshot(this._state, block, this._opts);
    if (!snapshot) {
      return;
    }
    this._history.push({
      at: snapshot.at,
      one: snapshot.load.one,
      five: snapshot.load.five,
      fifteen: snapshot.load.fifteen,
    });
    this.onSnapshot(snapshot);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/collector-test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/monitor/collector.ts src/modules/monitor/__tests__/collector-test.ts
git commit -m "feat: add monitor collector over an injectable transport"
```

---

### Task 11: SSH transport and `execStream`

**Files:**
- Modify: `src/core/remote-client/sshClient.ts` (after `exec`, around line 381)
- Create: `src/modules/monitor/transport.ts`
- Test: `src/modules/monitor/__tests__/transport-test.ts`

**Interfaces:**
- Consumes: `getSshClient` from `../../core/sshAccess`; `MonitorTransport`, `SamplerChannel` from `./collector`.
- Produces: `SSHClient.execStream(cmd): Promise<any>`; `channelFromStream(stream): SamplerChannel`; `sshTransport(fileService, config): MonitorTransport`; `readFacts(transport, hostname): Promise<HostFacts>`.

**Note on test scope:** `execStream` itself is a five-line passthrough to `ssh2`'s callback API and is verified by the manual smoke test in Task 15. What *is* unit-tested here is `channelFromStream` — the adapter that turns a Node stream into a `SamplerChannel` — and `readFacts`, since both contain real logic.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/transport-test.ts`:

```ts
import { EventEmitter } from 'events';
import { channelFromStream, readFacts } from '../transport';
import { OS_RELEASE, CPUINFO } from '../__fixtures__/proc';

class FakeStream extends EventEmitter {
  written: string[] = [];
  ended = false;
  stderr = new EventEmitter();
  write(s: string) { this.written.push(s); return true; }
  end() { this.ended = true; }
}

describe('channelFromStream', () => {
  it('forwards decoded data chunks', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    const chunks: string[] = [];
    ch.onData(c => chunks.push(c));
    s.emit('data', Buffer.from('hello'));
    expect(chunks).toEqual(['hello']);
  });

  it('forwards close', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = false;
    ch.onClose(() => { closed = true; });
    s.emit('close');
    expect(closed).toBe(true);
  });

  it('treats a stream error as a close so the panel can recover', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = 0;
    ch.onClose(() => { closed++; });
    s.emit('error', new Error('broken pipe'));
    expect(closed).toBe(1);
  });

  it('reports close only once even if error and close both fire', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = 0;
    ch.onClose(() => { closed++; });
    s.emit('error', new Error('broken pipe'));
    s.emit('close');
    expect(closed).toBe(1);
  });

  it('writes pacing newlines to the stream', () => {
    const s = new FakeStream();
    channelFromStream(s as any).write('\n');
    expect(s.written).toEqual(['\n']);
  });

  it('ends the stream on close', () => {
    const s = new FakeStream();
    channelFromStream(s as any).close();
    expect(s.ended).toBe(true);
  });

  it('swallows a write after close instead of throwing', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    ch.close();
    expect(() => ch.write('\n')).not.toThrow();
    expect(s.written).toEqual([]);
  });
});

describe('readFacts', () => {
  const transport = (stdout: string) => ({
    openSampler: () => Promise.reject(new Error('unused')),
    exec: () => Promise.resolve({ stdout, stderr: '', code: 0 }),
  });

  const FACTS = [
    '--os', OS_RELEASE,
    '--cpu', CPUINFO,
    '--arch', 'x86_64',
    '--kernel', 'Linux',
    '--cores', '8',
    '--page', '4096',
    '--host', 'apex',
    '--now', '1700000000123',
  ].join('\n');

  it('reads every fact', async () => {
    const f = await readFacts(transport(FACTS), 'fallback');
    expect(f.prettyName).toBe('Ubuntu 22.04.5 LTS (Jammy Jellyfish)');
    expect(f.distroId).toBe('ubuntu');
    expect(f.cpuModel).toBe('Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz');
    expect(f.arch).toBe('x86_64');
    expect(f.cores).toBe(8);
    expect(f.pageSize).toBe(4096);
    expect(f.hostname).toBe('apex');
    expect(f.serverEpochMs).toBe(1700000000123);
    expect(f.linux).toBe(true);
  });

  it('flags a non-Linux kernel', async () => {
    const f = await readFacts(transport(FACTS.replace('Linux', 'Darwin')), 'fallback');
    expect(f.linux).toBe(false);
  });

  it('falls back to sane defaults when facts are missing', async () => {
    const f = await readFacts(transport('--kernel\nLinux\n'), 'fallback-host');
    expect(f.hostname).toBe('fallback-host');
    expect(f.cores).toBe(1);
    expect(f.pageSize).toBe(4096);
    expect(f.prettyName).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/transport-test.ts`
Expected: FAIL — `Cannot find module '../transport'`.

- [ ] **Step 3: Add `execStream` to SSHClient**

In `src/core/remote-client/sshClient.ts`, immediately after the `exec` method (which ends at line 381), insert:

```ts
  // Like `exec`, but hands back the live channel instead of buffering to close,
  // so callers can read output incrementally and write to stdin while the
  // command runs. Used by the monitoring sampler loop.
  execStream(cmd: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this._client.exec(cmd, (err, stream) => {
        if (err) {
          return reject(err);
        }
        resolve(stream);
      });
    });
  }
```

- [ ] **Step 4: Write the transport**

Create `src/modules/monitor/transport.ts`:

```ts
import { getSshClient } from '../../core/sshAccess';
import { splitSections } from './frame';
import { factsCommand } from './probe';
import { parseOsRelease, parseCpuModel } from './parse';
import { MonitorTransport, SamplerChannel } from './collector';
import { HostFacts } from './types';

// Adapt an ssh2 channel to the SamplerChannel the collector consumes. Kept
// separate from execStream so it can be tested against a plain EventEmitter.
export function channelFromStream(stream: any): SamplerChannel {
  let closed = false;
  let onCloseCb: () => void = () => undefined;
  const fireClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    onCloseCb();
  };

  stream.on('error', fireClose);
  stream.on('close', fireClose);

  return {
    onData(cb: (chunk: string) => void) {
      stream.on('data', (d: Buffer) => cb(d.toString()));
    },
    onClose(cb: () => void) {
      onCloseCb = cb;
    },
    write(s: string) {
      if (!closed) {
        stream.write(s);
      }
    },
    close() {
      fireClose();
      stream.end();
    },
  };
}

export function sshTransport(fileService: any, config: any): MonitorTransport {
  return {
    async openSampler(cmd: string) {
      const ssh = await getSshClient(fileService, config);
      return channelFromStream(await ssh.execStream(cmd));
    },
    async exec(cmd: string) {
      const ssh = await getSshClient(fileService, config);
      return ssh.exec(cmd);
    },
  };
}

function num(s: string, fallback: number): number {
  const n = Number((s || '').trim());
  return isFinite(n) && n > 0 ? n : fallback;
}

// One round trip for everything that does not change while the panel is open.
export async function readFacts(transport: MonitorTransport, fallbackHost: string): Promise<HostFacts> {
  const res = await transport.exec(factsCommand());
  const s = splitSections(res.stdout).sections;
  const os = parseOsRelease(s.os || '');
  return {
    hostname: (s.host || '').trim() || fallbackHost,
    prettyName: os.prettyName,
    distroId: os.id,
    cpuModel: parseCpuModel(s.cpu || ''),
    arch: (s.arch || '').trim(),
    cores: num(s.cores, 1),
    pageSize: num(s.page, 4096),
    serverEpochMs: num(s.now, 0),
    linux: (s.kernel || '').trim() === 'Linux',
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/transport-test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/core/remote-client/sshClient.ts src/modules/monitor/transport.ts \
        src/modules/monitor/__tests__/transport-test.ts
git commit -m "feat: add execStream and the ssh-backed monitor transport"
```

---

### Task 12: Webview shell, header gauges and CPU cards

**Files:**
- Create: `src/modules/monitor/html.ts`
- Test: `src/modules/monitor/__tests__/html-test.ts`

**Interfaces:**
- Produces: `monitorHtml(cspSource: string): string`, `escapeHtml(s: any): string`.

**Design note:** the client script is a template string because `tsconfig` has `lib: ["es6"]` with no DOM types. It must therefore stay logic-light: formatting and DOM assembly only, since every number arrives pre-computed from `metrics.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/monitor/__tests__/html-test.ts`:

```ts
import { monitorHtml, escapeHtml } from '../html';

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
  });
  it('escapes quotes so it is safe inside an attribute', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });
  it('renders null and undefined as an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('monitorHtml', () => {
  const html = monitorHtml('vscode-webview://abc');

  it('declares a content security policy scoped to the webview source', () => {
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('vscode-webview://abc');
  });

  it('loads no external resources', () => {
    expect(/(src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
  });

  it('contains a container for every milestone-1 card', () => {
    ['id="cpu"', 'id="load"', 'id="mem"', 'id="net"', 'id="storage"', 'id="procs"', 'id="gauges"'].forEach(
      id => expect(html).toContain(id)
    );
  });

  it('takes all colours from vscode theme variables', () => {
    expect(html).toContain('var(--vscode-foreground)');
    expect(html).toContain('var(--vscode-editor-background)');
  });

  it('exposes the interactive controls', () => {
    ['id="pause"', 'id="ivl"', 'id="procfilter"'].forEach(id => expect(html).toContain(id));
  });

  it('acquires the vscode api and posts a ready message', () => {
    expect(html).toContain('acquireVsCodeApi()');
    expect(html).toContain("type: 'ready'");
  });

  it('renders an em dash for null rates', () => {
    expect(html).toContain("'—'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/monitor/__tests__/html-test.ts`
Expected: FAIL — `Cannot find module '../html'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/monitor/html.ts`. Structure it as: `escapeHtml`, a `CSS` constant, a `SCRIPT` constant, and `monitorHtml()` assembling them.

```ts
export function escapeHtml(s: any): string {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 0 10px 16px; }
  .bar { position: sticky; top: 0; z-index: 3; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 0; display: flex;
         gap: 10px; align-items: center; flex-wrap: wrap; }
  .bar .host { font-size: 14px; font-weight: 600; }
  .badge { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px;
           color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; }
  select, button { font-family: inherit; font-size: 12px; background: var(--vscode-input-background);
                   color: var(--vscode-input-foreground);
                   border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 6px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; }
  #gauges { display: flex; gap: 14px; align-items: center; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-top: 10px; padding: 8px 10px; }
  .card h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase;
             color: var(--vscode-descriptionForeground); letter-spacing: .04em; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .cores { display: flex; flex-wrap: wrap; gap: 2px; }
  .core { width: 10px; height: 12px; background: var(--vscode-panel-border); }
  .meter { height: 8px; background: var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--vscode-charts-blue, #3794ff); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
  th { color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
  td.num, th.num { text-align: right; }
  .muted { color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); }
  #offline { display: none; padding: 8px 10px; margin-top: 10px;
             border: 1px solid var(--vscode-errorForeground); border-radius: 6px; }
`;
```

The `SCRIPT` constant must implement, using only DOM APIs available in a webview:

- `acquireVsCodeApi()`, then `post({ type: 'ready' })` on load.
- `fmtBytes`, `fmtRate`, `fmtPct`, `fmtDuration` helpers; **every one returns `'—'` for `null`**.
- `window.addEventListener('message', ...)` dispatching on `msg.type`: `init`, `tick`, `slow`, `state`, `connection`, `error`.
- `init` fills the host name, distro badge, CPU model, and core count.
- `tick` renders: three ring gauges (inline SVG `stroke-dasharray` arcs), the per-core bar grid (bar height by percentage, `title` attribute with the exact value), the breakdown row, the memory donut plus swap meter, the network rows, and the process table.
- The **load chart** is a `<canvas>` redrawn per tick from the `history` array carried on each `tick` message: three polylines, axis labels at the extremes, and a hover readout driven by `mousemove` mapping x to the nearest sample.
- Process table: header cells sort client-side (`sortKey`/`sortDir` module state, re-render from the retained `lastProcs`); `#procfilter` filters on `comm` and `args` substring, case-insensitive.
- `#pause` toggles and posts `{type: 'pause'}` / `{type: 'resume'}`; `#ivl` posts `{type: 'setInterval', ms}`.
- `connection` with `up: false` reveals `#offline`, whose button posts `{type: 'reconnect'}`.

Then:

```ts
export function monitorHtml(cspSource: string): string {
  // Inline style and script only, and no external origins: the CSP below is
  // what keeps this page unable to reach the network.
  const csp =
    `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; ` +
    `script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>${CSS}</style></head><body>
    <div class="bar">
      <span class="host" id="host">…</span>
      <span class="badge" id="distro"></span>
      <span class="badge muted" id="uptime"></span>
      <div class="spacer"></div>
      <div id="gauges"></div>
      <button id="pause">Pause</button>
      <select id="ivl">
        <option value="1000">1s</option>
        <option value="2000" selected>2s</option>
        <option value="5000">5s</option>
        <option value="10000">10s</option>
      </select>
    </div>
    <div id="offline"><span class="err">Connection lost.</span> <button id="reconnect">Reconnect</button></div>
    <div class="card" id="cpu"><h3>CPU Usage</h3><div id="cpubody"></div></div>
    <div class="grid2">
      <div class="card" id="load"><h3>CPU Load</h3><canvas id="loadchart" height="120"></canvas><div id="loadnow" class="muted"></div></div>
      <div class="card" id="procs"><h3>Processes</h3>
        <input id="procfilter" placeholder="filter…"><div id="procbody"></div></div>
    </div>
    <div class="grid2">
      <div class="card" id="mem"><h3>Memory Usage</h3><div id="membody"></div></div>
      <div class="card" id="net"><h3>Network Usage</h3><div id="netbody"></div></div>
    </div>
    <div class="card" id="storage"><h3>Storage</h3><div id="storagebody"></div></div>
    <script>${SCRIPT}</script></body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/monitor/__tests__/html-test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/monitor/html.ts src/modules/monitor/__tests__/html-test.ts
git commit -m "feat: add monitoring dashboard webview markup and client script"
```

---

### Task 13: Panel lifecycle and message routing

**Files:**
- Create: `src/modules/monitor/index.ts`

**Interfaces:**
- Consumes: `Collector`, `sshTransport`, `readFacts`, `monitorHtml`, `HostFacts`.
- Produces: `openMonitor(fileService: any, config: any): Promise<void>`.

**Test note:** this module is VS Code API glue — the repo's `__mocks__/vscode.js` is a catch-all `Nothing` proxy, so a unit test here would assert nothing real. It is verified by the manual smoke test in Task 15. Keep it thin: every decision worth testing already lives in `collector.ts` or `metrics.ts`.

- [ ] **Step 1: Write the implementation**

Create `src/modules/monitor/index.ts`:

```ts
import * as vscode from 'vscode';
import { Collector } from './collector';
import { sshTransport, readFacts } from './transport';
import { monitorHtml } from './html';
import logger from '../../logger';
import { getExtensionSetting } from '../ext';

interface Session {
  panel: vscode.WebviewPanel;
  collector: Collector;
}

const sessions = new Map<string, Session>();

function keyFor(config: any): string {
  return `${config.name || ''}@${config.host}:${config.port}`;
}

function settings() {
  const s: any = getExtensionSetting() || {};
  const monitor = s.monitor || {};
  return {
    interval: monitor.interval || 2000,
    slowInterval: monitor.slowInterval || 10000,
    historyMinutes: monitor.historyMinutes || 5,
  };
}

export async function openMonitor(fileService: any, config: any): Promise<void> {
  const key = keyFor(config);
  const existing = sessions.get(key);
  if (existing) {
    // Never open a second dashboard for one host: that would double-sample it.
    existing.panel.reveal();
    return;
  }

  const transport = sshTransport(fileService, config);
  let facts;
  try {
    facts = await readFacts(transport, config.host);
  } catch (error) {
    vscode.window.showErrorMessage(`Monitoring: ${(error as Error).message}`);
    return;
  }
  if (!facts.linux) {
    vscode.window.showErrorMessage('Monitoring requires a Linux host.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'sftpMonitor',
    `Monitor: ${config.name || facts.hostname}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = monitorHtml(panel.webview.cspSource);

  const cfg = settings();
  const collector = new Collector(transport, {
    cores: facts.cores,
    pageSize: facts.pageSize,
    clockTicks: 100,
    interval: cfg.interval,
    slowInterval: cfg.slowInterval,
    historyMinutes: cfg.historyMinutes,
  });

  const post = (msg: any) => panel.webview.postMessage(msg);

  collector.onSnapshot = snapshot =>
    post({ type: 'tick', snapshot, history: collector.history().points() });
  collector.onSlow = slow => post({ type: 'slow', slow });
  collector.onError = error => {
    logger.error(error, 'monitor');
    post({ type: 'error', message: error.message });
  };
  collector.onClosed = () => post({ type: 'connection', up: false });

  panel.webview.onDidReceiveMessage(async (msg: any) => {
    if (msg.type === 'ready') {
      post({ type: 'init', facts, interval: cfg.interval });
      await collector.start();
    } else if (msg.type === 'pause') {
      collector.pause();
      post({ type: 'state', paused: true });
    } else if (msg.type === 'resume') {
      collector.resume();
      post({ type: 'state', paused: false });
    } else if (msg.type === 'setInterval') {
      collector.setInterval(Number(msg.ms) || cfg.interval);
      post({ type: 'state', interval: Number(msg.ms) || cfg.interval });
    } else if (msg.type === 'reconnect') {
      try {
        // fileService.reconnect() rebuilds the cached connection; a null return
        // means there was nothing connected to rebuild.
        const pending = fileService.reconnect();
        if (pending) {
          await pending;
        }
        await collector.start();
        post({ type: 'connection', up: true });
      } catch (error) {
        post({ type: 'error', message: (error as Error).message });
      }
    }
  });

  // The collector's lifetime is the panel's lifetime, not its visibility:
  // polling deliberately continues while the tab is hidden.
  panel.onDidDispose(() => {
    collector.stop();
    sessions.delete(key);
  });

  sessions.set(key, { panel, collector });
}
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'`
Expected: no output.

- [ ] **Step 3: Verify the whole suite still passes**

Run: `npx jest src/modules/monitor`
Expected: all monitor suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/monitor/index.ts
git commit -m "feat: add monitoring panel lifecycle and message routing"
```

---

### Task 14: Command, constants and package.json wiring

**Files:**
- Modify: `src/constants.ts`
- Create: `src/commands/commandOpenMonitoring.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `openMonitor` from `../modules/monitor`; `checkCommand` from `./abstract/createCommand`; `ExplorerRoot` from `../modules/remoteExplorer`.
- Produces: the registered `sftp.openMonitoring` command.

- [ ] **Step 1: Add the constant**

In `src/constants.ts`, directly after the `COMMAND_OPEN_CONNECTION_IN_TERMINAL` line (near line 21 where `COMMAND_RECONNECT` also lives), add:

```ts
export const COMMAND_OPEN_MONITORING = 'sftp.openMonitoring';
```

- [ ] **Step 2: Write the command**

Create `src/commands/commandOpenMonitoring.ts`:

```ts
import * as vscode from 'vscode';
import { COMMAND_OPEN_MONITORING } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { openMonitor } from '../modules/monitor';

export default checkCommand({
  id: COMMAND_OPEN_MONITORING,

  async handleCommand(exploreItem?: ExplorerRoot) {
    if (exploreItem && exploreItem.explorerContext) {
      const { config, fileService } = exploreItem.explorerContext;
      if (config.protocol && config.protocol !== 'sftp') {
        vscode.window.showErrorMessage('Monitoring requires an SFTP (SSH) connection.');
        return;
      }
      await openMonitor(fileService, config);
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
      vscode.window.showInformationMessage('SFTP: no SFTP connection to monitor.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a connection…' });
    if (!picked) {
      return;
    }
    await openMonitor(picked.fileService, picked.config);
  },
});
```

- [ ] **Step 3: Contribute the command**

In `package.json` `contributes.commands`, immediately after the `sftp.openConnectInTerminal` entry, add:

```json
      {
        "command": "sftp.openMonitoring",
        "title": "Open Monitoring",
        "category": "SFTP"
      },
```

- [ ] **Step 4: Contribute the menu entry**

The existing `sftp.openConnectInTerminal` entry in `view/item/context` has no `@` order, so it sorts first within `navigation`. Change it to `"group": "navigation@0"` and add immediately after it:

```json
      {
        "command": "sftp.openMonitoring",
        "group": "navigation@1",
        "when": "view == remoteExplorer && viewItem == root"
      },
```

- [ ] **Step 5: Contribute the settings**

In `package.json` `contributes.configuration.properties`, after `sftp.showSizeInRemoteExplorer`, add:

```json
        "sftp.monitor.interval": {
          "type": "number",
          "default": 2000,
          "description": "Monitoring dashboard refresh interval for CPU, memory, network and processes (ms)."
        },
        "sftp.monitor.slowInterval": {
          "type": "number",
          "default": 10000,
          "description": "Monitoring dashboard refresh interval for disk usage and process metadata (ms)."
        },
        "sftp.monitor.historyMinutes": {
          "type": "number",
          "default": 5,
          "description": "How many minutes of load history the monitoring chart keeps."
        },
```

- [ ] **Step 6: Verify the command registers and the build succeeds**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — no output.
Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json parses')"` — prints the message.
Run: `npm run compile` — completes without errors.

- [ ] **Step 7: Commit**

```bash
git add src/constants.ts src/commands/commandOpenMonitoring.ts package.json
git commit -m "feat: wire up the Open Monitoring command and settings"
```

---

### Task 15: Manual verification, docs and version bump

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Run the full verification set**

Run: `npx jest 2>&1 | tail -8`
Expected: all suites pass **except** the one pre-existing failure, `transfer algorithm › sync › sync --update with time offset`. Total passing should be 146 plus every test added by this plan.

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/'` — no output.
Run: `npm run compile` — succeeds.

- [ ] **Step 2: Manual smoke test against a real Linux server**

Press `F5` in VS Code to launch the Extension Development Host, open a workspace with a working `sftp.json`, then:

1. Right-click the Remote Explorer root → confirm **Open Monitoring** appears directly below **Open SSH in Terminal**.
2. Click it. Within ~3s the header shows hostname, distro badge, and three gauges; every card populates.
3. Confirm the first tick shows `—` for network and disk rates, and real numbers from the second tick on.
4. Run `yes > /dev/null` on the server over SSH; confirm one core's bar and the process table both react within ~4s, and that the process ranks top by CPU. Kill it; confirm it drops back.
5. Sort the process table by Memory, then filter for `mysql`; confirm both respond instantly with no tick delay.
6. Switch to another editor tab for a minute, then return: the load chart must show unbroken history across that gap (this is what "keep polling when hidden" buys).
7. Change the interval to 5s; confirm the tick rate changes without the panel reloading.
8. Press Pause; confirm the numbers freeze. Resume; confirm they continue.
9. Close the panel. On the server run `ps aux | grep 'while read'` and confirm **no** sampler loop is left running.
10. With the panel open, break the connection (stop the VPN, or `sudo ss -K` the session). Confirm the offline banner appears and Reconnect recovers the feed.
11. Run the command from the palette with no explorer selection; confirm the quick pick lists connections and opens the same dashboard.
12. Open Monitoring twice for the same connection; confirm the existing tab is revealed rather than a second one opened.

Record any deviation as a bug to fix before the next step. Do not proceed with failures outstanding.

- [ ] **Step 3: Document the feature**

In `README.md`, add a `### Monitoring` subsection under the features area covering: what the dashboard shows, that it requires an SFTP/SSH connection to a **Linux** host, that it installs nothing on the server, that polling continues while the tab is hidden, and the three `sftp.monitor.*` settings. Add a row to the platform-support table:

```
| Live server monitoring dashboard (Linux servers) | ✅ | ✅ |
```

(The Windows and macOS columns describe the *workstation*; the server must be Linux either way.)

- [ ] **Step 4: Bump the version**

In `package.json`, change `"version": "1.20.2"` to `"version": "1.21.0"`.

- [ ] **Step 5: Package to confirm the vsix builds**

Run: `npm run package`
Expected: produces `vaibhav-sftp-plus-1.21.0.vsix` with no errors.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json
git commit -m "docs: document the monitoring dashboard; bump to 1.21.0"
```

---

## Self-Review

**Spec coverage (milestone 1 scope):**

| Spec requirement | Task |
|---|---|
| Command wiring, palette fallback, FTP rejection | 14 |
| Menu position after *Open SSH in Terminal* | 14 |
| Module layout | 1–13 |
| `execStream` | 11 |
| Stdin-paced sampler, EOF termination, idle timeout | 5, 10 |
| Framing resilient to split chunks | 4 |
| Probe/cadence table | 5, 10 |
| Instantaneous process CPU, not `ps` lifetime average | 8 |
| Delta rules: first tick, counter regression, pid reuse | 6, 7, 8 |
| History ring buffer surviving webview disposal | 8, 10, 13 |
| Full-parity cards for CPU, load, memory, network, storage, processes | 12 |
| Hand-rolled SVG/canvas, no dependencies, theme variables | 12 |
| Message protocol | 12, 13 |
| Polling continues while hidden | 13 (+ verified in 15) |
| Non-Linux and FTP guards | 13, 14 |
| Second invocation reveals existing panel | 13 |
| Connection drop → Reconnect via `fileService.reconnect()` | 13 |
| Process cap of 200 | 8 |
| Settings | 14 |
| README and version bump | 15 |

Deliberately **not** covered here — milestones 2–4, each getting its own plan: log analytics, IP geolocation, and kill/service control. The spec's `monitor.logs` / `monitor.services` / `monitor.sudo` config block and its Joi and JSON-schema changes belong to those plans, since nothing in milestone 1 reads them.

**Placeholder scan:** no TBDs. Task 12's client script is specified as a behaviour list rather than a full listing — deliberate, because it is presentation code with no branching logic to get wrong, its structural requirements are pinned by the eight assertions in `html-test.ts`, and its visual result is checked in Task 15 step 2. Every other code step is complete and runnable.

**Type consistency:** `RawCpuLine.totalJiffies`/`busyJiffies` are produced in Task 1 and consumed in Task 6. `RawProc.startTime` (Task 2) feeds `ProcMetrics.startTime` (Task 8). `RawMount.deviceName` (Task 3) is the join key to `DiskMetrics.name` (Task 7). `ProcOpts` is defined in Task 8 and extended by `CollectorOpts` in Task 10. `MonitorTransport`/`SamplerChannel` are declared in Task 10 and implemented in Task 11. `splitSections` (Task 4) is used by Tasks 9, 10, and 11. Rate fields are `number | null` everywhere, and every formatter in Task 12 renders `null` as `'—'`.
