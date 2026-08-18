import React from 'react';
import { Card } from '../components/ui.jsx';

// The four `sftp.serverManager.*` settings (package.json's configuration
// section). `/api/session` (src/modules/serverManager/routes.ts) only ever
// echoes back `interval` from ManagedSession.state() — `browser`,
// `slowInterval` and `historyMinutes` are read server-side (index.ts's
// settings()) but never reported to the client. Rather than invent values
// for the other three, they render a dash with an explicit note; see
// task-8-report for why this list can't be fully populated from the API as
// literally described.
const SETTINGS_FIELDS = [
  ['interval', 'sftp.serverManager.interval', 'interval'],
  ['browser', 'sftp.serverManager.browser', null],
  ['slowInterval', 'sftp.serverManager.slowInterval', null],
  ['historyMinutes', 'sftp.serverManager.historyMinutes', null],
];

function Row({ label, value }) {
  return (
    <div className="row" style={{ padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span className="muted" style={{ width: 260, flex: '0 0 260px' }}>
        {label}
      </span>
      <span className="mono">{value}</span>
    </div>
  );
}

/** The redacted profile as a definition list, plus a read-only settings list. */
export default function Settings({ profile, session }) {
  const interval = session ? session.interval : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Servers &amp; settings</h1>
          <p>Read-only. Change these under File &gt; Preferences &gt; Settings in VS Code.</p>
        </div>
      </div>

      <Card title="Profile" sub="Redacted — no secrets are exposed to this page." style={{ marginBottom: 14 }}>
        {profile ? (
          <div>
            <Row label="Name" value={profile.name} />
            <Row label="Host" value={`${profile.username}@${profile.host}:${profile.port}`} />
            <Row label="Protocol" value={profile.protocol} />
            <Row label="Remote path" value={profile.remotePath} />
            <Row label="Workspace" value={profile.workspace} />
            <Row label="VPN configured" value={profile.hasVpn ? 'Yes' : 'No'} />
            <Row label="Database configured" value={profile.hasDatabase ? 'Yes' : 'No'} />
          </div>
        ) : (
          <div className="muted">No profile loaded yet.</div>
        )}
      </Card>

      <Card title="Server manager settings" sub="Current values, where /api/session reports them." style={{ marginBottom: 14 }}>
        {SETTINGS_FIELDS.map(([key, label, sourceKey]) => (
          <Row
            key={key}
            label={label}
            value={sourceKey === 'interval' && typeof interval === 'number' ? `${interval} ms` : '—'}
          />
        ))}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Only <span className="mono">interval</span> is exposed today by <span className="mono">/api/session</span>.
          The other three are configured in VS Code but are not reported back to this page.
        </div>
      </Card>

      <Card title="History">
        <div className="muted" style={{ fontSize: 12.5 }}>
          Metric history and the activity log above live in memory only — they do not survive a VS Code restart.
        </div>
      </Card>
    </>
  );
}
