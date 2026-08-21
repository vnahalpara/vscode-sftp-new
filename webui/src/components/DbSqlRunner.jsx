import React, { useEffect, useRef, useState } from 'react';
import { apiPost } from '../api.js';
import { Card, ConfirmDialog } from './ui.jsx';

// A collapsible "run raw SQL" panel. POST /api/db/:id/sql answers with
// EITHER `{ results, error }` (the script ran) OR `{ needsConfirm: true,
// reason, statements }` (Global Constraint 5 -- a normal 200 answer, not a
// failure). That second shape can happen TWICE for the same script: once
// because it mutates data at all, and -- only if the first confirm is given
// -- again because it has no WHERE clause and so touches every row. Those
// are two different decisions ("this changes data" vs. "this affects every
// row"), so they get two distinct dialogs in sequence, never collapsed into
// one that sends both `confirm` and `confirmUnfiltered` at once.
export default function DbSqlRunner({ dbId }) {
  const [open, setOpen] = useState(false);
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null); // per-statement result[] | null

  // 'confirm' | 'confirmUnfiltered' | null -- which gate the last response
  // asked for. The two never coexist: a fresh response either advances the
  // stage or resolves it.
  const [confirmStage, setConfirmStage] = useState(null);
  const [confirmReason, setConfirmReason] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function run(flags) {
    setRunning(true);
    setError(null);
    try {
      const res = await apiPost(`/api/db/${encodeURIComponent(dbId)}/sql`, { sql, ...flags });
      if (!mountedRef.current) {
        return;
      }
      if (res && res.needsConfirm) {
        // `flags.confirm` set means this WAS the first confirm being
        // resent -- a second needsConfirm now means the stronger,
        // unfiltered-mutation gate, never the same one repeating.
        setConfirmStage(flags && flags.confirm ? 'confirmUnfiltered' : 'confirm');
        setConfirmReason(res.reason || '');
        return;
      }
      setConfirmStage(null);
      setResults((res && res.results) || []);
      setError((res && res.error) || null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(err.message);
    } finally {
      if (mountedRef.current) {
        setRunning(false);
      }
    }
  }

  function startRun() {
    if (!sql.trim() || running) {
      return;
    }
    setResults(null);
    setError(null);
    run({});
  }

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      startRun();
    }
  }

  function handleConfirm() {
    if (confirmStage === 'confirm') {
      return run({ confirm: true });
    }
    if (confirmStage === 'confirmUnfiltered') {
      return run({ confirm: true, confirmUnfiltered: true });
    }
    return undefined;
  }

  function handleCancelConfirm() {
    setConfirmStage(null);
    setConfirmReason('');
  }

  return (
    <Card
      title="SQL runner"
      sub={open ? undefined : 'Run a custom SQL query on this database'}
      actions={
        <button className="btn sm" onClick={() => setOpen(o => !o)}>
          {open ? 'Collapse' : 'Expand'}
        </button>
      }
    >
      {open && (
        <>
          <textarea
            className="input"
            style={{ minHeight: 120 }}
            placeholder="SELECT ...   (Ctrl/Cmd+Enter to run)"
            value={sql}
            onChange={e => setSql(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
            <button className="btn sm primary" disabled={running || !sql.trim()} onClick={startRun}>
              {running ? 'Running…' : 'Run'}
            </button>
            {error && (
              <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
                {error}
              </span>
            )}
          </div>

          {results &&
            results.map((r, i) => (
              <div key={i} style={{ marginTop: 14 }}>
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
                  Statement {i + 1}
                  {r.columns && r.columns.length
                    ? ` · ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} · ${r.durationMs} ms${
                        r.truncated ? ' · some cell values were shortened' : ''
                      }`
                    : ` · ${r.affectedRows || 0} row(s) affected · ${r.durationMs} ms`}
                </div>
                {r.columns && r.columns.length > 0 && (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          {r.columns.map(c => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {r.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((v, ci) => (
                              <td key={ci} className="mono">
                                {v === null ? (
                                  <span className="muted" style={{ fontStyle: 'italic' }}>
                                    NULL
                                  </span>
                                ) : (
                                  String(v)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
        </>
      )}

      {confirmStage === 'confirm' && (
        <ConfirmDialog
          title="Run SQL"
          message={confirmReason}
          confirmLabel="Run"
          danger
          dismissible={!running}
          onCancel={handleCancelConfirm}
          onConfirm={handleConfirm}
        />
      )}
      {confirmStage === 'confirmUnfiltered' && (
        <ConfirmDialog
          title="This affects every row"
          message={confirmReason}
          confirmLabel="Run anyway"
          danger
          dismissible={!running}
          onCancel={handleCancelConfirm}
          onConfirm={handleConfirm}
        />
      )}
    </Card>
  );
}
