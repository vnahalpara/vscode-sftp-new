import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, getToken } from '../api.js';
import { Card, Empty } from './ui.jsx';
import DbGrid from './DbGrid.jsx';
import DbSqlRunner from './DbSqlRunner.jsx';

// GET /api/db/:id/export[?table=] streams the file with the token in the
// `x-sftp-token` HEADER (api.js), not the query string -- a plain
// `<a href>` cannot set a header, so that request would 401. Fetch it here
// with the same header apiGet/apiPost send, read the response as a Blob,
// and trigger the save through a temporary object-URL anchor, revoking the
// URL once the click has been dispatched. The filename comes from the
// response's `content-disposition` (exportFilename, dbExportStream.ts) --
// never invented client-side, so a table export and a whole-database export
// are never accidentally saved under the same name.
async function downloadExport(url) {
  const res = await fetch(url, { headers: { 'x-sftp-token': getToken() } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match ? match[1] : 'export.sql.gz';
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function DatabaseTab({ profile }) {
  const [databases, setDatabases] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState(null);
  const [dbId, setDbId] = useState('');

  const [tables, setTables] = useState(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState(null);
  const [tableFilter, setTableFilter] = useState('');
  const [table, setTable] = useState('');

  const [exportBusy, setExportBusy] = useState(null); // 'table' | 'database' | null
  const [exportError, setExportError] = useState(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDatabases = useCallback(async () => {
    setDbLoading(true);
    setDbError(null);
    try {
      const res = await apiGet('/api/db');
      if (!mountedRef.current) {
        return;
      }
      const list = (res && res.databases) || [];
      setDatabases(list);
      // Keep the current selection if it still exists (a Reload should not
      // silently jump the picker to a different database); otherwise fall
      // back to the first one.
      setDbId(prev => (prev && list.some(d => d.id === prev) ? prev : (list[0] && list[0].id) || ''));
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setDbError(err.message);
    } finally {
      if (mountedRef.current) {
        setDbLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  const loadTables = useCallback(async () => {
    if (!dbId) {
      setTables(null);
      return;
    }
    setTablesLoading(true);
    setTablesError(null);
    try {
      const res = await apiGet(`/api/db/${encodeURIComponent(dbId)}/tables`);
      if (!mountedRef.current) {
        return;
      }
      setTables((res && res.tables) || []);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setTablesError(err.message);
    } finally {
      if (mountedRef.current) {
        setTablesLoading(false);
      }
    }
  }, [dbId]);

  // A database switch drops the current table selection -- a table name
  // from one schema is meaningless (and may not even exist) in another.
  useEffect(() => {
    setTable('');
    setTableFilter('');
    loadTables();
  }, [dbId, loadTables]);

  async function doExport(kind) {
    if (exportBusy) {
      return;
    }
    setExportBusy(kind);
    setExportError(null);
    try {
      const url =
        kind === 'table'
          ? `/api/db/${encodeURIComponent(dbId)}/export?table=${encodeURIComponent(table)}`
          : `/api/db/${encodeURIComponent(dbId)}/export`;
      await downloadExport(url);
    } catch (err) {
      if (mountedRef.current) {
        setExportError(err.message);
      }
    } finally {
      if (mountedRef.current) {
        setExportBusy(null);
      }
    }
  }

  const needle = tableFilter.trim().toLowerCase();
  const filteredTables = (tables || []).filter(t => !needle || t.toLowerCase().indexOf(needle) !== -1);
  const hasDatabases = databases !== null && databases.length > 0;

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
      <div style={{ width: 260, flex: '0 0 260px' }}>
        <Card
          title="Databases"
          sub={databases ? `${databases.length} configured` : undefined}
          actions={
            <button className="btn sm" onClick={loadDatabases} disabled={dbLoading}>
              {dbLoading ? 'Loading…' : 'Reload'}
            </button>
          }
        >
          {dbError && (
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
                {dbError}
              </span>
              <button className="btn sm" onClick={loadDatabases}>
                Retry
              </button>
            </div>
          )}

          {databases !== null && databases.length === 0 && !dbLoading && !dbError && (
            <Empty title="No databases">Nothing was returned for this profile.</Empty>
          )}

          {hasDatabases && (
            <>
              <select className="input" value={dbId} onChange={e => setDbId(e.target.value)} style={{ marginBottom: 12 }}>
                {databases.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>

              <input
                className="input"
                placeholder="Filter tables…"
                value={tableFilter}
                onChange={e => setTableFilter(e.target.value)}
                style={{ marginBottom: 8 }}
              />

              {tablesError && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="mono" style={{ color: 'var(--critical)', fontSize: 12 }}>
                    {tablesError}
                  </span>
                  <button className="btn sm" onClick={loadTables}>
                    Retry
                  </button>
                </div>
              )}

              {tablesLoading && tables === null && (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Loading tables…
                </div>
              )}

              {tables !== null && !tablesLoading && tables.length === 0 && !tablesError && (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  No tables in this database.
                </div>
              )}

              <ul style={{ margin: 0, padding: 0, maxHeight: 420, overflowY: 'auto' }}>
                {filteredTables.map(t => (
                  <li
                    key={t}
                    onClick={() => setTable(t)}
                    className="mono"
                    style={{
                      listStyle: 'none',
                      cursor: 'pointer',
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: table === t ? 'var(--surface-2)' : 'transparent',
                      fontSize: 12.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t}
                  </li>
                ))}
                {tables && tables.length > 0 && filteredTables.length === 0 && (
                  <li className="muted" style={{ listStyle: 'none', padding: '6px 8px', fontSize: 12 }}>
                    No tables match “{tableFilter.trim()}”.
                  </li>
                )}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 16 }}>
        {hasDatabases && (
          <Card title="Export" sub="Download a .sql.gz of this table or the whole database">
            {exportError && (
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
                  {exportError}
                </span>
                <button className="btn sm" onClick={() => setExportError(null)}>
                  Dismiss
                </button>
              </div>
            )}
            <div className="row">
              <button className="btn sm" disabled={!table || Boolean(exportBusy)} onClick={() => doExport('table')}>
                {exportBusy === 'table' ? 'Exporting…' : 'Export table'}
              </button>
              <button className="btn sm" disabled={!dbId || Boolean(exportBusy)} onClick={() => doExport('database')}>
                {exportBusy === 'database' ? 'Exporting…' : 'Export database'}
              </button>
            </div>
          </Card>
        )}

        {hasDatabases && !table && (
          <Card title="Table">
            <Empty title="Select a table">Choose a table from the list to browse its rows.</Empty>
          </Card>
        )}

        {/* Remounted (via `key`) on every database/table switch -- see
            DbGrid's own comment for why that replaces a change-effect. */}
        {table && <DbGrid key={`${dbId}:${table}`} dbId={dbId} table={table} />}

        {dbId && <DbSqlRunner key={dbId} dbId={dbId} />}
      </div>
    </div>
  );
}

// The Database tab. Two distinct "nothing to show" states, and they must not
// be conflated:
//   - `profile` not loaded yet -> a neutral loading state, never the "no
//     database configured" message (which would be a false negative for a
//     profile that, once loaded, turns out to have one).
//   - `profile.hasDatabase === false` -> the real empty state, naming
//     sftp.json as where to fix it.
// Splitting this into two components (rather than an early return inside
// one) keeps every hook below unconditional -- an early return ahead of a
// useState/useEffect call would violate the rules of hooks the moment this
// component re-renders with a different `profile`.
export default function Database({ profile }) {
  if (!profile) {
    return (
      <Card title="Database">
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Loading…
        </div>
      </Card>
    );
  }

  if (!profile.hasDatabase) {
    return (
      <Card title="Database">
        <Empty title="No database configured">
          This profile has no <span className="mono">database</span> entries. Add one under{' '}
          <span className="mono">database</span> in <span className="mono">sftp.json</span> to enable this tab.
        </Empty>
      </Card>
    );
  }

  return <DatabaseTab profile={profile} />;
}
