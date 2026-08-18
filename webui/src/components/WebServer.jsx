import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api.js';
import { Badge, Card, Empty } from './ui.jsx';

// The four systemctl actions the brief calls for. These run through the very
// same POST /api/services/:unit/:action route Services.jsx uses (routes.ts
// has no web-server-specific action endpoint — nginx/apache are just
// systemd units, identified by WebServerInfo.unit from GET /api/webserver),
// so a web server card's action buttons are functionally identical to a
// Services row's, just scoped to a single unit instead of a whole table.
const ACTIONS = ['reload', 'restart', 'stop', 'start'];

// The systemd unit name for a detected server. parseDetect (ops/webserver.ts)
// reports the bare binary name -- `nginx`, `apache2`, `httpd` -- because that
// is what `command -v` found, whereas the Services tab posts what `systemctl
// list-units` printed, which is always fully qualified (`nginx.service`).
// systemd accepts both, but the two tabs were producing two DIFFERENT argv
// shapes for the same action, so a narrow sudoers rule could only ever match
// one of them -- and the documented example is the qualified one. Qualifying
// here gives both tabs a single shape. An already-qualified name (anything
// carrying a suffix) is left exactly as it is.
function serviceUnit(server) {
  return server.unit.indexOf('.') === -1 ? `${server.unit}.service` : server.unit;
}

// Mirrors Services.jsx's stateTone: any 'active' state reads as 'ok'
// regardless of `sub` (parseDetect never reports a `sub`, only `active`, so
// this is simpler than Services' version), 'failed' stays its own 'bad'
// tone, and the transitional states get 'warn'.
function serverStateTone(active) {
  if (active === 'failed') {
    return 'bad';
  }
  if (active === 'active') {
    return 'ok';
  }
  if (active === 'activating' || active === 'deactivating') {
    return 'warn';
  }
  return '';
}

function kindLabel(kind) {
  return kind === 'apache' ? 'Apache' : 'nginx';
}

// Thresholds from the brief: green (ok) above 30 days, amber (warn) for
// 8-30 inclusive, red (bad) at 7 or fewer -- which also covers an already
// expired certificate (a negative day count). `daysLeft === null` means
// CertInfo could not compute an expiry (a parse failure -- see
// ops/webserver.ts's certResult) and must never be treated as 0 here; the
// caller is responsible for keeping the null case out of this function.
function certTone(daysLeft) {
  if (daysLeft > 30) {
    return 'ok';
  }
  if (daysLeft >= 8) {
    return 'warn';
  }
  return 'bad';
}

// null renders as an em dash, never as the number 0 -- that distinction
// ("not computable" vs. "expires today") is the whole point of daysLeft
// being nullable in CertInfo.
function fmtDaysLeft(daysLeft) {
  if (daysLeft == null) {
    return '—';
  }
  if (daysLeft < 0) {
    return `expired ${Math.abs(daysLeft)}d ago`;
  }
  return `${daysLeft}d left`;
}

