import React, { useState } from 'react';
import { fmtBytes, fmtRate, fmtUptime, fmtPct, pct, toneForPct } from '../format';
import { RANGES, trimToWindow } from '../series';
import { Card, Stat, Empty } from './ui.jsx';
import { AreaSeries, LineSeries, SERIES } from './Charts.jsx';

const DASH = '—';

// format.ts has no formatter for a bare load average or a device IOPS/latency
// count — those are not bytes, rates, percents or durations, so fmtBytes/
// fmtRate/fmtPct/fmtUptime all mis-shape them. These three are the local
// equivalent, same never-NaN contract: a non-finite/non-number input renders
// the dash, never 0 or NaN.
function fmtLoad(n) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : DASH;
}
function fmtNum(n, digits = 0) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : DASH;
}
function fmtMs(n) {
  return typeof n === 'number' && isFinite(n) ? `${n.toFixed(1)} ms` : DASH;
}

// Matches Stat's own toneColor() in ui.jsx (not exported from there), reused
// here for the filesystem usage bars so a 'bad' tone always paints the same
// red whether it is a stat card or a table row.
function toneColor(tone) {
  if (tone === 'bad') return 'var(--critical)';
  if (tone === 'warn') return 'var(--warning)';
  if (tone === 'ok') return 'var(--good)';
  return 'var(--series-1)';
}

// A process with cpuPct === null (not sampled, not "0% busy") always sorts
// after every real number, regardless of how small.
function byCpuDesc(a, b) {
  if (a.cpuPct == null && b.cpuPct == null) {
    return 0;
  }
  if (a.cpuPct == null) {
    return 1;
  }
  if (b.cpuPct == null) {
    return -1;
  }
  return b.cpuPct - a.cpuPct;
}

// The five headline stats, shared between the Overview stat row and the
// Dashboard page's summary card so the null-safety logic exists exactly once.
// Every field defaults to null/dash rather than 0 — see the brief's "never a
// 0 standing in for unknown" rule, which the reference app's `pct ?? 0`
// pattern violated and this deliberately does not repeat.
export function headlineStats(snapshot, slow, facts) {
  const cpuTotal = snapshot && snapshot.cpu ? snapshot.cpu.total : null;
  const mem = snapshot ? snapshot.mem : null;
  const memPct = mem ? mem.usedPct : null;

  const mounts = (slow && slow.mounts) || [];
  // "Largest" = greatest capacity, not greatest usage — the primary disk, not
  // whichever mount happens to be fullest.
  const biggest = mounts.length
    ? mounts.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a))
    : null;
  const diskPct = biggest ? pct(biggest.usedBytes, biggest.totalBytes) : null;

  const load1 = snapshot && snapshot.load ? snapshot.load.one : null;
  const cores = facts ? facts.cores : null;
  const procCount = snapshot && snapshot.procs ? snapshot.procs.length : null;

  return [
    { key: 'cpu', label: 'CPU', value: fmtPct(cpuTotal), pct: cpuTotal, tone: toneForPct(cpuTotal) },
    {
      key: 'mem',
      label: 'Memory',
      value: fmtPct(memPct),
      pct: memPct,
      tone: toneForPct(memPct),
      sub: mem ? `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)}` : DASH,
    },
    {
      key: 'disk',
      label: 'Disk',
      value: fmtPct(diskPct),
      pct: diskPct,
      tone: toneForPct(diskPct),
      sub: biggest ? `${fmtBytes(biggest.usedBytes)} of ${fmtBytes(biggest.totalBytes)}` : DASH,
    },
    {
      key: 'load',
      label: 'Load (1m)',
      value: fmtLoad(load1),
      sub: snapshot ? `${cores != null ? cores : DASH} cores · ${procCount != null ? procCount : 0} processes` : DASH,
    },
    {
      key: 'uptime',
      label: 'Uptime',
      value: fmtUptime(snapshot ? snapshot.uptimeSec : null),
      sub: (facts && facts.arch) || DASH,
    },
  ];
}

/** The five stat cards. Shared by Overview (item 1) and Dashboard's summary. */
export function StatRow({ snapshot, slow, facts }) {
  const stats = headlineStats(snapshot, slow, facts);
  return (
    <div className="statgrid">
      {stats.map(s => (
        <Card key={s.key}>
          <Stat label={s.label} value={s.value} sub={s.sub} pct={s.pct != null ? s.pct : null} tone={s.tone} />
        </Card>
      ))}
    </div>
  );
}

/**
 * The Overview tab: stat row, range selector, four chart cards (CPU usage +
 * its own per-core card, memory, load, network), three tables (filesystems,
 * top processes, disk I/O) and a network-interfaces footer strip — in that
 * order, per the brief. `snapshot`, `slow` and every rate field inside them
 * may be null; every branch below has an explicit fallback, never a bare
 * property access that could render `undefined` or `NaN`.
 */
