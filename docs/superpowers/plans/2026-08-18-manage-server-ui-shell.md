# Manage Server — Milestone 2: UI Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bootstrap diagnostics page with the real dashboard — dark sidebar shell, host header with a live status badge, and an Overview tab showing per-core CPU, memory, load, network, filesystems and top processes as cards and charts.

**Architecture:** A React app under `webui/`, built by Vite into `media/webui`, which milestone 1's HTTP server already serves and already falls back away from when absent. The app is a pure SSE consumer: it opens `/api/stream` once and renders whatever arrives. All chart series are derived in the browser from the in-memory history the server already sends with every tick — there is no new server endpoint and no new server state in this milestone.

**Tech Stack:** React 18 + Vite 6 + Recharts, built separately from the extension's webpack bundle. Components are `.jsx`; pure logic is `.ts` tested by the existing jest.

**Spec:** `docs/superpowers/specs/2026-08-17-manage-server-design.md`

**Reference implementation to port:** `/opt/homebrew/var/www/Local/Server-manager/client/` — `App.jsx`, `components/{ui,Charts,Overview}.jsx`, `styles.css`, `api.js`. Roughly 800 lines of the 2,400 are in scope for this milestone; Services/WebServer/Logs/Terminal are later milestones.

## Global Constraints

- **Milestone 2 only.** Services, Web server, Logs, Terminal, the Database tab's contents, and the VPN fixed port are later milestones. Do not build them. The tab bar renders those tabs **disabled**, driven by the `capabilities` flags `/api/session` already returns (all `false` today).
- **No new runtime dependencies.** New **dev** dependencies are allowed and expected: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `recharts`. They are devDependencies because the extension host never imports them — only the browser bundle does, and that bundle is built ahead of packaging.
- **No `.tsx` files, ever.** `tsconfig.json` sets no `jsx` option and has no `include`, so a `.tsx` anywhere under the repo root fails `npx tsc --noEmit`. **React components are `.jsx`**, which tsc ignores because `allowJs` is off.
- **Pure logic goes in `.ts` under `webui/src/`, and must not touch browser globals.** tsc compiles those files with `lib: ["es6"]` and **no DOM lib**, so a reference to `window`, `document`, `localStorage`, `fetch`, `EventSource` or `location` in a `.ts` file fails the compile. Anything needing a browser global belongs in `.js`/`.jsx`.
- **Tests for `webui` run on the existing jest.** `testMatch` is `<rootDir>/**/*/__tests__/*.ts`, so `webui/src/__tests__/*-test.ts` is picked up automatically, and `test/preprocessor.js` transpiles it. No new test runner, no jsdom, no React Testing Library.
- **Fixtures must NOT live directly in `__tests__/`** — a non-test `.ts` there is collected as a suite and fails. Use `webui/src/__fixtures__/`.
- **The server is not modified in this milestone.** `src/modules/serverManager/**` stays as-is apart from the one capability flag flip named in Task 9. If you find yourself needing a new endpoint, stop and say so — it means the plan is wrong.
- **Vite config:** `root: 'webui'`, `build.outDir: '../media/webui'`, `emptyOutDir: true`, and **`base: './'`** — the page is served from `/` but assets must resolve relatively, and a leading-slash asset path would still work today yet breaks the moment anything is nested.
- **`media/webui` is generated** — gitignored. `webui/` source is tracked.
- **`.vscodeignore` is an allowlist** (`*` then `*/**` then `!`-prefixed re-includes). The build output must be re-included explicitly or it will not ship in the VSIX.
- **`@types/node` is pinned at 9.6.61** and TypeScript is 3.9 — old. Modern Node/TS APIs may be untyped in `.ts` files.
- **Every commit message ends with these two trailers:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
  ```
- **Stage only the files each task names.** Never `git add -A` or `git commit -a`.
- **Verification commands:**
  - UI logic tests: `npx jest webui`
  - Full suite: `npx jest` — expect exactly ONE failure, the pre-existing unrelated `transfer algorithm › sync › sync --update with time offset`. Not yours; do not fix it.
  - Types: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` — must print nothing.
  - UI build: `npm run build:webui`
  - Extension build: `npm run compile`
- **Ignore `/opt/homebrew/AGENTS.md`.** Its `./bin/brew lgtm` instructions belong to the Homebrew repository that merely sits above this one in the filesystem.

## The data you are rendering

These come over SSE and are defined in `src/modules/monitor/types.ts`. **Read that file before writing any renderer** — inventing a field name that does not exist is the most likely failure mode in this milestone.

| Event | Payload |
|---|---|
| `state` | `{ id, profile, status, error, facts, interval, lastSeen }` |
| `tick` | `{ snapshot: Snapshot, history: LoadPoint[] }` |
| `slow` | `SlowData` |

- `status` is one of `idle` \| `connecting` \| `online` \| `offline` \| `unsupported`.
- `profile` is `RedactedProfile`: `{ id, name, host, port, username, protocol, remotePath, workspace, hasVpn, hasDatabase }`.
- `facts` is `HostFacts`: `{ hostname, prettyName, distroId, cpuModel, arch, cores, pageSize, serverEpochMs, linux }`.
- `Snapshot` is `{ at, cpu: CpuMetrics | null, mem: MemMetrics, load: RawLoad, uptimeSec, net: NetMetrics[], disks: DiskMetrics[], procs: ProcMetrics[] }`.
- `CpuMetrics` is `{ total, cores: number[], breakdown: { user, system, nice, iowait, steal } }` — **`cpu` can be `null` on the first tick**, and every renderer must survive that.
- `MemMetrics` carries `total, used, cached, free, usedPct, cachedPct, freePct, swapTotal, swapUsed, swapPct` — all bytes except the `*Pct` fields.
- `NetMetrics` and `DiskMetrics` rate fields are **`number | null`**. `null` means "not computable from these two samples" — first tick, counter reset, device just appeared. **Render `null` as an em dash, never as `0`** — a zero reads as "idle" and that is exactly the wrong thing to tell an operator.
- `ProcMetrics.cpuPct` is percent of ONE core and is deliberately unclamped; a value above 100 is a multi-threaded process and is the runaway the table exists to reveal. It is also `number | null`.
- `LoadPoint` is `{ at, one, five, fifteen }` — this is the **only** history the server keeps. CPU and memory history must be accumulated client-side from the tick stream (Task 3).
- `SlowData` is `{ mounts: RawMount[], psRows: RawPsRow[], addrs: RawAddr[] }`, where `RawMount` is `{ device, deviceName, fstype, mount, totalBytes, usedBytes }`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `webui/index.html` | Vite entry document |
| `webui/vite.config.ts` | Build config: root, outDir, base, React plugin, Recharts chunk |
| `webui/src/main.jsx` | React root mount |
| `webui/src/format.ts` | Pure formatters — bytes, rates, percentages, durations, tone |
| `webui/src/series.ts` | Pure chart-series derivation and time-window trimming |
| `webui/src/__fixtures__/snapshot.ts` | Captured Snapshot/SlowData/state fixtures for the logic tests |
| `webui/src/__tests__/format-test.ts` | Formatter tests |
| `webui/src/__tests__/series-test.ts` | Series derivation tests |
| `webui/src/api.js` | Token handling, fetch wrapper, SSE subscription |
| `webui/src/useSession.js` | React hook owning session state and the tick stream |
| `webui/src/styles.css` | The dark theme |
| `webui/src/components/ui.jsx` | Card, Stat, Badge, Empty, Modal primitives |
| `webui/src/components/Charts.jsx` | Recharts wrappers — area and multi-series line |
| `webui/src/components/Overview.jsx` | The Overview tab |
| `webui/src/pages/Dashboard.jsx` | Host card page |
| `webui/src/pages/Activity.jsx` | Privileged-command log page |
| `webui/src/pages/Settings.jsx` | Redacted profile + settings page |
| `webui/src/App.jsx` | Shell: sidebar, header, tab bar, routing |
| `webui/dev/mock-server.js` | Dev-only static+SSE server with synthetic data, for headless UI verification |

