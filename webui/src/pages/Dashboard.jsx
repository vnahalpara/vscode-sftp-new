import React from 'react';
import { Card } from '../components/ui.jsx';
import { StatRow } from '../components/Overview.jsx';
import { fmtUptime } from '../format';

// Mirrors the tab bar in App.jsx. Kept as a separate literal here (rather
// than exported/shared) because App.jsx is the source of truth for which
// tabs exist; this list only needs to stay in sync well enough to produce a
// working set of buttons, and duplicating five short pairs is cheaper than a
// cross-file import cycle for something this small.
const TABS = [
  ['overview', 'Overview'],
  ['services', 'Services'],
  ['web', 'Web server'],
  ['logs', 'Logs'],
  ['terminal', 'Terminal'],
];

/**
 * The host card: identity, distro/arch/cores/uptime, the five headline
 * stats, and buttons that jump into each tab (only Overview is enabled,
 * driven by `capabilities` from `/api/session` — same rule as the tab bar).
 *
 * Note: `HostFacts` (src/modules/monitor/types.ts) has no kernel-version
 * field, only `prettyName` (distro) and `arch` — there is nothing to put in
 * a "kernel" slot, so it is omitted rather than invented. See task-8-report.
 */
export default function Dashboard({ profile, facts, snapshot, slow, capabilities, onOpenTab }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>A summary of the connected host.</p>
        </div>
      </div>

      <Card>
        <div className="row" style={{ marginBottom: 4 }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>{profile ? profile.name : '—'}</h3>
            <div className="muted mono" style={{ fontSize: 12 }}>
              {profile ? `${profile.username}@${profile.host}:${profile.port}` : '—'}
            </div>
          </div>
        </div>
        <div className="row muted" style={{ fontSize: 12.5, gap: 16, margin: '10px 0 16px', flexWrap: 'wrap' }}>
          <span>{(facts && facts.prettyName) || '—'}</span>
          <span>{(facts && facts.arch) || '—'}</span>
          <span>{facts && facts.cores != null ? `${facts.cores} cores` : '—'}</span>
          <span>up {fmtUptime(snapshot ? snapshot.uptimeSec : null)}</span>
        </div>

        <StatRow snapshot={snapshot} slow={slow} facts={facts} />

        <div className="row" style={{ marginTop: 18, gap: 8, flexWrap: 'wrap' }}>
          {TABS.map(([key, label]) => {
            const capKey = key === 'web' ? 'webserver' : key;
            const enabled = key === 'overview' || Boolean(capabilities && capabilities[capKey]);
            return (
              <button
                key={key}
                className="btn sm"
                disabled={!enabled}
                onClick={() => enabled && onOpenTab && onOpenTab(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Card>
    </>
  );
}
