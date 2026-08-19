import React, { useEffect, useState } from 'react';
import { useSession } from './useSession';
import { Badge, Section } from './components/ui.jsx';
import Overview from './components/Overview.jsx';
import Services from './components/Services.jsx';
import WebServer from './components/WebServer.jsx';
import Terminal from './components/Terminal.jsx';
import Logs from './components/Logs.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';

// Overview is always on; the rest come from the `capabilities` object
// `/api/session` returns — see routes.ts's CAPABILITIES const for which are
// live (services, webserver, terminal and logs are; database is not yet
// implemented). Reading that object here, rather than hardcoding which tabs
// are disabled, is what lets a later milestone turn one on with a server-side
// flag flip instead of an edit to this file.
const TABS = [
  ['overview', 'Overview', null],
  ['services', 'Services', 'services'],
  ['web', 'Web server', 'webserver'],
  ['logs', 'Logs', 'logs'],
  ['terminal', 'Terminal', 'terminal'],
];

// Terminal and Logs both hold a live server-side connection (an SSH shell, a
// `tail -F`/journalctl follow) that switching tabs must not kill -- see the
// "terminal tab is reset" bug this was built to fix. Overview/Services/Web
// server hold no connection and re-fetch cheaply, so they stay mount-on-
// demand: only these two get the render-once-then-hide-with-CSS treatment
// in ServerTabs below.
const PERSISTENT_TABS = new Set(['terminal', 'logs']);

const STATUS_TONE = { online: 'ok', connecting: 'warn', idle: 'warn', offline: 'bad', unsupported: 'bad' };
const STATUS_LABEL = {
  online: 'Online',
  connecting: 'Connecting…',
  idle: 'Idle',
  offline: 'Offline',
  unsupported: 'Unsupported',
};

function dotColor(tone) {
  if (tone === 'bad') return 'var(--critical)';
  if (tone === 'warn') return 'var(--warning)';
  if (tone === 'ok') return 'var(--good)';
  return 'var(--text-muted)';
}