**Modified:**

| File | Change |
|---|---|
| `package.json` | devDependencies, `build:webui` / `watch:webui` scripts, `vscode:prepublish` |
| `.gitignore` | `media/webui` |
| `.vscodeignore` | Re-include `media/webui/**/*` |
| `README.md` | Manage Server section describes the real UI |
| `src/modules/serverManager/routes.ts` | Task 9 only: nothing — see that task |

---

### Task 1: Build pipeline

Ends with `npm run build:webui` producing `media/webui/index.html`, and the extension's HTTP server serving a React page instead of the bootstrap page. Nothing is styled yet; the point of this task is that the pipeline is real.

**Files:**
- Create: `webui/index.html`, `webui/vite.config.ts`, `webui/src/main.jsx`
- Modify: `package.json`, `.gitignore`, `.vscodeignore`

**Interfaces:**
- Consumes: nothing.
- Produces: the `media/webui` build output that milestone 1's `serveStatic` already looks for; `npm run build:webui`.

- [ ] **Step 1: Add the dev dependencies**

Run: `npm install --save-dev vite@^6 @vitejs/plugin-react@^4 react@^18 react-dom@^18 recharts@^2`

Expected: installs cleanly, `package.json` gains five devDependencies, `package-lock.json` updates.

- [ ] **Step 2: Create the Vite entry document**

Create `webui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Server Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the Vite config**

Create `webui/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // The page is served from '/', but relative asset URLs keep working if the
  // app is ever mounted under a prefix. An absolute '/assets/...' would not.
  base: './',
  build: {
    outDir: '../media/webui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Recharts is the bulk of the bundle. Its own chunk means the shell
          // paints before the charting code is parsed.
          charts: ['recharts'],
        },
      },
    },
  },
});
```

- [ ] **Step 4: Create a minimal React root**

Create `webui/src/main.jsx`:

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <h1>Server Manager</h1>;
}

createRoot(document.getElementById('root')).render(<App />);
```

- [ ] **Step 5: Wire the scripts**

In `package.json` `scripts`, add these two and change `vscode:prepublish`:

```jsonc
"build:webui": "vite build --config webui/vite.config.ts",
"watch:webui": "vite build --config webui/vite.config.ts --watch",
"vscode:prepublish": "npm run build:webui && npm run compile"
```

- [ ] **Step 6: Ignore the build output, ship it in the VSIX**

Append to `.gitignore`:

```
media/webui
```

In `.vscodeignore`, add this line at the end (the file is an allowlist — everything is ignored by `*` and `*/**` until re-included):

```
!media/webui/**/*
```

- [ ] **Step 7: Build and verify the output**

Run: `npm run build:webui`
Expected: succeeds, and `ls media/webui` shows `index.html` plus an `assets/` directory.

Run: `node -e "const s=require('fs').readFileSync('media/webui/index.html','utf8'); if(!/src=\"\.\//.test(s)) { throw new Error('asset paths are not relative — check base'); } console.log('relative asset paths OK');"`
Expected: prints `relative asset paths OK`.

- [ ] **Step 8: Verify the extension still builds and types are clean**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'`
Expected: no output. If `webui/vite.config.ts` produces errors here, that is the constraint about tsc compiling every `.ts` biting — resolve it by adding `"webui/vite.config.ts"` to `tsconfig.json`'s `exclude` array, and note it in your report.

Run: `npm run compile`
Expected: webpack succeeds. The `webui/` tree is not in webpack's graph, so nothing there should affect it.

Run: `npx jest` — expect only the one known pre-existing failure.

- [ ] **Step 9: Commit**

```bash
git add webui/index.html webui/vite.config.ts webui/src/main.jsx package.json package-lock.json .gitignore .vscodeignore
git commit -m "$(cat <<'EOF'
build: add the webui vite pipeline

media/webui is what milestone 1's static server already looks for, so a
successful build replaces the bootstrap diagnostics page with the React
app. Components are .jsx rather than .tsx because tsconfig sets no jsx
option and would fail on a .tsx anywhere under the repo root.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 2: Pure formatters

**Files:**
- Create: `webui/src/format.ts`
- Test: `webui/src/__tests__/format-test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `fmtBytes(n: number | null | undefined, digits?: number): string`
  - `fmtRate(n: number | null | undefined): string`
  - `fmtUptime(seconds: number | null | undefined): string`
  - `fmtAgo(ts: number | null | undefined, now: number): string`
  - `fmtPct(n: number | null | undefined, digits?: number): string`
  - `pct(used: number, total: number): number | null`
  - `toneForPct(v: number | null): 'ok' | 'warn' | 'bad' | ''`

Note `fmtAgo` takes `now` as a parameter rather than calling `Date.now()`. That is what makes it testable, and this file must not reach for globals anyway.

- [ ] **Step 1: Write the failing test**

Create `webui/src/__tests__/format-test.ts`:

