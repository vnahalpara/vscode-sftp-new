import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtBytes } from '../src/format';
import { CsvOp, HostMessage, delimiterLabel, eolLabel } from '../../src/modules/csv/protocol';
import { Delimiter, Eol } from '../../src/modules/csv/types';
import Grid, { CellRef } from './Grid';
import Toolbar from './Toolbar';
import { filterRows } from './search';
import { SortState, nextSortState } from './sortState';
import { applyOpToRows, rowsWidth } from './tableState';
import { post } from './vscode';

interface Toast {
  id: number;
  message: string;
}

export default function App() {
  const [screen, setScreen] = useState<'loading' | 'grid' | 'tooLarge'>('loading');
  const [rows, setRows] = useState<string[][]>([]);
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [eol, setEol] = useState<Eol>('\n');
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState('');
  const [tooLarge, setTooLarge] = useState({ bytes: 0, limit: 0 });
  const [hasHeader, setHasHeader] = useState(true);
  const [sort, setSort] = useState<SortState | null>(null);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [scopeCol, setScopeCol] = useState<number | null>(null);
  const [replaceText, setReplaceText] = useState('');
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [editRequest, setEditRequest] = useState<CellRef | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // The document version the next op will be based on. A ref, not state: it is
  // read when a message is posted, not when the component renders.
  const revisionRef = useRef(0);
  // One op in flight at a time. Two ops posted with the same `base` would make
  // the host reject the second as stale and silently drop the user's edit.
  const pendingRef = useRef<CsvOp[]>([]);
  const inFlightRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const toastId = useRef(0);

  const pushToast = useCallback((message: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts(list => list.concat([{ id, message }]));
    window.setTimeout(() => setToasts(list => list.filter(toast => toast.id !== id)), 6000);
  }, []);

  const flush = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    const next = pendingRef.current.shift();
    if (!next) {
      return;
    }
    inFlightRef.current = true;
    post({ type: 'op', base: revisionRef.current, op: next });
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as HostMessage;
      if (!message || typeof message.type !== 'string') {
        return;
      }
      if (message.type === 'table') {
        // A full table always wins: the host is the document, and anything
        // queued here was made against a version that no longer exists.
        pendingRef.current = [];
        inFlightRef.current = false;
        revisionRef.current = message.revision;
        setRows(message.rows);
        setDelimiter(message.delimiter);
        setEol(message.eol);
        setReadOnly(message.readOnly);
        setReadOnlyReason(message.readOnlyReason || '');
        setSelectedRows([]);
        setScreen('grid');
        return;
      }
      if (message.type === 'ack') {
        revisionRef.current = message.revision;
        inFlightRef.current = false;
        flush();
        return;
      }
      if (message.type === 'tooLarge') {
        setTooLarge({ bytes: message.bytes, limit: message.limit });
        setScreen('tooLarge');
        return;
      }
      if (message.type === 'error') {
        pushToast(message.message);
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [flush, pushToast]);

  // Ctrl/Cmd+F belongs to the grid: the webview's find widget is off, because
  // searching the DOM would only ever find the rows that happen to be
  // rendered.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        if (searchRef.current) {
          searchRef.current.focus();
          searchRef.current.select();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const sendOp = useCallback(
    (op: CsvOp) => {
      if (readOnly) {
        return;
      }
      setRows(current => applyOpToRows(current, op));
      pendingRef.current.push(op);
      flush();
    },
    [readOnly, flush]
  );

  const width = rowsWidth(rows);

  const headers = useMemo(() => {
    const out: string[] = [];
    for (let c = 0; c < width; c += 1) {
      // Header toggle off: plain 1, 2, 3… and row 0 is an ordinary row.
      if (!hasHeader || rows.length === 0) {
        out.push(String(c + 1));
        continue;
      }
      out.push(rows[0][c] !== undefined ? rows[0][c] : '');
    }
    return out;
  }, [rows, hasHeader, width]);

  const visibleRows = useMemo(
    () => filterRows(rows, query, matchCase, scopeCol, hasHeader),
    [rows, query, matchCase, scopeCol, hasHeader]
  );

  const onHeaderClick = (col: number) => {
    const next = nextSortState(sort, col);
    setSort(next);
    // The third click clears the indicator only. The rows are already in that
    // order in the file, so there is nothing to send.
    if (next) {
      sendOp({ type: 'sort', col, direction: next.direction, hasHeader });
    }
  };

  const onAddRow = () => {
    const at = selectedRows.length > 0 ? Math.max.apply(null, selectedRows) + 1 : rows.length;
    sendOp({ type: 'insertRows', at, count: 1 });
  };

  const onReplaceAll = () => {
    if (query === '') {
      return;
    }
    sendOp({
      type: 'replaceAll',
      find: query,
      replace: replaceText,
      col: scopeCol === null ? undefined : scopeCol,
      matchCase,
      hasHeader,
    });
  };

  if (screen === 'loading') {
    return <div className="csv-screen">Loading…</div>;
  }

  if (screen === 'tooLarge') {
    return (
      <div className="csv-screen">
        <h2>This file is too large for the grid</h2>
        <p>
          {fmtBytes(tooLarge.bytes)} — the grid handles files up to {fmtBytes(tooLarge.limit)}.
        </p>
        <button className="csv-button csv-primary" onClick={() => post({ type: 'openAsText' })}>
          Open as Text
        </button>
      </div>
    );
  }

  const status = `${rows.length.toLocaleString()} rows × ${width} columns · ${delimiterLabel(
    delimiter
  )} · ${eolLabel(eol)}`;

  return (
    <div className="csv-app">
      <Toolbar
        readOnly={readOnly}
        hasHeader={hasHeader}
        canDeleteRows={selectedRows.length > 0}
        canAddColumn={rows.length > 0}
        status={status}
        matchText={query ? `${visibleRows.length} matching` : ''}
        onAddRow={onAddRow}
        onDeleteRows={() => {
          sendOp({ type: 'deleteRows', rows: selectedRows });
          setSelectedRows([]);
        }}
        onAddColumn={() => sendOp({ type: 'insertColumn', at: width })}
        onToggleHeader={() => setHasHeader(value => !value)}
        onOpenAsText={() => post({ type: 'openAsText' })}
      >
        {/* The search and replace controls are added here in Task 9. */}
      </Toolbar>

      {readOnly ? <div className="csv-banner">{readOnlyReason}</div> : null}

      <Grid
        rows={rows}
        width={width}
        visibleRows={visibleRows}
        hasHeader={hasHeader}
        headers={headers}
        readOnly={readOnly}
        sort={sort}
        query={query}
        matchCase={matchCase}
        selectedRows={selectedRows}
        editRequest={editRequest}
        onEditRequestHandled={() => setEditRequest(null)}
        onSelectRows={setSelectedRows}
        onSetCell={(row, col, value) => sendOp({ type: 'setCell', row, col, value })}
        onHeaderClick={onHeaderClick}
        onRowMenu={() => undefined}
        onHeaderMenu={() => undefined}
        onError={pushToast}
      />

      <div className="csv-toasts">
        {toasts.map(toast => (
          <div className="csv-toast" key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
