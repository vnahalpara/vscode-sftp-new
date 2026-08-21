import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api.js';
import { Card, ConfirmDialog, Empty } from './ui.jsx';

// Mirrors src/core/dbQuery.ts's FILTER_OPS exactly. Not imported from there:
// webui is a separate Vite build with no access to the extension's src/
// tree, so this list is this file's own copy -- keep it in sync by hand if
// that one ever changes.
const FILTER_OPS = ['=', '!=', 'LIKE', '>', '<', '>=', '<=', 'IS NULL', 'IS NOT NULL'];
const NULL_OPS = new Set(['IS NULL', 'IS NOT NULL']);

// routes.ts caps `limit` at 500 server-side (ops/db.ts's MAX_PAGE_SIZE) --
// these are the page sizes offered here, all inside that cap.
const PAGE_SIZES = [25, 50, 100, 200, 500];
const DEFAULT_LIMIT = 50;

function metaFor(meta, col) {
  return meta.find(m => m.name === col) || { name: col, type: '', nullable: true, key: '' };
}

function pageLabel(offset, rowsLen, total) {
  if (total === 0) {
    return '0 of 0';
  }
  return `${offset + 1}–${offset + rowsLen} of ${total}`;
}

// The row identity for edit/delete: the primary key when the table has one
// (a column whose `key === 'PRI'` in the column metadata), every column's
// CURRENT value otherwise -- the same rule dbDataBrowser/index.ts's
// whereForRow() applies, and the same rule ops/db.ts's requireIdentity()
// enforces server-side (Global Constraint 4: `usingPk: false` also gets
// `LIMIT 1` server-side, since two byte-identical rows would otherwise both
// be written by one edit).
function identityFor(row, columns, meta) {
  const pkCols = meta.filter(m => m.key === 'PRI').map(m => m.name);
  const usingPk = pkCols.length > 0;
  const cols = usingPk ? pkCols : columns;
  const where = {};
  cols.forEach(c => {
    const idx = columns.indexOf(c);
    where[c] = idx === -1 ? null : row[idx];
  });
  return { where, usingPk };
}