```ts
import { fmtBytes, fmtRate, fmtUptime, fmtAgo, fmtPct, pct, toneForPct } from '../format';

describe('fmtBytes', () => {
  it('renders bytes without decimals', () => {
    expect(fmtBytes(512)).toBe('512 B');
  });
  it('scales to KB, MB, GB and TB', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB');
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
    expect(fmtBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.0 TB');
  });
  it('honours a digits argument', () => {
    expect(fmtBytes(1536, 2)).toBe('1.50 KB');
  });
  it('renders an em dash for null and undefined, never a zero', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(undefined)).toBe('—');
  });
  it('renders a real zero as zero', () => {
    expect(fmtBytes(0)).toBe('0 B');
  });
});

describe('fmtRate', () => {
  it('suffixes per second', () => {
    expect(fmtRate(2048)).toBe('2.0 KB/s');
  });
  it('renders an em dash for a null rate', () => {
    // null means "not computable from these two samples". A zero would read as
    // idle, which is the opposite of the truth.
    expect(fmtRate(null)).toBe('—');
  });
});

describe('fmtUptime', () => {
  it('renders minutes under an hour', () => {
    expect(fmtUptime(1800)).toBe('30m');
  });
  it('renders hours and minutes under a day', () => {
    expect(fmtUptime(3600 * 5 + 60 * 7)).toBe('5h 7m');
  });
  it('renders days and hours beyond a day', () => {
    expect(fmtUptime(86400 * 3 + 3600 * 4)).toBe('3d 4h');
  });
  it('renders an em dash for null', () => {
    expect(fmtUptime(null)).toBe('—');
  });
});

describe('fmtAgo', () => {
  const NOW = 1_000_000_000_000;
  it('renders seconds', () => {
    expect(fmtAgo(NOW - 5000, NOW)).toBe('5s ago');
  });
  it('renders minutes', () => {
    expect(fmtAgo(NOW - 120_000, NOW)).toBe('2m ago');
  });
  it('renders hours', () => {
    expect(fmtAgo(NOW - 7_200_000, NOW)).toBe('2h ago');
  });
  it('renders never for a null timestamp', () => {
    expect(fmtAgo(null, NOW)).toBe('never');
  });
  it('clamps a future timestamp to 0s rather than going negative', () => {
    // The server clock drives `at`; a workstation clock behind the server's
    // must not render "-3s ago".
    expect(fmtAgo(NOW + 3000, NOW)).toBe('0s ago');
  });
});

describe('fmtPct', () => {
  it('renders one decimal by default', () => {
    expect(fmtPct(30.963777)).toBe('31.0%');
  });
  it('renders an em dash for null', () => {
    expect(fmtPct(null)).toBe('—');
  });
});

describe('pct', () => {
  it('computes a percentage', () => {
    expect(pct(50, 200)).toBe(25);
  });
  it('returns null for a zero total rather than NaN or Infinity', () => {
    expect(pct(5, 0)).toBeNull();
  });
});

describe('toneForPct', () => {
  it('is ok below 70', () => {
    expect(toneForPct(10)).toBe('ok');
  });
  it('is warn from 70 to under 90', () => {
    expect(toneForPct(70)).toBe('warn');
    expect(toneForPct(89.9)).toBe('warn');
  });
  it('is bad at 90 and above', () => {
    expect(toneForPct(90)).toBe('bad');
    expect(toneForPct(100)).toBe('bad');
  });
  it('is neutral for null', () => {
    expect(toneForPct(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest webui/src/__tests__/format-test.ts`
Expected: FAIL — `Cannot find module '../format'`

- [ ] **Step 3: Write the implementation**

Create `webui/src/format.ts`:

```ts
// Pure presentation helpers. This file is compiled by tsc with lib es6 and NO
// DOM lib, so it must never touch a browser global — that is also why fmtAgo
// takes `now` rather than calling Date.now().

const DASH = '—';
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && isFinite(n);
}

export function fmtBytes(n: number | null | undefined, digits: number = 1): string {
  if (!isNum(n)) {
    return DASH;
  }
  let value = n;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

// A null rate means the delta was not computable, not that the device is idle.
// Rendering a zero here would be an outright lie to whoever is reading it.
export function fmtRate(n: number | null | undefined): string {
  return isNum(n) ? `${fmtBytes(n)}/s` : DASH;
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (!isNum(seconds)) {
    return DASH;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) {
    return `${d}d ${h}h`;
  }
  if (h) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function fmtAgo(ts: number | null | undefined, now: number): string {
  if (!isNum(ts)) {
    return 'never';
  }
  // Timestamps come from the SERVER clock. If the workstation clock lags, the
  // difference goes negative; clamp rather than render "-3s ago".
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtPct(n: number | null | undefined, digits: number = 1): string {
  return isNum(n) ? `${n.toFixed(digits)}%` : DASH;
}

export function pct(used: number, total: number): number | null {
  return total ? (used / total) * 100 : null;
}

export function toneForPct(v: number | null): 'ok' | 'warn' | 'bad' | '' {
  if (!isNum(v)) {
    return '';
  }
  if (v >= 90) {
    return 'bad';
  }
  if (v >= 70) {
    return 'warn';
  }
  return 'ok';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest webui/src/__tests__/format-test.ts`
Expected: PASS

- [ ] **Step 5: Check types**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add webui/src/format.ts webui/src/__tests__/format-test.ts
git commit -m "$(cat <<'EOF'
feat: add pure formatters for the server manager UI

Null rates render as an em dash, never a zero — a zero reads as idle,
which is the opposite of what a null delta means.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 3: Chart series derivation

The piece with no equivalent in the reference app: it read history from SQLite, we accumulate it in the browser from the tick stream. This is pure and gets real tests.

**Files:**
- Create: `webui/src/series.ts`, `webui/src/__fixtures__/snapshot.ts`
- Test: `webui/src/__tests__/series-test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `LoadPoint` shapes (structurally — do not import from `src/`, redeclare the minimal shapes locally so the browser bundle stays independent of the extension source tree).
- Produces:
  - `interface SeriesPoint { at: number; [key: string]: number | null }`
  - `RANGES: { label: string; minutes: number }[]` — `5m`, `15m`, `60m`
  - `pushPoint(buffer: SeriesPoint[], point: SeriesPoint, capacity: number): SeriesPoint[]`
  - `trimToWindow(points: SeriesPoint[], minutes: number, now: number): SeriesPoint[]`
  - `cpuPoint(snapshot: any): SeriesPoint | null`
  - `memPoint(snapshot: any): SeriesPoint | null`
  - `netPoint(snapshot: any): SeriesPoint | null`
  - `loadSeries(history: any[]): SeriesPoint[]`

- [ ] **Step 1: Write the fixtures**

Create `webui/src/__fixtures__/snapshot.ts`:

```ts
// Shapes captured from src/modules/monitor/types.ts. Kept deliberately minimal:
// each fixture carries only the fields the series derivation reads.
export const SNAP_FULL: any = {
  at: 1_700_000_000_000,
  cpu: {
    total: 20.4,
    cores: [10, 30, 15, 26],
    breakdown: { user: 12, system: 6, nice: 0, iowait: 2, steal: 0.4 },
  },
  mem: {
    total: 16_000_000_000,
    used: 5_000_000_000,
    cached: 8_000_000_000,
    free: 3_000_000_000,
    usedPct: 31.25,
    cachedPct: 50,
    freePct: 18.75,
    swapTotal: 0,
    swapUsed: 0,
    swapPct: 0,
  },
  load: { one: 0.83, five: 0.5, fifteen: 0.3 },
  uptimeSec: 2040,
  net: [
    { name: 'eth0', rxBps: 3000, txBps: 190_000, rxTotal: 1, txTotal: 2 },
    { name: 'lo', rxBps: 10, txBps: 10, rxTotal: 1, txTotal: 1 },
  ],
  disks: [],
  procs: [],
};

