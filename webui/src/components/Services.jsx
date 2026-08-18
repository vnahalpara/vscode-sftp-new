import React, { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api.js';
import { Badge, Card, Empty } from './ui.jsx';

// The five actions this milestone wires up. enable/disable are deliberately
// excluded here — see the Task 7 brief.
const ACTIONS = ['start', 'stop', 'restart', 'reload', 'reload-or-restart'];

// A badge tone from a ServiceRow's `active`/`sub` (ops/services.ts).
//
// Ported from Server-manager/client/src/components/Services.jsx's
// `stateTone`, which only recognised `active === 'active' && sub ===
// 'running'` as "good" — an active/exited oneshot unit (a unit that runs
// once and exits 0, e.g. a cert-renewal or a one-shot setup service) fell
// through every branch of that function and rendered with no tone at all,
// identical in appearance to a plain inactive unit. Any `active` state gets
// 'ok' here regardless of `sub`, and `failed` keeps its own distinct 'bad'
// tone so a crashed unit never reads the same as a merely stopped one.
function stateTone(row) {
  if (row.active === 'failed') {
    return 'bad';
  }
  if (row.active === 'active') {
    return 'ok';
  }
  if (row.active === 'activating' || row.active === 'deactivating') {
    return 'warn';
  }
  return '';
}

function stateLabel(row) {
  return row.sub || row.active;
}

function matchesFilter(row, needle) {
  if (!needle) {
    return true;
  }
  return (
    row.unit.toLowerCase().indexOf(needle) !== -1 ||
    (row.description || '').toLowerCase().indexOf(needle) !== -1
  );
}

// Every action — including 'start' — opens this before anything runs. These
// commands execute over SSH against a real, usually production, host; a
// misclick landing on 'restart' for a database unit is exactly the failure
// this dialog exists to prevent, so there is no fast path that skips it.
function ConfirmDialog({ unit, action, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

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
          <button className={action === 'stop' ? 'btn danger' : 'btn primary'} onClick={onConfirm} autoFocus>
            {action} {unit}
          </button>
        </div>
      </div>
    </div>
  );
}

// The inline, per-row result — never a toast. A failed action's `output` is
// frequently the multi-line sudoHint (activity.ts), which is the single most
// useful string on this page when it appears: who to add a sudoers rule for,
// on which host, for which binaries. `pre.output` (styles.css) wraps rather
// than clips, so the full hint stays readable instead of being cut into an
// unreadable single-line cell. Nothing here times out or auto-dismisses —
// only the explicit Dismiss button clears it.
function ResultRow({ unit, colSpan, result, onDismiss }) {
  if (!result) {
    return null;
  }
  if (result.pending) {
    return (
      <tr>
        <td colSpan={colSpan} className="muted" style={{ padding: '8px 10px', fontSize: 12.5 }}>
          Running <span className="mono">systemctl {result.action}</span> on {unit}…
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.03)' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: result.output ? 6 : 0 }}>
          <Badge tone={result.ok ? 'ok' : 'bad'}>
            {result.action} {unit} — {result.ok ? 'done' : 'failed'}
          </Badge>
          <button className="btn sm" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
        {result.output && <pre className="output" style={{ margin: 0 }}>{result.output}</pre>}
      </td>
    </tr>
  );
}

const COLS = 5;

export default function Services() {
  const [services, setServices] = useState(null); // null until the first load resolves
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState(null); // { unit, action }
  const [busyUnit, setBusyUnit] = useState('');
  const [results, setResults] = useState({}); // unit -> { pending, ok, output, action }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiGet('/api/services');
      setServices((res && res.services) || []);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(unit, action) {
    setConfirm(null);
    setBusyUnit(unit);
    setResults(prev => ({ ...prev, [unit]: { pending: true, action } }));
    try {
      // routes.ts's POST /api/services/:unit/:action returns HTTP 200 with
      // { ok: false, output } on a failed action deliberately — the failure
      // text (often the sudoHint) is data to render here, never an HTTP
      // error, so this never needs a catch for the "action failed" case.
      const res = await apiPost(`/api/services/${encodeURIComponent(unit)}/${action}`);
      const ok = Boolean(res && res.ok);
      setResults(prev => ({ ...prev, [unit]: { ok, output: (res && res.output) || '', action } }));
      if (ok) {
        await load();
      }
    } catch (err) {
      // A thrown error here means the request itself failed (session gone,
      // network drop) — still rendered inline, same as a { ok: false } result.
      setResults(prev => ({ ...prev, [unit]: { ok: false, output: err.message, action } }));
    } finally {
      setBusyUnit('');
    }
  }

  function dismiss(unit) {
    setResults(prev => {
      const next = { ...prev };
      delete next[unit];
      return next;
    });
  }

  const needle = filter.trim().toLowerCase();
  const rows = (services || []).filter(row => matchesFilter(row, needle));

  return (
    <Card
      title="Services"
      sub={
        services
          ? `${services.length} systemd unit${services.length === 1 ? '' : 's'} · actions run over SSH with sudo`
          : undefined
      }
      actions={
        <div className="row">
          <input
            className="input"
            style={{ width: 230 }}
            placeholder="Filter by unit or description…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <button className="btn sm" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
      }
    >
      {loadError && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
            {loadError}
          </span>
          <button className="btn sm" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {loading && services === null && !loadError && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Loading services…
        </div>
      )}

      {services !== null && services.length === 0 && !loading && (
        <Empty title="No services found">The host reported no systemd service units.</Empty>
      )}

      {services !== null && services.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Description</th>
              <th>State</th>
              <th>Startup</th>
              <th style={{ width: 360 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const busy = busyUnit === row.unit;
              return (
                <React.Fragment key={row.unit}>
                  <tr style={busy ? { opacity: 0.55 } : undefined}>
                    <td className="mono">{row.unit}</td>
                    <td
                      className="muted"
                      style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={row.description}
                    >
                      {row.description || '—'}
                    </td>
                    <td>
                      <Badge tone={stateTone(row)}>{stateLabel(row)}</Badge>
                      {row.load !== 'loaded' && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {row.load}
                        </div>
                      )}
                    </td>
                    <td className="muted">{row.enabled}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        {ACTIONS.map(action => (
                          <button
                            key={action}
                            className={`btn sm ${action === 'stop' ? 'danger' : ''}`}
                            disabled={busy}
                            onClick={() => setConfirm({ unit: row.unit, action })}
                          >
                            {action}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                  <ResultRow
                    unit={row.unit}
                    colSpan={COLS}
                    result={results[row.unit]}
                    onDismiss={() => dismiss(row.unit)}
                  />
                </React.Fragment>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={COLS} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                  No services match “{filter.trim()}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {confirm && (
        <ConfirmDialog
          unit={confirm.unit}
          action={confirm.action}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runAction(confirm.unit, confirm.action)}
        />
      )}
    </Card>
  );
}