function fmtExpiry(iso) {
  if (!iso) {
    return null;
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

// Every action -- including 'start' -- opens this before anything runs;
// ported verbatim (same shape, same debounce-on-submit guard) from
// Services.jsx's ConfirmDialog, since these commands run over SSH against
// the same live host.
function ConfirmDialog({ unit, action, onCancel, onConfirm }) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function handleConfirm() {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    onConfirm();
  }

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="card"
        style={{ maxWidth: 440, width: '90%' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Confirm action</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          Run <strong className="mono">systemctl {action}</strong> on{' '}
          <span className="mono">{unit}</span>? This runs on the live host over SSH.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={action === 'stop' ? 'btn danger' : 'btn primary'}
            onClick={handleConfirm}
            disabled={submitting}
            autoFocus
          >
            {submitting ? `${action}…` : `${action} ${unit}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// A read-only modal for a vhost's config file (GET /api/file?path=...). The
// server only allows reading a path it just handed back from a vhost
// listing (routes.ts's `allowedFiles`), so this is never a general file
// browser -- only ever opened with a path this tab already displayed.
function ConfigViewerDialog({ path, onClose }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    apiGet(`/api/file?path=${encodeURIComponent(path)}`)
      .then(res => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setContent((res && res.content) || '');
      })
      .catch(err => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setError(err.message);
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="card"
        style={{ maxWidth: 760, width: '92%', maxHeight: '80vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 className="mono" style={{ margin: 0, fontSize: 13.5, wordBreak: 'break-all' }}>
            {path}
          </h3>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        {loading && <div className="muted">Loading…</div>}
        {error && (
          <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
            {error}
          </span>
        )}
        {!loading && !error && <pre className="output" style={{ margin: 0 }}>{content}</pre>}
      </div>
    </div>
  );
}

// The inline result banner shared by a server's own action buttons and its
// Test config button -- never a toast, and nothing here times out or
// auto-dismisses on its own. A failed action's output is frequently the
// multi-line sudoHint; a failed Test config's output is a real `nginx -t` /
// `apachectl configtest` diagnostic, which the brief calls "the most useful
// thing on the page when something is broken" -- `pre.output` wraps rather
// than clips, so it never gets cut down to one unreadable line.
function ResultBanner({ label, result, onDismiss }) {
  if (!result) {
    return null;
  }
  if (result.pending) {
    return (
      <div className="muted" style={{ padding: '8px 10px', fontSize: 12.5, marginBottom: 10 }}>
        Running <span className="mono">{label}</span>…
      </div>
    );
  }
  return (
    <div style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.03)', marginBottom: 10, borderRadius: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: result.output ? 6 : 0 }}>
        <Badge tone={result.ok ? 'ok' : 'bad'}>
          {label} — {result.ok ? 'done' : 'failed'}
        </Badge>
        <button className="btn sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {result.output && <pre className="output" style={{ margin: 0 }}>{result.output}</pre>}
    </div>
  );
}

// Where a vhost's certificate stands relative to the vhosts/vhosts-response
// triple (`vhosts`, `certificates`, `skipped`) GET /api/webserver/:kind/vhosts
// returns. A vhost's `certificate` path can land in exactly one of three
// buckets -- successfully inspected (in `certificates`, possibly itself a
// parse failure with `daysLeft: null`), deliberately not attempted (in
// `skipped`), or -- defensively, should not happen -- neither.
function findCert(vhost, certificates, skipped) {
  if (!vhost.certificate) {
    return { state: 'none' };
  }
  const cert = certificates.find(c => c.path === vhost.certificate);
  if (cert) {
    return { state: cert.daysLeft == null ? 'error' : 'ok', cert };
  }
  if (skipped.indexOf(vhost.certificate) !== -1) {
    return { state: 'skipped', path: vhost.certificate };
  }
  return { state: 'unknown', path: vhost.certificate };
}

function CertCell({ vhost, certificates, skipped }) {
  const info = findCert(vhost, certificates, skipped);
  if (info.state === 'none') {
    return <span className="muted">No TLS</span>;
  }
  if (info.state === 'skipped') {
    return (
      <span className="muted" title={info.path}>
        Not inspected
      </span>
    );
  }
  if (info.state === 'unknown') {
    return (
      <span className="muted" title={info.path}>
        —
      </span>
    );
  }
  const { cert } = info;
  if (info.state === 'error') {
    return (
      <div>
        <Badge tone="bad">cert error</Badge>
        {cert.error && (
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }} title={cert.error}>
            {cert.error.split('\n')[0]}
          </div>
        )}
      </div>
    );
  }
  const expiry = fmtExpiry(cert.expires);
  return (
    <div>
      <Badge tone={certTone(cert.daysLeft)}>{fmtDaysLeft(cert.daysLeft)}</Badge>
      {expiry && (
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          expires {expiry}
        </div>
      )}
    </div>
  );
}

function VhostTable({ kind, state, onView }) {
  if (!state || state.loading) {
    return (
      <div className="muted" style={{ padding: '16px 0' }}>
        Loading virtual hosts…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="row">
        <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
          {state.error}
        </span>
      </div>
    );
  }
  const vhosts = state.vhosts || [];
  if (!vhosts.length) {
    return (
      <Empty title="No virtual hosts found">
        No {kindLabel(kind)} server blocks were found in the enabled configuration.
      </Empty>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Server name</th>
          <th>Listen</th>
          <th>Root / upstream</th>
          <th>TLS certificate</th>
          <th style={{ width: 70 }} />
        </tr>
      </thead>
      <tbody>
        {vhosts.map((v, i) => (
          <tr key={`${v.file}::${v.serverName}::${i}`}>
            <td className="mono">
              {v.serverName}
              {v.aliases && (
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {v.aliases}
                </div>
              )}
            </td>
            <td className="mono">{(v.listen || []).join(', ') || '—'}</td>
            <td
              className="mono"
              style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={v.root || v.proxyPass || ''}
            >
              {/* A vhost normally has either a document root or a proxy
                  upstream, never both -- production output confirms a vhost
                  with `root: null` and a set `proxyPass` is a normal reverse
                  proxy, not a broken parse. */}
              {v.root || v.proxyPass || '—'}
            </td>
            <td>
              <CertCell vhost={v} certificates={state.certificates || []} skipped={state.skipped || []} />
            </td>
            <td>
              <button className="btn sm" onClick={() => onView(v.file)}>
                View
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServerCard({
  server,
  busy,
  actionResult,
  onConfirm,
  onDismissAction,
  testing,
  testResult,
  onTest,
  onDismissTest,
  vhostState,
  onView,
}) {
  // Everything action-related -- the confirm dialog, the POST, the busy set,
  // the result banner -- names the same fully-qualified unit, so what the
  // dialog shows is what actually runs.
  const unit = serviceUnit(server);
  return (
    <Card
      title={`${kindLabel(server.kind)} — ${server.unit}`}
      sub={server.version}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Badge tone={serverStateTone(server.active)}>{server.active}</Badge>
          <span className="muted" style={{ fontSize: 12 }}>
            {server.enabled}
          </span>
        </div>
      }
    >
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {ACTIONS.map(action => (
          <button
            key={action}
            className={`btn sm ${action === 'stop' ? 'danger' : ''}`}
            disabled={busy}
            onClick={() => onConfirm({ unit, action })}
          >
            {action}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn sm" disabled={testing} onClick={() => onTest(server.kind)}>
          {testing ? 'Testing…' : 'Test config'}
        </button>
      </div>

      {actionResult && (
        <ResultBanner
          label={`systemctl ${actionResult.action} ${unit}`}
          result={actionResult}
          onDismiss={() => onDismissAction(unit)}
        />
      )}
      {testResult && (
        <ResultBanner
          label={`${kindLabel(server.kind)} config test`}
          result={testResult}
          onDismiss={() => onDismissTest(server.kind)}
        />
      )}

      <VhostTable kind={server.kind} state={vhostState[server.kind]} onView={onView} />
    </Card>
  );
}

export default function WebServer() {
  const [servers, setServers] = useState(null); // null until the first load resolves
  const [listening, setListening] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [vhostState, setVhostState] = useState({}); // kind -> { vhosts, certificates, skipped, loading, error }

  // One busy set / results map keyed by unit (mirrors Services.jsx), so an
  // nginx action in flight never disables apache2's own buttons and vice
  // versa.
  const [busyUnits, setBusyUnits] = useState(() => new Set());
  const [actionResults, setActionResults] = useState({});
  const [confirm, setConfirm] = useState(null); // { unit, action }

  // Test config gets its own independent busy set / results map, keyed by
  // kind rather than unit -- it is a separate, unconfirmed, read-only
  // request (POST /api/webserver/:kind/test never mutates anything, it just
  // runs `nginx -t`/`apachectl configtest`), so it must never be blocked by
  // -- or block -- an in-flight systemctl action on the same server.
  const [testBusy, setTestBusy] = useState(() => new Set());
  const [testResults, setTestResults] = useState({});

  const [viewing, setViewing] = useState(null); // a config file path, or null

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiGet('/api/webserver');
      if (!mountedRef.current) {
        return;
      }
      setServers((res && res.servers) || []);
      setListening((res && res.listening) || []);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setLoadError(err.message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const loadVhosts = useCallback(async kind => {
    setVhostState(prev => ({ ...prev, [kind]: { ...(prev[kind] || {}), loading: true, error: null } }));
    try {
      const res = await apiGet(`/api/webserver/${kind}/vhosts`);
      if (!mountedRef.current) {
        return;
      }
      setVhostState(prev => ({
        ...prev,
        [kind]: {
          vhosts: (res && res.vhosts) || [],
          certificates: (res && res.certificates) || [],
          skipped: (res && res.skipped) || [],
          loading: false,
          error: null,
        },
      }));
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setVhostState(prev => ({ ...prev, [kind]: { ...(prev[kind] || {}), loading: false, error: err.message } }));
    }
  }, []);

  // Fetches each detected kind's vhosts exactly once (a ref set, not
  // `vhostState` itself, gates this -- keying off `vhostState` would refire
  // this effect every time `loadVhosts` writes to it).
  const requestedKindsRef = useRef(new Set());
  useEffect(() => {
    (servers || []).forEach(s => {
      if (!requestedKindsRef.current.has(s.kind)) {
        requestedKindsRef.current.add(s.kind);
        loadVhosts(s.kind);
      }
    });
  }, [servers, loadVhosts]);

  async function runAction(unit, action) {
    setConfirm(null);
    setBusyUnits(prev => {
      const next = new Set(prev);
      next.add(unit);
      return next;
    });
    setActionResults(prev => ({ ...prev, [unit]: { pending: true, action } }));
    try {
      // Same route Services.jsx posts to; a 200 with { ok: false, output }
      // is a legitimate failed action, not a thrown error -- see routes.ts's
      // POST /api/services/:unit/:action handler.
      const res = await apiPost(`/api/services/${encodeURIComponent(unit)}/${action}`);
      if (!mountedRef.current) {
        return;
      }
      const ok = Boolean(res && res.ok);
      setActionResults(prev => ({ ...prev, [unit]: { ok, output: (res && res.output) || '', action } }));
      if (ok) {
        await loadServers();
      }
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setActionResults(prev => ({ ...prev, [unit]: { ok: false, output: err.message, action } }));
    } finally {
      if (mountedRef.current) {
        setBusyUnits(prev => {
          if (!prev.has(unit)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(unit);
          return next;
        });
      }
    }
  }

  function dismissAction(unit) {
    setActionResults(prev => {
      const next = { ...prev };
      delete next[unit];
      return next;
    });
  }

  async function runTest(kind) {
    setTestBusy(prev => {
      const next = new Set(prev);
      next.add(kind);
      return next;
    });
    setTestResults(prev => ({ ...prev, [kind]: { pending: true } }));
    try {
      const res = await apiPost(`/api/webserver/${kind}/test`);
      if (!mountedRef.current) {
        return;
      }
      const ok = Boolean(res && res.ok);
      setTestResults(prev => ({ ...prev, [kind]: { ok, output: (res && res.output) || '' } }));
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setTestResults(prev => ({ ...prev, [kind]: { ok: false, output: err.message } }));
    } finally {
      if (mountedRef.current) {
        setTestBusy(prev => {
          if (!prev.has(kind)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(kind);
          return next;
        });
      }
    }
  }

  function dismissTest(kind) {
    setTestResults(prev => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {(loadError || (loading && servers === null) || (servers !== null && servers.length === 0)) && (
        <Card
          title="Web server"
          actions={
            <button className="btn sm" onClick={loadServers} disabled={loading}>
              {loading ? 'Loading…' : 'Reload'}
            </button>
          }
        >
          {loadError && (
            <div className="row">
              <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
                {loadError}
              </span>
              <button className="btn sm" onClick={loadServers}>
                Retry
              </button>
            </div>
          )}
          {!loadError && loading && servers === null && (
            <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
              Detecting web servers…
            </div>
          )}
          {!loadError && servers !== null && servers.length === 0 && !loading && (
            <Empty title="No web server detected">
              Neither nginx nor Apache was found installed on this host. That's a normal answer, not a failure.
            </Empty>
          )}
        </Card>
      )}

      {servers !== null && servers.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={loadServers} disabled={loading}>
              {loading ? 'Loading…' : 'Reload'}
            </button>
          </div>
          {listening.length > 0 && (
            <div className="muted mono" style={{ fontSize: 11 }}>
              Listening: {listening.join(' · ')}
            </div>
          )}
          {servers.map(server => (
            <ServerCard
              key={server.unit}
              server={server}
              busy={busyUnits.has(serviceUnit(server))}
              actionResult={actionResults[serviceUnit(server)]}
              onConfirm={setConfirm}
              onDismissAction={dismissAction}
              testing={testBusy.has(server.kind)}
              testResult={testResults[server.kind]}
              onTest={runTest}
              onDismissTest={dismissTest}
              vhostState={vhostState}
              onView={setViewing}
            />
          ))}
        </>
      )}

      {confirm && (
        <ConfirmDialog
          unit={confirm.unit}
          action={confirm.action}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runAction(confirm.unit, confirm.action)}
        />
      )}
      {viewing && <ConfigViewerDialog path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