// The first tick after a connect or a counter reset: cpu is null and every
// rate is null. Every renderer must survive this.
export const SNAP_FIRST_TICK: any = {
  at: 1_700_000_000_000,
  cpu: null,
  mem: SNAP_FULL.mem,
  load: { one: 0, five: 0, fifteen: 0 },
  uptimeSec: 10,
  net: [{ name: 'eth0', rxBps: null, txBps: null, rxTotal: 0, txTotal: 0 }],
  disks: [],
  procs: [],
};

export const HISTORY: any[] = [
  { at: 1_700_000_000_000, one: 0.1, five: 0.2, fifteen: 0.3 },
  { at: 1_700_000_002_000, one: 0.4, five: 0.3, fifteen: 0.3 },
  { at: 1_700_000_004_000, one: 0.83, five: 0.5, fifteen: 0.3 },
];
```

- [ ] **Step 2: Write the failing test**

Create `webui/src/__tests__/series-test.ts`:

```ts
import {
  RANGES,
  pushPoint,
  trimToWindow,
  cpuPoint,
  memPoint,
  netPoint,
  loadSeries,
} from '../series';
import { SNAP_FULL, SNAP_FIRST_TICK, HISTORY } from '../__fixtures__/snapshot';

describe('RANGES', () => {
  it('offers 5, 15 and 60 minute windows', () => {
    // Not 1h/6h/24h/7d: history is in memory only, so anything beyond
    // historyMinutes (default 60) could never be filled.
    expect(RANGES.map(r => r.minutes)).toEqual([5, 15, 60]);
  });
});

describe('pushPoint', () => {
  it('appends a point', () => {
    const out = pushPoint([], { at: 1 }, 10);
    expect(out).toEqual([{ at: 1 }]);
  });
  it('drops the oldest point once capacity is exceeded', () => {
    const buf = [{ at: 1 }, { at: 2 }];
    expect(pushPoint(buf, { at: 3 }, 2)).toEqual([{ at: 2 }, { at: 3 }]);
  });
  it('does not mutate the input buffer', () => {
    const buf = [{ at: 1 }];
    pushPoint(buf, { at: 2 }, 10);
    expect(buf).toEqual([{ at: 1 }]);
  });
  it('ignores an out-of-order point rather than corrupting the axis', () => {
    // The server clock can step backwards across a reconnect.
    const buf = [{ at: 5 }];
    expect(pushPoint(buf, { at: 3 }, 10)).toEqual([{ at: 5 }]);
  });
});

describe('trimToWindow', () => {
  const NOW = 1_000_000;
  it('keeps points inside the window', () => {
    const points = [{ at: NOW - 60_000 }, { at: NOW }];
    expect(trimToWindow(points, 5, NOW).length).toBe(2);
  });
  it('drops points older than the window', () => {
    const points = [{ at: NOW - 600_000 }, { at: NOW }];
    expect(trimToWindow(points, 5, NOW)).toEqual([{ at: NOW }]);
  });
  it('returns an empty array when everything is stale', () => {
    expect(trimToWindow([{ at: 0 }], 5, NOW)).toEqual([]);
  });
});

describe('cpuPoint', () => {
  it('carries total and every core as its own series', () => {
    const p = cpuPoint(SNAP_FULL);
    expect(p).not.toBeNull();
    expect(p!.at).toBe(SNAP_FULL.at);
    expect(p!.total).toBe(20.4);
    expect(p!.core0).toBe(10);
    expect(p!.core3).toBe(26);
  });
  it('returns null when cpu is null on the first tick', () => {
    expect(cpuPoint(SNAP_FIRST_TICK)).toBeNull();
  });
});

describe('memPoint', () => {
  it('carries used and cached percentages', () => {
    const p = memPoint(SNAP_FULL);
    expect(p!.usedPct).toBe(31.25);
    expect(p!.cachedPct).toBe(50);
  });
  it('survives the first tick, since mem is always present', () => {
    expect(memPoint(SNAP_FIRST_TICK)).not.toBeNull();
  });
});

describe('netPoint', () => {
  it('sums rates across physical interfaces and excludes loopback', () => {
    const p = netPoint(SNAP_FULL);
    expect(p!.rx).toBe(3000);
    expect(p!.tx).toBe(190_000);
  });
  it('yields nulls, not zeros, when every rate is null', () => {
    const p = netPoint(SNAP_FIRST_TICK);
    expect(p!.rx).toBeNull();
    expect(p!.tx).toBeNull();
  });
});

describe('loadSeries', () => {
  it('maps history straight through', () => {
    const s = loadSeries(HISTORY);
    expect(s.length).toBe(3);
    expect(s[2].one).toBe(0.83);
    expect(s[2].five).toBe(0.5);
    expect(s[2].fifteen).toBe(0.3);
  });
  it('returns an empty array for missing history', () => {
    expect(loadSeries(undefined as any)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest webui/src/__tests__/series-test.ts`
Expected: FAIL — `Cannot find module '../series'`

- [ ] **Step 4: Write the implementation**

Create `webui/src/series.ts`:

```ts
// Pure chart-series derivation. No browser globals — see format.ts for why.
//
// The server keeps only load history (LoadPoint[]). CPU, memory and network
// series are accumulated here from the tick stream, which is why pushPoint has
// to be defensive about ordering and capacity.

export interface SeriesPoint {
  at: number;
  [key: string]: number | null;
}

// In-memory history only, so the ranges stop at the server's historyMinutes
// default of 60. Offering 24h or 7d would promise data that cannot exist.
export const RANGES = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '60 min', minutes: 60 },
];

export function pushPoint(
  buffer: SeriesPoint[],
  point: SeriesPoint,
  capacity: number
): SeriesPoint[] {
  const last = buffer.length ? buffer[buffer.length - 1] : null;
  // A server clock that stepped backwards across a reconnect would otherwise
  // draw the axis inside out.
  if (last && point.at <= last.at) {
    return buffer;
  }
  const next = buffer.concat([point]);
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

export function trimToWindow(
  points: SeriesPoint[],
  minutes: number,
  now: number
): SeriesPoint[] {
  const cutoff = now - minutes * 60 * 1000;
  return points.filter(p => p.at >= cutoff);
}

export function cpuPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.cpu) {
    return null;
  }
  const point: SeriesPoint = { at: snapshot.at, total: snapshot.cpu.total };
  (snapshot.cpu.cores || []).forEach((v: number, i: number) => {
    point[`core${i}`] = v;
  });
  return point;
}

export function memPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.mem) {
    return null;
  }
  return {
    at: snapshot.at,
    usedPct: snapshot.mem.usedPct,
    cachedPct: snapshot.mem.cachedPct,
  };
}