// One table's data grid: sort/filter/page, inline cell editing, row delete.
// Mounted with `key={dbId+table}` by Database.jsx, so a table/database
// switch is a fresh mount -- every piece of state below (sort, filter, page,
// in-flight edit) resets for free instead of needing its own change-effect.
export default function DbGrid({ dbId, table }) {
  const [meta, setMeta] = useState([]); // ColumnInfo[]
  const [metaError, setMetaError] = useState(null);

  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [sort, setSort] = useState(null); // { column, dir } | null
  const [filterCol, setFilterCol] = useState('');
  const [filterOp, setFilterOp] = useState('=');
  const [filterVal, setFilterVal] = useState('');
  const [activeFilter, setActiveFilter] = useState(null);

  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [offset, setOffset] = useState(0);

  const [editing, setEditing] = useState(null); // { ri, col, value, isNull } | null
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null); // row index | null
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [rowError, setRowError] = useState(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const res = await apiGet(`/api/db/${encodeURIComponent(dbId)}/tables/${encodeURIComponent(table)}/columns`);
      if (!mountedRef.current) {
        return;
      }
      setMeta((res && res.columns) || []);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setMetaError(err.message);
    }
  }, [dbId, table]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const body = { limit, offset };
      if (sort) {
        body.sort = sort;
      }
      if (activeFilter) {
        body.filter = activeFilter;
      }
      const res = await apiPost(
        `/api/db/${encodeURIComponent(dbId)}/tables/${encodeURIComponent(table)}/rows`,
        body
      );
      if (!mountedRef.current) {
        return;
      }
      setColumns((res && res.columns) || []);
      setRows((res && res.rows) || []);
      setTotal((res && res.total) || 0);
      setTruncated(Boolean(res && res.truncated));
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
  }, [dbId, table, sort, activeFilter, limit, offset]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  // ASC -> DESC -> none, per column. A different column clicked starts fresh
  // at ASC rather than continuing whatever the previous column's cycle was.
  function cycleSort(col) {
    setOffset(0);
    setSort(prev => {
      if (!prev || prev.column !== col) {
        return { column: col, dir: 'ASC' };
      }
      if (prev.dir === 'ASC') {
        return { column: col, dir: 'DESC' };
      }
      return null;
    });
  }

  function applyFilter() {
    setOffset(0);
    if (!NULL_OPS.has(filterOp) && filterVal === '') {
      setActiveFilter(null);
      return;
    }
    setActiveFilter({ column: filterCol || null, op: filterOp, value: filterVal });
  }

  function clearFilter() {
    setFilterCol('');
    setFilterOp('=');
    setFilterVal('');
    setActiveFilter(null);
    setOffset(0);
  }

  function startEdit(ri, col) {
    if (editBusy) {
      return;
    }
    const idx = columns.indexOf(col);
    const v = rows[ri][idx];
    setEditError(null);
    setEditing({ ri, col, value: v === null ? '' : String(v), isNull: v === null });
  }

  function cancelEdit() {
    if (editBusy) {
      return;
    }
    setEditing(null);
    setEditError(null);
  }

  async function commitEdit() {
    if (!editing || editBusy) {
      return;
    }
    const { ri, col, value, isNull } = editing;
    const idx = columns.indexOf(col);
    const orig = rows[ri][idx];
    const unchanged = isNull ? orig === null : orig !== null && String(orig) === value;
    if (unchanged) {
      setEditing(null);
      return;
    }
    const { where, usingPk } = identityFor(rows[ri], columns, meta);
    setEditBusy(true);
    setEditError(null);
    try {
      await apiPost(`/api/db/${encodeURIComponent(dbId)}/tables/${encodeURIComponent(table)}/update`, {
        set: { [col]: isNull ? null : value },
        where,
        usingPk,
      });
      if (!mountedRef.current) {
        return;
      }
      setEditing(null);
      await loadRows();
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setEditError(err.message);
    } finally {
      if (mountedRef.current) {
        setEditBusy(false);
      }
    }
  }

  // Kept mounted across the await, same as CloudflareCard's purge confirm
  // (ui.jsx's ConfirmDialog doc comment) -- a row delete is destructive,
  // not abortable client-side, and this grid has no per-row banner to fall
  // back on if the dialog closed early.
  async function confirmDelete() {
    if (deleteTarget == null) {
      return;
    }
    const ri = deleteTarget;
    const { where, usingPk } = identityFor(rows[ri], columns, meta);
    setDeleteBusy(true);
    setRowError(null);
    try {
      await apiPost(`/api/db/${encodeURIComponent(dbId)}/tables/${encodeURIComponent(table)}/delete`, {
        where,
        usingPk,
      });
      if (!mountedRef.current) {
        return;
      }
      setDeleteTarget(null);
      await loadRows();
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setRowError(err.message);
      setDeleteTarget(null);
    } finally {
      if (mountedRef.current) {
        setDeleteBusy(false);
      }
    }
  }

  const filterColumns = columns.length ? columns : meta.map(m => m.name);

  return (
    <Card
      title={table}
      sub={!loading && !loadError ? `${total.toLocaleString()} row${total === 1 ? '' : 's'}` : undefined}
      actions={
        <div className="row">
          <select
            className="input"
            style={{ width: 92 }}
            value={limit}
            onChange={e => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
          >
            {PAGE_SIZES.map(p => (
              <option key={p} value={p}>
                {p}/page
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={loadRows} disabled={loading}>
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Filter
        </span>
        <select className="input" style={{ width: 170 }} value={filterCol} onChange={e => setFilterCol(e.target.value)}>
          <option value="">(anywhere)</option>
          {filterColumns.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 130 }} value={filterOp} onChange={e => setFilterOp(e.target.value)}>
          {FILTER_OPS.map(op => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        {!NULL_OPS.has(filterOp) && (
          <input
            className="input"
            style={{ width: 200 }}
            placeholder="value"
            value={filterVal}
            onChange={e => setFilterVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                applyFilter();
              }
            }}
          />
        )}
        <button className="btn sm" onClick={applyFilter}>
          Apply
        </button>
        <button className="btn sm" onClick={clearFilter}>
          Clear
        </button>
      </div>

      {metaError && (
        <div className="mono" style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 10 }}>
          {metaError}
        </div>
      )}

      {loadError && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
            {loadError}
          </span>
          <button className="btn sm" onClick={loadRows}>
            Retry
          </button>
        </div>
      )}

      {editError && (
        <div className="mono" style={{ color: 'var(--critical)', fontSize: 12, marginBottom: 10 }}>
          {editError}
        </div>
      )}

      {rowError && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
            {rowError}
          </span>
          <button className="btn sm" onClick={() => setRowError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {truncated && (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
          Some cell values were shortened — a value over 64 KiB is truncated for display.
        </div>
      )}

      {loading && rows.length === 0 && !loadError && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Loading rows…
        </div>
      )}

      {!loading && !loadError && columns.length === 0 && (
        <Empty title="No columns">This table returned no columns.</Empty>
      )}

      {columns.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                {columns.map(c => {
                  const isSorted = sort && sort.column === c;
                  return (
                    <th key={c} onClick={() => cycleSort(c)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      {c}
                      {isSorted && <span style={{ color: 'var(--series-1)' }}>{sort.dir === 'DESC' ? ' ▼' : ' ▲'}</span>}
                    </th>
                  );
                })}
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((v, ci) => {
                    const col = columns[ci];
                    const cm = metaFor(meta, col);
                    const isEditingThis = editing && editing.ri === ri && editing.col === col;
                    return (
                      <td
                        key={ci}
                        className="mono"
                        style={{ cursor: isEditingThis ? 'default' : 'pointer', maxWidth: 320 }}
                        onClick={() => {
                          if (!isEditingThis) {
                            startEdit(ri, col);
                          }
                        }}
                      >
                        {isEditingThis ? (
                          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }} onClick={e => e.stopPropagation()}>
                            <input
                              autoFocus
                              className="input"
                              style={{ padding: '2px 6px', fontSize: 12, width: 170 }}
                              value={editing.value}
                              disabled={editing.isNull || editBusy}
                              onChange={e => setEditing({ ...editing, value: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  commitEdit();
                                }
                                if (e.key === 'Escape') {
                                  cancelEdit();
                                }
                              }}
                            />
                            {cm.nullable && (
                              <label className="muted" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
                                <input
                                  type="checkbox"
                                  checked={editing.isNull}
                                  disabled={editBusy}
                                  onChange={e => setEditing({ ...editing, isNull: e.target.checked })}
                                />{' '}
                                NULL
                              </label>
                            )}
                          </div>
                        ) : v === null ? (
                          <span className="muted" style={{ fontStyle: 'italic' }}>
                            NULL
                          </span>
                        ) : (
                          <span
                            style={{ display: 'inline-block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
                            title={String(v)}
                          >
                            {String(v)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <button className="btn sm danger" onClick={() => setDeleteTarget(ri)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={columns.length + 1} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                    No rows match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {columns.length > 0 && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {pageLabel(offset, rows.length, total)}
          </span>
          <div className="row">
            <button className="btn sm" disabled={offset <= 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
              ‹ Prev
            </button>
            <button className="btn sm" disabled={loading || offset + rows.length >= total} onClick={() => setOffset(offset + limit)}>
              Next ›
            </button>
          </div>
        </div>
      )}

      {deleteTarget != null && (
        <ConfirmDialog
          title="Delete row"
          message={
            <>
              Delete this row from <strong className="mono">{table}</strong>? This cannot be undone.
            </>
          }
          confirmLabel="Delete row"
          danger
          dismissible={!deleteBusy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </Card>
  );
}