// One row, usable both in the sidebar (vertical stack, via Section) and in
// the tab bar (horizontal row) — sharing this is what lets the disabled tab
// bar entries and the disabled Database sidebar entry both pick up the
// `.navitem .soon` pill CSS that Task 6 shipped with no consumer yet.
function NavItem({ label, active, disabled, onClick, dot }) {
  return (
    <div
      className={`navitem${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onClick={disabled ? undefined : onClick}
    >
      {dot && (
        <span
          style={{ width: 7, height: 7, borderRadius: '50%', flex: '0 0 7px', background: dot }}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {disabled && <span className="soon">Soon</span>}
    </div>
  );
}

function Sidebar({ profile, statusTone, page, onNavigate, capabilities }) {
  const dbEnabled = Boolean(capabilities && capabilities.database);
  return (
    <aside className="sidebar">
      <div className="brand">
        Server Manager
        <small>agentless · SSH</small>
      </div>
      <Section>
        <NavItem label="Dashboard" active={page === 'dashboard'} onClick={() => onNavigate('dashboard')} />
        <NavItem label="Activity" active={page === 'activity'} onClick={() => onNavigate('activity')} />
        <NavItem label="Database" disabled={!dbEnabled} onClick={() => onNavigate('database')} />
        <NavItem label="Servers & settings" active={page === 'settings'} onClick={() => onNavigate('settings')} />
      </Section>
      <Section title="Servers">
        {profile && (
          <NavItem
            label={profile.name}
            active={page === 'overview'}
            onClick={() => onNavigate('overview')}
            dot={dotColor(statusTone)}
          />
        )}
      </Section>
    </aside>
  );
}

// The tab bar plus whichever tab is active. Lives as its own component
// (rather than inline in App's `content` branch) so its `opened` state
// resets for free the moment the user navigates to Dashboard/Activity/
// Settings and this whole subtree unmounts — see the PERSISTENT_TABS
// comment above: that unmount is what guarantees a persistent tab is not an
// immortal one, per the "no leaked sockets" requirement.
function ServerTabs({ page, profile, snapshot, slow, series, facts, capabilities, onNavigate }) {
  // 'overview', 'services' and 'web' (plus 'database', which is unreachable
  // while disabled) land here too: any other/unrecognised tab key falls
  // back to Overview — the nav item itself is still enabled/disabled
  // correctly from `capabilities`.
  const tabPage = TABS.some(([key]) => key === page) ? page : 'overview';

  // Which persistent tabs (Terminal, Logs) have ever been opened this
  // mount. Once a key is added it is never removed — that is what keeps
  // the tab's live connection running while some OTHER tab is active; see
  // the render below, which keeps every opened persistent tab in the tree
  // and merely hides the inactive ones with `display: none` instead of
  // switching between them with if/else the way the non-persistent tabs
  // still do.
  const [opened, setOpened] = useState(() => (PERSISTENT_TABS.has(tabPage) ? new Set([tabPage]) : new Set()));
  useEffect(() => {
    if (!PERSISTENT_TABS.has(tabPage)) {
      return;
    }
    setOpened(prev => (prev.has(tabPage) ? prev : new Set(prev).add(tabPage)));
  }, [tabPage]);

  return (
    <>
      <div className="row" style={{ gap: 2, marginBottom: 18, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(([key, label, capKey]) => {
          const enabled = key === 'overview' || Boolean(capabilities && capabilities[capKey]);
          return (
            <NavItem
              key={key}
              label={label}
              active={key === tabPage}
              disabled={!enabled}
              onClick={() => onNavigate(key)}
            />
          );
        })}
      </div>
      {tabPage === 'services' && <Services />}
      {tabPage === 'web' && <WebServer />}
      {tabPage === 'overview' && <Overview snapshot={snapshot} slow={slow} series={series} facts={facts} />}
      {/* Terminal and Logs: mounted once, on first visit, then kept mounted
          and merely hidden — never re-mounted on every tab switch — so the
          shell session / log follow they own survives switching away and
          back. See Terminal.jsx's own comment on why xterm additionally
          needs an explicit re-fit when it becomes visible again. */}
      {opened.has('terminal') && (
        <div style={{ display: tabPage === 'terminal' ? 'block' : 'none' }}>
          <Terminal profile={profile} active={tabPage === 'terminal'} />
        </div>
      )}
      {opened.has('logs') && (
        <div style={{ display: tabPage === 'logs' ? 'block' : 'none' }}>
          <Logs />
        </div>
      )}
    </>
  );
}

function Header({ profile, facts, status, error, refreshing, onRefresh }) {
  const tone = STATUS_TONE[status] || '';
  const label = STATUS_LABEL[status] || status || 'Unknown';
  return (
    <div className="page-head">
      <div>
        <h1>{profile ? profile.name : 'Server Manager'}</h1>
        <p>
          {profile ? `${profile.username}@${profile.host}:${profile.port}` : '—'}
          {facts && facts.prettyName ? ` · ${facts.prettyName}` : ''}
          {facts && facts.cpuModel ? ` · ${facts.cpuModel}` : ''}
        </p>
      </div>
      <div className="row">
        <Badge tone={tone}>{label}</Badge>
        {error && (
          <span className="muted mono" style={{ fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {error}
          </span>
        )}
        <button className="btn sm" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const session = useSession();
  const {
    status,
    error,
    profile,
    facts,
    snapshot,
    slow,
    series,
    activity,
    refresh,
    refreshing,
    streamDown,
    streamClosed,
    capabilities,
  } = session;
  // Overview-with-tabs is the default landing page — with a single connected
  // host there is nothing more useful to show first, and it is what Task 8's
  // screenshot checklist expects to see without any navigation.
  const [page, setPage] = useState('overview');

  let content;
  if (page === 'dashboard') {
    content = (
      <Dashboard
        profile={profile}
        facts={facts}
        snapshot={snapshot}
        slow={slow}
        capabilities={capabilities}
        onOpenTab={() => setPage('overview')}
      />
    );
  } else if (page === 'activity') {
    content = <Activity activity={activity} />;
  } else if (page === 'settings') {
    content = <Settings profile={profile} session={session} />;
  } else {
    // 'overview', 'services', 'web', 'logs' and 'terminal' (plus 'database',
    // which is unreachable while disabled) land here — see ServerTabs for
    // the tab bar and the persistent-mount handling Terminal/Logs need.
    content = (
      <ServerTabs
        page={page}
        profile={profile}
        snapshot={snapshot}
        slow={slow}
        series={series}
        facts={facts}
        capabilities={capabilities}
        onNavigate={setPage}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar profile={profile} statusTone={STATUS_TONE[status] || ''} page={page} onNavigate={setPage} capabilities={capabilities} />
      <main className="main">
        <Header profile={profile} facts={facts} status={status} error={error} refreshing={refreshing} onRefresh={refresh} />
        {streamDown && (
          <div
            className="card mono"
            style={{ borderColor: 'rgba(208,59,59,0.45)', color: 'var(--serious)', marginBottom: 16, fontSize: 12.5 }}
          >
            {streamClosed
              ? 'VS Code disconnected — reload the page to reconnect'
              : 'VS Code disconnected — retrying'}
          </div>
        )}
        {content}
      </main>
    </div>
  );
}