// Loopback traffic is not throughput anyone is trying to see, and including it
// swamps the scale on a busy host.
function isPhysical(name: string): boolean {
  return name !== 'lo' && name.indexOf('ifb') !== 0;
}

export function netPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.net) {
    return null;
  }
  const ifaces = snapshot.net.filter((n: any) => isPhysical(n.name));
  let rx: number | null = null;
  let tx: number | null = null;
  ifaces.forEach((n: any) => {
    if (typeof n.rxBps === 'number') {
      rx = (rx || 0) + n.rxBps;
    }
    if (typeof n.txBps === 'number') {
      tx = (tx || 0) + n.txBps;
    }
  });
  return { at: snapshot.at, rx, tx };
}

export function loadSeries(history: any[]): SeriesPoint[] {
  if (!history || !history.length) {
    return [];
  }
  return history.map(p => ({ at: p.at, one: p.one, five: p.five, fifteen: p.fifteen }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest webui/src/__tests__/series-test.ts`
Expected: PASS

- [ ] **Step 6: Check types and commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` — no output.

```bash
git add webui/src/series.ts webui/src/__fixtures__/snapshot.ts webui/src/__tests__/series-test.ts
git commit -m "$(cat <<'EOF'
feat: add chart series derivation for the server manager UI

The server keeps only load history, so CPU, memory and network series are
accumulated in the browser from the tick stream. pushPoint rejects
out-of-order points because a reconnect can step the server clock back.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 4: API client and session hook

**Files:**
- Create: `webui/src/api.js`, `webui/src/useSession.js`

**Interfaces:**
- Consumes: `pushPoint`, `cpuPoint`, `memPoint`, `netPoint`, `loadSeries` (Task 3).
- Produces:
  - `getToken()`, `apiGet(path)`, `apiPost(path, body)`, `openStream(handlers)` from `api.js`
  - `useSession()` from `useSession.js`, returning
    `{ status, error, profile, facts, interval, lastSeen, snapshot, slow, series: { cpu, mem, net, load }, activity, refresh, refreshing }`

These are `.js`, not `.ts`, because they touch `location`, `sessionStorage`, `fetch` and `EventSource` — all absent from the `es6` lib tsc compiles with.

- [ ] **Step 1: Write the API client**

Create `webui/src/api.js`:

```js
// The token arrives once on the opening URL as ?t=… . We stash it in
// sessionStorage and strip it from the address bar so it does not sit in
// browser history, then send it as a header on every call.
const KEY = 'sftp-manage-server-token';

export function getToken() {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    sessionStorage.setItem(KEY, fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY) || '';
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-sftp-token': getToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

export const apiGet = path => request('GET', path);
export const apiPost = (path, body) => request('POST', path, body || {});

// EventSource cannot send headers, so the stream carries the token in the query
// string. Returns a close function.
export function openStream(handlers) {
  const source = new EventSource(`/api/stream?t=${encodeURIComponent(getToken())}`);
  Object.keys(handlers).forEach(name => {
    if (name === 'onError') {
      source.onerror = handlers.onError;
      return;
    }
    source.addEventListener(name, e => handlers[name](JSON.parse(e.data)));
  });
  return () => source.close();
}
```

- [ ] **Step 2: Write the session hook**

Create `webui/src/useSession.js`:

```js
import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPost, openStream } from './api';
import { pushPoint, cpuPoint, memPoint, netPoint, loadSeries } from './series';

// 60 minutes at the 2s default cadence, matching the server's historyMinutes.
// Points are cheap; the cap only exists so a very long session cannot grow
// without bound.
const CAPACITY = 1800;

export function useSession() {
  const [state, setState] = useState({
    status: 'connecting',
    error: null,
    profile: null,
    facts: null,
    interval: 2000,
    lastSeen: null,
  });
  const [snapshot, setSnapshot] = useState(null);
  const [slow, setSlow] = useState(null);
  const [activity, setActivity] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [series, setSeries] = useState({ cpu: [], mem: [], net: [], load: [] });
  const [streamDown, setStreamDown] = useState(false);
  const buffers = useRef({ cpu: [], mem: [], net: [] });

  useEffect(() => {
    let closed = false;
    apiGet('/api/session')
      .then(s => {
        if (!closed) {
          setState(s);
        }
      })
      .catch(err => {
        if (!closed) {
          setState(s => ({ ...s, status: 'offline', error: err.message }));
        }
      });

    const close = openStream({
      state: next => setState(next),
      tick: ({ snapshot: snap, history }) => {
        setStreamDown(false);
        setSnapshot(snap);
        const b = buffers.current;
        const cpu = cpuPoint(snap);
        const mem = memPoint(snap);
        const net = netPoint(snap);
        if (cpu) {
          b.cpu = pushPoint(b.cpu, cpu, CAPACITY);
        }
        if (mem) {
          b.mem = pushPoint(b.mem, mem, CAPACITY);
        }
        if (net) {
          b.net = pushPoint(b.net, net, CAPACITY);
        }
        setSeries({ cpu: b.cpu, mem: b.mem, net: b.net, load: loadSeries(history) });
      },
      slow: next => setSlow(next),
      // EventSource reconnects on its own; this only drives the banner.
      onError: () => setStreamDown(true),
    });

    return () => {
      closed = true;
      close();
    };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await apiPost('/api/host/refresh');
      const entries = await apiGet('/api/activity');
      setActivity(entries.entries || []);
    } catch (err) {
      setState(s => ({ ...s, error: err.message }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { ...state, snapshot, slow, series, activity, refresh, refreshing, streamDown };
}
```

- [ ] **Step 3: Verify the build still succeeds**

Run: `npm run build:webui`
Expected: succeeds. Nothing imports these modules yet, so Vite may tree-shake them — that is fine; the point is that they parse.

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` — no output. (These are `.js`; tsc must not be looking at them. If it is, `allowJs` got turned on somewhere and that is a defect.)

- [ ] **Step 4: Commit**

```bash
git add webui/src/api.js webui/src/useSession.js
git commit -m "$(cat <<'EOF'
feat: add the server manager UI api client and session hook

.js rather than .ts because these touch location, sessionStorage, fetch
and EventSource, none of which exist in the es6 lib tsc compiles with.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 5: Dev mock server

Built now, before any visual work, because it is what makes the rest of this milestone verifiable without a running VS Code and a real Linux host. It serves the built app and synthesises a plausible tick stream.

**Files:**
- Create: `webui/dev/mock-server.js`
- Modify: `package.json` (one script)

**Interfaces:**
- Consumes: the `media/webui` build output.
- Produces: `npm run dev:webui` serving `http://127.0.0.1:5199/?t=dev`.

- [ ] **Step 1: Write the mock server**

Create `webui/dev/mock-server.js`:

```js
// Dev-only. Serves the built UI from media/webui with a synthetic API and SSE
// stream, so the interface can be exercised and screenshotted without VS Code
// or a real server. It deliberately mirrors the real payload shapes from
// src/modules/monitor/types.ts, including the nulls.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'media', 'webui');
const PORT = Number(process.env.PORT || 5199);
const CORES = 4;
let tick = 0;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const PROFILE = {
  id: 'devprofile000001',
  name: 'kewlab-cloudways-en248',
  host: '168.144.38.186',
  port: 22,
  username: 'master_swkqjgcbuc',
  protocol: 'sftp',
  remotePath: '/home/master/applications',
  workspace: '/dev/workspace',
  hasVpn: false,
  hasDatabase: true,
};

const FACTS = {
  hostname: '1624335.cloudwaysapps.com',
  prettyName: 'Debian GNU/Linux 12 (bookworm)',
  distroId: 'debian',
  cpuModel: 'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz',
  arch: 'x86_64',
  cores: CORES,
  pageSize: 4096,
  serverEpochMs: Date.now(),
  linux: true,
};

function wave(i, amp, base) {
  return base + Math.sin((tick + i * 7) / 6) * amp + Math.random() * 3;
}

function snapshot() {
  tick++;
  // The very first tick has a null cpu and null rates, exactly like the real
  // collector. Rendering must survive it.
  const first = tick === 1;
  return {
    at: Date.now(),
    cpu: first
      ? null
      : {
          total: Math.max(0, wave(0, 12, 20)),
          cores: Array.from({ length: CORES }, (_, i) => Math.max(0, wave(i, 20, 25))),
          breakdown: { user: 12, system: 6, nice: 0, iowait: 2, steal: 0.4 },
        },
    mem: {
      total: 16_769_552_384,
      used: 5_192_486_912,
      cached: 8_336_318_464,
      free: 3_240_747_008,
      usedPct: 30.96,
      cachedPct: 49.7,
      freePct: 19.3,
      swapTotal: 2_147_483_648,
      swapUsed: 104_857_600,
      swapPct: 4.9,
    },
    load: { one: 0.83, five: 0.5, fifteen: 0.3 },
    uptimeSec: 2040 + tick * 2,
    net: [
      {
        name: 'eth0',
        rxBps: first ? null : Math.max(0, wave(1, 40_000, 60_000)),
        txBps: first ? null : Math.max(0, wave(2, 90_000, 120_000)),
        rxTotal: 79_500_000,
        txTotal: 72_800_000,
        address: '168.144.38.186',
      },
      { name: 'lo', rxBps: first ? null : 100, txBps: first ? null : 100, rxTotal: 1, txTotal: 1 },
    ],
    disks: [
      {
        name: 'vda1',
        readBps: first ? null : 120_000,
        writeBps: first ? null : 340_000,
        readIops: first ? null : 12,
        writeIops: first ? null : 30,
        readLatencyMs: first ? null : 0.4,
        writeLatencyMs: first ? null : 1.2,
        readTotal: 1,
        writeTotal: 2,
      },
    ],
    procs: [
      { pid: 1, startTime: 1, comm: 'node', cpuPct: 141, rssBytes: 700_000_000, threads: 12, user: 'master' },
      { pid: 2, startTime: 2, comm: 'mysqld', cpuPct: 8.4, rssBytes: 1_200_000_000, threads: 40, user: 'mysql' },
      { pid: 3, startTime: 3, comm: 'php-fpm', cpuPct: 3.5, rssBytes: 220_000_000, threads: 1, user: 'www-data' },
      { pid: 4, startTime: 4, comm: 'nginx', cpuPct: null, rssBytes: 30_000_000, threads: 2, user: 'www-data' },
    ],
  };
}

const SLOW = {
  mounts: [
    { device: '/dev/vda1', deviceName: 'vda1', fstype: 'ext4', mount: '/', totalBytes: 252_000_000_000, usedBytes: 12_200_000_000 },
    { device: '/dev/vdb', deviceName: 'vdb', fstype: 'ext4', mount: '/var/log', totalBytes: 340_000_000, usedBytes: 307_600_000 },
  ],
  psRows: [],
  addrs: [{ name: 'eth0', address: '168.144.38.186' }],
};

function state() {
  return {
    id: PROFILE.id,
    profile: PROFILE,
    status: 'online',
    error: null,
    facts: FACTS,
    interval: 2000,
    lastSeen: Date.now(),
  };
}

http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/api/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...state(), capabilities: { services: false, webserver: false, logs: false, terminal: false, database: false } }));
      return;
    }
    if (url === '/api/host') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state()));
      return;
    }
    if (url === '/api/activity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entries: [{ at: Date.now(), label: 'restart nginx', command: 'systemctl restart nginx', code: 0, ms: 412, error: null }] }));
      return;
    }
    if (url === '/api/host/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('state', state());
      const history = [];
      const timer = setInterval(() => {
        const snap = snapshot();
        history.push({ at: snap.at, one: snap.load.one, five: snap.load.five, fifteen: snap.load.fifteen });
        send('tick', { snapshot: snap, history: history.slice(-1800) });
      }, 1000);
      const slowTimer = setInterval(() => send('slow', SLOW), 5000);
      send('slow', SLOW);
      req.on('close', () => {
        clearInterval(timer);
        clearInterval(slowTimer);
      });
      return;
    }

    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mock UI server on http://127.0.0.1:${PORT}/?t=dev`);
  });
```

- [ ] **Step 2: Add the script**

In `package.json` `scripts`:

```jsonc
"dev:webui": "node webui/dev/mock-server.js"
```

- [ ] **Step 3: Verify it serves**

Run: `npm run build:webui && (node webui/dev/mock-server.js &) && sleep 2 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5199/ && curl -s -H 'x-sftp-token: dev' http://127.0.0.1:5199/api/session | head -c 200; pkill -f mock-server.js`

Expected: `200`, then a JSON session payload naming the mock profile.

- [ ] **Step 4: Commit**

```bash
git add webui/dev/mock-server.js package.json
git commit -m "$(cat <<'EOF'
build: add a dev mock server for the server manager UI

Serves the built UI with a synthetic SSE stream that mirrors the real
payload shapes, including the first-tick nulls, so the interface can be
exercised without VS Code or a live host.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 6: Theme and UI primitives

**Files:**
- Create: `webui/src/styles.css`, `webui/src/components/ui.jsx`

Port from `/opt/homebrew/var/www/Local/Server-manager/client/src/styles.css` and `components/ui.jsx`. **Read both before writing.**

**Interfaces:**
- Produces: `Card`, `Stat`, `Badge`, `Empty`, `Section` from `ui.jsx`.

Required shapes, because later tasks call them:
- `<Card title sub actions className>{children}</Card>`
- `<Stat label value unit sub pct tone />` — renders the headline number, an optional unit, an optional sub-line, and a progress bar when `pct` is a number. `pct` of `null` renders no bar.
- `<Badge tone>{children}</Badge>` — tones `ok` (green), `warn` (amber), `bad` (red), `''` (neutral).
- `<Empty title>{children}</Empty>`
- `<Section title>{children}</Section>` — a labelled block for the sidebar.

- [ ] **Step 1: Port the stylesheet**

Take the reference `styles.css` as the base. Keep its palette, spacing and card treatment. Add:
- a `.sidebar` column, fixed 240px, with `.navitem` and `.navitem.active`
- `.navitem.disabled` — reduced opacity, `cursor: default`, and a small "soon" pill
- `.statgrid` — a responsive grid of stat cards
- `.chartgrid` — a two-column grid collapsing to one below 1100px

The whole app must work in a plain browser with no VS Code theme variables — the reference stylesheet already assumes that, so do **not** introduce `var(--vscode-*)` anywhere.

- [ ] **Step 2: Port the primitives**

Port the reference `ui.jsx`, dropping `Modal`, `Field`, `ToastProvider` and `useToast` — nothing in this milestone uses them, and they belong with the Services work that will. Add `Section`.

- [ ] **Step 3: Verify the build**

Run: `npm run build:webui` — succeeds.

- [ ] **Step 4: Commit**

```bash
git add webui/src/styles.css webui/src/components/ui.jsx
git commit -m "$(cat <<'EOF'
feat: add the server manager UI theme and primitives

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 7: Charts

**Files:**
- Create: `webui/src/components/Charts.jsx`

Port from the reference `components/Charts.jsx`. **Read it first.**

**Interfaces:**
- Produces:
  - `SERIES` — the fixed categorical colour array, assigned by slot and never cycled
  - `<AreaSeries data series unit format height />`
  - `<LineSeries data series unit format height />`

  where `series` is `[{ key, label, color? }]` and `data` is `SeriesPoint[]`.

Requirements beyond a straight port:
- The X axis is a time axis over `at` (server epoch ms), formatted `HH:MM`.
- **A `null` value must leave a gap in the line, not drop to zero.** Recharts does this with `connectNulls={false}`; verify it in the mock server's first-tick data, which is exactly this case.
- An empty `data` array renders an empty chart frame with an axis, not a crash and not a blank box.

- [ ] **Step 1: Port and verify the build**

Run: `npm run build:webui` — succeeds, and the output shows a separate `charts-*.js` chunk (from the `manualChunks` config in Task 1).

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/Charts.jsx
git commit -m "$(cat <<'EOF'
feat: add chart primitives for the server manager UI

Nulls leave a gap rather than dropping to zero — a null rate means the
delta was not computable, not that the device went idle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 8: The Overview tab and the app shell

The visual payload of the milestone. This is one task rather than two because the shell is not meaningfully reviewable without a tab to render inside it.

**Files:**
- Create: `webui/src/components/Overview.jsx`, `webui/src/pages/Dashboard.jsx`, `webui/src/pages/Activity.jsx`, `webui/src/pages/Settings.jsx`, `webui/src/App.jsx`
- Modify: `webui/src/main.jsx` (mount `App` instead of the placeholder)

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, 6, 7.

**The shell (`App.jsx`):**

```
┌────────────────────┬──────────────────────────────────────────────────┐
│ Server Manager     │  <profile.name>            ● online   [Refresh]  │
│ agentless · SSH    │  user@host:port · prettyName · cpuModel          │
│                    │                                                  │
│  Dashboard         │  Overview | Services | Web server | Logs | Term  │
│  Activity          │  ────────                                        │
│  Database   (soon) │                                                  │
│  Servers & settings│  … the active page …                             │
│                    │                                                  │
│  SERVERS           │                                                  │
│  ● <profile.name>  │                                                  │
└────────────────────┴──────────────────────────────────────────────────┘
```

- The SERVERS list holds exactly one entry — the launched profile. Do not fetch or invent others.
- The tab bar renders all five tabs. **Only Overview is enabled**; the rest are disabled with a "soon" pill, driven by the `capabilities` object from `/api/session`, so later milestones enable them by flipping a server flag rather than editing this file.
- Sidebar navigation switches the main pane between Dashboard, Overview-with-tabs, Activity, Database (disabled) and Servers & settings.
- The status badge maps status → tone: `online`→ok, `connecting`/`idle`→warn, `offline`/`unsupported`→bad. When `error` is set, it renders beside the badge.
- When `streamDown` is true, a banner reads **"VS Code disconnected — retrying"**.
- `Refresh now` calls `refresh()` and disables while `refreshing`.

**Overview.jsx**, in order:

1. **Stat row** — CPU `%` (`snapshot.cpu.total`), Memory `%` with `used of total` as the sub-line, Disk `%` from the largest mount in `slow.mounts` with `used of total`, Load 1m with `cores · N processes`, Uptime with `arch`.
2. **Range selector** — `RANGES` from Task 3, defaulting to 15 min, applied via `trimToWindow` to every chart.
3. **CPU usage** — area chart of `total`, plus a per-core line chart underneath. This is data the reference app never had; give the cores their own card titled "Per-core".
4. **Memory usage** — area chart of `usedPct`, with `cachedPct` as a second series.
5. **Load average** — line chart, three series `one`/`five`/`fifteen`, from the server's own history.
6. **Network throughput** — line chart, `rx` and `tx`, formatted with `fmtRate`.
7. **Filesystems** — table over `slow.mounts`: mount, fstype, used, size, usage bar with `toneForPct`.
8. **Top processes** — table over `snapshot.procs` sorted by `cpuPct` descending, nulls last: command, user, CPU %, memory. `cpuPct` above 100 is not clamped.
9. **Disk I/O** — table over `snapshot.disks`: device, read/write throughput, IOPS, latency. Also data the reference app never had.
10. **Network interfaces** — a footer strip of `name ↓rxTotal ↑txTotal`, with the live rate on the right.

**Every one of these must survive `snapshot === null`, `snapshot.cpu === null`, `slow === null`, and null rate fields.** Render the `Empty` primitive or an em dash — never `NaN`, never a crash, never a zero standing in for unknown.

**Dashboard.jsx** — the host card: name, `user@host:port`, distro, kernel/arch, cores, uptime, the five headline stats, and buttons linking into each tab.

**Activity.jsx** — a table over `activity` (at, label, command, code, duration). Empty today; render `Empty` with "No privileged commands have run in this session."

**Settings.jsx** — the redacted profile as a definition list, plus a read-only list of the four `sftp.serverManager.*` settings and their current values from `/api/session`. State plainly on this page that history is in-memory only and does not survive a VS Code restart.

- [ ] **Step 1: Build the app and verify it renders against the mock**

Run: `npm run build:webui`, then start `npm run dev:webui` in the background, then open `http://127.0.0.1:5199/?t=dev`.

Verify by screenshot (see Task 9 for how): the sidebar, the header with a green badge, the five stat cards, four charts drawing, the filesystem table with a red bar on the 90%-full mount, and the process table showing `node` at 141%.

- [ ] **Step 2: Verify the first-tick case**

Restart the mock server and screenshot within the first second, before tick 2 arrives. Nothing may show `NaN`, `undefined`, `0 B/s` for an unknown rate, or a blank page.

- [ ] **Step 3: Commit**

```bash
git add webui/src/App.jsx webui/src/main.jsx webui/src/components/Overview.jsx webui/src/pages
git commit -m "$(cat <<'EOF'
feat: add the server manager dashboard shell and Overview tab

Per-core CPU, disk IOPS and latency are surfaced as their own cards —
data the reference implementation never collected. Tabs for later
milestones render disabled from the server's capability flags, so
enabling them is a server-side flag flip rather than a UI edit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

### Task 9: Verification, docs and release

**Files:**
- Modify: `README.md`, `package.json` + `package-lock.json` + `CHANGELOG.md` (version bump)

- [ ] **Step 1: Headless UI verification**

With `npm run build:webui` done and `npm run dev:webui` running, drive a browser to `http://127.0.0.1:5199/?t=dev` and capture screenshots of: the Overview tab, the Dashboard page, the Activity page, and the Settings page. Confirm against the checklist in Task 8 Step 1.

If browser automation is unavailable in your environment, say so plainly in your report rather than claiming visual verification you did not do — and fall back to asserting the built HTML/JS contains the expected mount points and that the mock server's stream is consumed without console errors.

- [ ] **Step 2: Full verification**

- `npx jest` — one known pre-existing failure only.
- `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^(src|webui)/'` — no output.
- `npm run build:webui` — succeeds.
- `npm run compile` — succeeds.
- `node -e "require('./package.json')"` — parses.
- Confirm `media/webui` is gitignored and `git status --porcelain` shows it absent.

- [ ] **Step 3: Confirm the VSIX ships the UI**

Run `npx vsce package --allow-star-activation`, then:

```bash
unzip -l vaibhav-sftp-plus-*.vsix | grep -c 'extension/media/webui'
```

Expected: a non-zero count. **If this is zero the `.vscodeignore` re-include is wrong** and the shipped extension would silently fall back to the bootstrap page — exactly the bug this step exists to catch.

- [ ] **Step 4: Update the README**

Replace the "The page currently shows live host facts and a 2-second metric stream…" sentence in the Manage Server section with a description of the real dashboard, and note that Services, Web server, Logs, Terminal and Database appear as disabled tabs pending later releases.

- [ ] **Step 5: Bump to 1.23.0 and add a CHANGELOG entry**

Bump `package.json` and `package-lock.json` to `1.23.0`, and add a CHANGELOG entry describing the dashboard.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: document the Manage Server dashboard; bump to 1.23.0

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KPYkK5bu1NvAjUifYnYzvP
EOF
)"
```

---

## Self-Review

**Spec coverage.** The spec's UI section specifies the sidebar (Dashboard, Activity, Database-disabled, Servers & settings), the SERVERS list holding only the launched profile, the five-tab bar, the Overview contents, and the `5 / 15 / 60 min` range selector replacing the reference app's `1h / 6h / 24h / 7d`. Tasks 6 and 8 cover all of it. The spec's build section (Vite → `media/webui`, `base: './'`, Recharts lazy chunk, `.vscodeignore`) is Task 1, with Task 9 Step 3 proving the packaging actually works. The spec's "Database tab rendered visibly disabled" is Task 8's capability-driven tab bar.

**Not in this milestone, by design:** Services, Web server, Logs, Terminal, the Database tab's contents, the VPN fixed port, and the deferred idle-server shutdown from milestone 1. All are named in the Global Constraints so an implementer cannot drift into them.

**Placeholder scan.** No TBDs. Tasks 6, 7 and 8 say "port from the reference file" rather than inlining ~800 lines of JSX — that is a deliberate exception to the no-placeholder rule, justified because the source files exist on disk at a stated path, are named per task, and the required export shapes and behavioural requirements are specified in full. Every deviation from a straight port is spelled out.

**Type consistency.** `SeriesPoint` (Task 3) is what `Charts.jsx` (Task 7) consumes and what `useSession` (Task 4) accumulates. `toneForPct` (Task 2) returns exactly the tones `Badge` and the usage bars accept (Task 6). `RANGES` (Task 3) drives the selector in Task 8. `openStream`'s handler names (`state`, `tick`, `slow`) match the server's SSE event names from milestone 1's `routes.ts`.

**One risk worth naming.** Tasks 6-8 have no automated tests — they are JSX, and this repo has no React test runner, which the Global Constraints deliberately keep out. Task 5's mock server plus screenshot verification in Tasks 8 and 9 is the substitute. It is weaker than a test suite, and a regression in a renderer would not be caught by `npx jest`. The pure logic beneath them — formatting, series derivation — is fully tested, which is where the arithmetic bugs would otherwise hide.