export default function Overview({ snapshot, slow, series, facts }) {
  const [rangeMinutes, setRangeMinutes] = useState(15);
  const now = Date.now();

  const cpuSeries = trimToWindow((series && series.cpu) || [], rangeMinutes, now);
  const memSeries = trimToWindow((series && series.mem) || [], rangeMinutes, now);
  const netSeries = trimToWindow((series && series.net) || [], rangeMinutes, now);
  const loadSeries = trimToWindow((series && series.load) || [], rangeMinutes, now);

  // Core count from HostFacts (stable, known at connect) falling back to
  // whatever the latest snapshot reports, so the per-core chart still knows
  // how many series to draw even before facts have loaded.
  const coreCount = (facts && facts.cores) || (snapshot && snapshot.cpu && snapshot.cpu.cores.length) || 0;
  const coreSeriesDef = Array.from({ length: coreCount }, (_, i) => ({
    key: `core${i}`,
    label: `Core ${i}`,
    color: SERIES[i % SERIES.length],
  }));

  const mounts = (slow && slow.mounts) || [];
  const procs = snapshot && snapshot.procs ? [...snapshot.procs].sort(byCpuDesc) : [];
  const disks = (snapshot && snapshot.disks) || [];
  const nets = (snapshot && snapshot.net) || [];

  return (
    <>
      <StatRow snapshot={snapshot} slow={slow} facts={facts} />

      <div className="row" style={{ margin: '14px 0' }}>
        <div className="tabs" style={{ border: 'none', margin: 0 }}>
          {RANGES.map(r => (
            <button
              key={r.minutes}
              className={rangeMinutes === r.minutes ? 'active' : ''}
              onClick={() => setRangeMinutes(r.minutes)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chartgrid" style={{ marginBottom: 14 }}>
        <Card title="CPU usage" sub="Percent of total capacity">
          <AreaSeries data={cpuSeries} unit="%" series={[{ key: 'total', label: 'Total' }]} />
        </Card>
        <Card title="Per-core" sub="Percent of one core, each">
          {coreSeriesDef.length ? (
            <LineSeries data={cpuSeries} unit="%" series={coreSeriesDef} />
          ) : (
            <Empty title="No core data yet">Waiting for the first sample.</Empty>
          )}
        </Card>
        <Card title="Memory usage" sub="Used vs. cached, percent of total">
          <AreaSeries
            data={memSeries}
            unit="%"
            series={[
              { key: 'usedPct', label: 'Used' },
              { key: 'cachedPct', label: 'Cached', color: SERIES[1] },
            ]}
          />
        </Card>
        <Card title="Load average" sub="1 / 5 / 15 minute means">
          <LineSeries
            data={loadSeries}
            format={fmtLoad}
            series={[
              { key: 'one', label: '1 min' },
              { key: 'five', label: '5 min' },
              { key: 'fifteen', label: '15 min' },
            ]}
          />
        </Card>
        <Card title="Network throughput" sub="Physical interfaces, combined">
          <LineSeries
            data={netSeries}
            format={fmtRate}
            series={[
              { key: 'rx', label: 'Rx' },
              { key: 'tx', label: 'Tx' },
            ]}
          />
        </Card>
      </div>

      <div className="grid two" style={{ marginBottom: 14 }}>
        <Card title="Filesystems">
          {mounts.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Mount</th>
                  <th>Type</th>
                  <th className="num">Used</th>
                  <th className="num">Size</th>
                  <th style={{ width: 120 }}>Usage</th>
                </tr>
              </thead>
              <tbody>
                {mounts.map(m => {
                  const p = pct(m.usedBytes, m.totalBytes);
                  const tone = toneForPct(p);
                  return (
                    <tr key={m.mount}>
                      <td className="mono">{m.mount}</td>
                      <td className="muted">{m.fstype}</td>
                      <td className="num">{fmtBytes(m.usedBytes)}</td>
                      <td className="num">{fmtBytes(m.totalBytes)}</td>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 34 }}>{fmtPct(p, 0)}</span>
                          <div className="meter" style={{ flex: 1, marginTop: 0 }}>
                            <div
                              style={{
                                width: `${p != null ? Math.min(100, Math.max(0, p)) : 0}%`,
                                background: toneColor(tone),
                              }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty title="No filesystem data yet">Waiting for the slow-lane sample.</Empty>
          )}
        </Card>

        <Card title="Top processes" sub="By CPU, at the last sample">
          {procs.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Command</th>
                  <th>User</th>
                  <th className="num">CPU %</th>
                  <th className="num">Memory</th>
                </tr>
              </thead>
              <tbody>
                {procs.map(p => (
                  <tr key={p.pid}>
                    <td className="mono">{p.comm}</td>
                    <td className="muted">{p.user || DASH}</td>
                    <td className="num">{fmtPct(p.cpuPct)}</td>
                    <td className="num">{fmtBytes(p.rssBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No process data yet">Waiting for the first sample.</Empty>
          )}
        </Card>

        <Card title="Disk I/O">
          {disks.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Device</th>
                  <th className="num">Read</th>
                  <th className="num">Write</th>
                  <th className="num">IOPS r/w</th>
                  <th className="num">Latency r/w</th>
                </tr>
              </thead>
              <tbody>
                {disks.map(d => (
                  <tr key={d.name}>
                    <td className="mono">{d.name}</td>
                    <td className="num">{fmtRate(d.readBps)}</td>
                    <td className="num">{fmtRate(d.writeBps)}</td>
                    <td className="num">
                      {fmtNum(d.readIops)} / {fmtNum(d.writeIops)}
                    </td>
                    <td className="num">
                      {fmtMs(d.readLatencyMs)} / {fmtMs(d.writeLatencyMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No disk I/O data yet">Waiting for the first sample.</Empty>
          )}
        </Card>
      </div>

      <Card title="Network interfaces">
        {nets.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {nets.map(n => (
              <div key={n.name} className="row" style={{ fontSize: 12.5 }}>
                <span className="mono">
                  {n.name} ↓{fmtBytes(n.rxTotal)} ↑{fmtBytes(n.txTotal)}
                </span>
                <div className="spacer" />
                <span className="mono muted">
                  ↓{fmtRate(n.rxBps)} ↑{fmtRate(n.txBps)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No network data yet">Waiting for the first sample.</Empty>
        )}
      </Card>
    </>
  );
}
