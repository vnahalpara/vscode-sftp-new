import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightRanges } from './search';
import { SortState } from './sortState';
import { ROW_HEIGHT, useVirtualRows } from './useVirtualRows';

const GUTTER_WIDTH = 56;
const MIN_COL_WIDTH = 60;
const MAX_AUTO_COL_WIDTH = 320;
const CHAR_WIDTH = 7;
const CELL_PADDING = 16;
// Widths are guessed from the top of the file rather than all of it: scanning
// 200,000 rows to pick a column width would cost more than it is worth, and
// the user can drag any column that guesses wrong.
const AUTO_WIDTH_SAMPLE = 200;

export interface CellRef {
  row: number;
  col: number;
}

export interface GridProps {
  rows: string[][];
  width: number;
  // Document row indices to show, in display order. Search filters this list;
  // it never renumbers anything.
  visibleRows: number[];
  hasHeader: boolean;
  headers: string[];
  readOnly: boolean;
  sort: SortState | null;
  query: string;
  matchCase: boolean;
  selectedRows: number[];
  // Set by the header menu's Rename, cleared as soon as the grid has acted.
  editRequest: CellRef | null;
  onEditRequestHandled(): void;
  onSelectRows(rows: number[]): void;
  onSetCell(row: number, col: number, value: string): void;
  onHeaderClick(col: number): void;
  onRowMenu(row: number, x: number, y: number): void;
  onHeaderMenu(col: number, x: number, y: number): void;
  onError(message: string): void;
}

function cellValue(rows: string[][], row: number, col: number): string {
  const cells = rows[row];
  return cells && cells[col] !== undefined ? cells[col] : '';
}

function autoWidths(rows: string[][], headers: string[], width: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < width; c += 1) {
    let longest = headers[c] ? headers[c].length : 1;
    for (let r = 0; r < rows.length && r < AUTO_WIDTH_SAMPLE; r += 1) {
      const cell = rows[r][c];
      if (cell !== undefined && cell.length > longest) {
        longest = cell.length;
      }
    }
    out.push(
      Math.max(MIN_COL_WIDTH, Math.min(MAX_AUTO_COL_WIDTH, longest * CHAR_WIDTH + CELL_PADDING))
    );
  }
  return out;
}

function CellText(props: { value: string; query: string; matchCase: boolean }) {
  const ranges = highlightRanges(props.value, props.query, props.matchCase);
  if (ranges.length === 0) {
    return <>{props.value}</>;
  }
  const parts: any[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) {
      parts.push(props.value.slice(at, range.start));
    }
    parts.push(
      <mark className="csv-match" key={index}>
        {props.value.slice(range.start, range.end)}
      </mark>
    );
    at = range.end;
  });
  if (at < props.value.length) {
    parts.push(props.value.slice(at));
  }
  return <>{parts}</>;
}

interface EditingCell {
  row: number;
  col: number;
  value: string;
}

export default function Grid(props: GridProps) {
  const { rows, width, visibleRows, headers, readOnly, sort, query, matchCase, selectedRows } = props;

  const gridRef = useRef<HTMLDivElement | null>(null);
  // A callback ref, not a ref object: the empty-file screen renders no scroll
  // container at all, and an effect keyed on a ref object would never re-run
  // when the container finally mounts.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [overrides, setOverrides] = useState<{ [col: number]: number }>({});

  // What is being edited RIGHT NOW. `editing` is the last render's snapshot,
  // and blur runs before a queued setEditing has flushed.
  const editingRef = useRef<EditingCell | null>(null);
  // Raised while this component moves focus itself. Focusing the grid blurs
  // the cell input synchronously, so without this guard Escape would commit
  // the edit it is meant to throw away and Enter would commit twice.
  const suppressBlurRef = useRef(false);
  // The row a shift-click extends from: the last row clicked without shift.
  const anchorRef = useRef<number | null>(null);

  const view = useVirtualRows(scrollEl, visibleRows.length);

  const widths = useMemo(() => {
    const auto = autoWidths(rows, headers, width);
    return auto.map((value, index) => (overrides[index] !== undefined ? overrides[index] : value));
  }, [rows, headers, width, overrides]);

  const totalWidth = widths.reduce((sum, value) => sum + value, GUTTER_WIDTH);

  const setEditingCell = (next: EditingCell | null) => {
    editingRef.current = next;
    setEditing(next);
  };

  const focusGrid = () => {
    if (gridRef.current) {
      gridRef.current.focus();
    }
  };

  const scrollRowIntoView = (position: number) => {
    const el = scrollEl;
    if (!el) {
      return;
    }
    const top = position * ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  };

  const moveTo = (position: number, col: number) => {
    if (visibleRows.length === 0 || width === 0) {
      return;
    }
    const p = Math.min(Math.max(0, position), visibleRows.length - 1);
    const c = Math.min(Math.max(0, col), width - 1);
    setSelected({ row: visibleRows[p], col: c });
    scrollRowIntoView(p);
  };

  const startEdit = (row: number, col: number, replace: boolean, seed?: string) => {
    if (readOnly) {
      return;
    }
    setSelected({ row, col });
    setEditingCell({
      row,
      col,
      value: replace ? (seed !== undefined ? seed : '') : cellValue(rows, row, col),
    });
  };

  const commitEditing = (current: EditingCell, move: 'down' | 'left' | 'right' | 'none') => {
    // The guard goes up first: everything below can move focus, and the blur
    // that follows is delivered before this function returns.
    suppressBlurRef.current = true;
    setEditingCell(null);
    // A commit with an unchanged value sends nothing: an accidental Enter
    // should not put a row in the diff.
    if (current.value !== cellValue(rows, current.row, current.col)) {
      props.onSetCell(current.row, current.col, current.value);
    }
    // 'none' is the commit a click elsewhere caused. That click has already
    // chosen the new selection, so moving here would only drag it back.
    if (move !== 'none') {
      const position = visibleRows.indexOf(current.row);
      if (move === 'down') {
        moveTo(position + 1, current.col);
      } else if (move === 'right') {
        moveTo(position, current.col + 1);
      } else {
        moveTo(position, current.col - 1);
      }
      focusGrid();
    }
    suppressBlurRef.current = false;
  };

  const cancelEditing = () => {
    suppressBlurRef.current = true;
    setEditingCell(null);
    focusGrid();
    suppressBlurRef.current = false;
  };

  const copyCell = () => {
    if (!selected) {
      return;
    }
    const clipboard = (navigator as any).clipboard;
    if (!clipboard || !clipboard.writeText) {
      props.onError('The clipboard is not available here.');
      return;
    }
    clipboard
      .writeText(cellValue(rows, selected.row, selected.col))
      .catch(() => props.onError('Could not copy to the clipboard.'));
  };

  const pasteCell = () => {
    if (!selected || readOnly) {
      return;
    }
    const clipboard = (navigator as any).clipboard;
    if (!clipboard || !clipboard.readText) {
      props.onError('The clipboard is not available here.');
      return;
    }
    const target = selected;
    clipboard
      .readText()
      // One cell in, one cell out. Multi-cell paste is out of scope for
      // 1.32.0, and quietly rewriting the rows around the selection would be
      // the worst possible way to find that out.
      .then((text: string) => props.onSetCell(target.row, target.col, text))
      .catch(() => props.onError('Could not read the clipboard.'));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing || !selected) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const position = visibleRows.indexOf(selected.row);
    const key = event.key;

    if (key === 'ArrowDown') {
      event.preventDefault();
      moveTo(position + 1, selected.col);
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      moveTo(position - 1, selected.col);
      return;
    }
    if (key === 'ArrowRight') {
      event.preventDefault();
      moveTo(position, selected.col + 1);
      return;
    }
    if (key === 'ArrowLeft') {
      event.preventDefault();
      moveTo(position, selected.col - 1);
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      moveTo(mod ? 0 : position, 0);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      moveTo(mod ? visibleRows.length - 1 : position, width - 1);
      return;
    }
    if (mod && (key === 'c' || key === 'C')) {
      event.preventDefault();
      copyCell();
      return;
    }
    if (mod && (key === 'v' || key === 'V')) {
      event.preventDefault();
      pasteCell();
      return;
    }
    // Everything else with a modifier belongs to VS Code -- above all
    // Ctrl/Cmd+Z, which has to reach the custom text editor to undo.
    if (mod || readOnly) {
      return;
    }
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault();
      startEdit(selected.row, selected.col, false);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      props.onSetCell(selected.row, selected.col, '');
      return;
    }
    // A printable character starts an edit and REPLACES the value, the way a
    // spreadsheet does.
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      startEdit(selected.row, selected.col, true, key);
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const current = editingRef.current;
    if (!current) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEditing(current, 'down');
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      commitEditing(current, event.shiftKey ? 'left' : 'right');
    }
  };

  const onGutterMouseDown = (event: React.MouseEvent, row: number) => {
    // The grid keeps the keys after a row click, so the arrows still work.
    focusGrid();
    if (event.shiftKey && anchorRef.current !== null) {
      const anchor = anchorRef.current;
      const from = Math.min(anchor, row);
      const to = Math.max(anchor, row);
      const range: number[] = [];
      for (let r = from; r <= to; r += 1) {
        if (visibleRows.indexOf(r) !== -1) {
          range.push(r);
        }
      }
      props.onSelectRows(range);
      return;
    }
    // A click without shift is what the next shift-click extends from.
    anchorRef.current = row;
    if (event.ctrlKey || event.metaKey) {
      props.onSelectRows(
        selectedRows.indexOf(row) === -1
          ? selectedRows.concat([row])
          : selectedRows.filter(r => r !== row)
      );
      return;
    }
    props.onSelectRows([row]);
  };

  const beginResize = (event: React.MouseEvent, col: number, startWidth: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const onMove = (move: MouseEvent) => {
      setOverrides(current => {
        const next: { [col: number]: number } = { ...current };
        next[col] = Math.max(MIN_COL_WIDTH, startWidth + (move.clientX - startX));
        return next;
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (props.editRequest) {
      startEdit(props.editRequest.row, props.editRequest.col, false);
      props.onEditRequestHandled();
    }
  }, [props.editRequest]);

  if (width === 0) {
    return (
      <div className="csv-grid csv-grid-empty">
        <p className="csv-hint">This file is empty. Use <strong>Add Row</strong> to start it.</p>
      </div>
    );
  }

  return (
    <div className="csv-grid" ref={gridRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="csv-scroll" ref={setScrollEl}>
        <div className="csv-table" style={{ width: totalWidth }}>
          <div className="csv-head" style={{ height: ROW_HEIGHT }}>
            <div className="csv-gutter csv-gutter-head" style={{ width: GUTTER_WIDTH }} />
            {widths.map((w, col) => (
              <div
                className="csv-header-cell"
                key={col}
                style={{ width: w }}
                onClick={() => props.onHeaderClick(col)}
                onContextMenu={event => {
                  event.preventDefault();
                  props.onHeaderMenu(col, event.clientX, event.clientY);
                }}
              >
                <span className="csv-header-label">{headers[col]}</span>
                {sort && sort.col === col ? (
                  <span className="csv-sort">{sort.direction === 'asc' ? '▲' : '▼'}</span>
                ) : null}
                <span
                  className="csv-resize"
                  onMouseDown={event => beginResize(event, col, w)}
                  onClick={event => event.stopPropagation()}
                />
              </div>
            ))}
          </div>

          <div className="csv-body" style={{ height: visibleRows.length * ROW_HEIGHT }}>
            <div
              className="csv-window"
              style={{ transform: `translateY(${view.padTop}px)` }}
            >
              {visibleRows.slice(view.start, view.end).map(row => (
                <div
                  className={
                    'csv-row' + (selectedRows.indexOf(row) !== -1 ? ' csv-row-selected' : '')
                  }
                  key={row}
                  style={{ height: ROW_HEIGHT }}
                >
                  <div
                    className="csv-gutter"
                    style={{ width: GUTTER_WIDTH }}
                    onMouseDown={event => onGutterMouseDown(event, row)}
                    onContextMenu={event => {
                      event.preventDefault();
                      if (selectedRows.indexOf(row) === -1) {
                        props.onSelectRows([row]);
                      }
                      props.onRowMenu(row, event.clientX, event.clientY);
                    }}
                  >
                    {row + 1}
                  </div>
                  {widths.map((w, col) => {
                    const isEditing = editing !== null && editing.row === row && editing.col === col;
                    const isSelected =
                      selected !== null && selected.row === row && selected.col === col;
                    return (
                      <div
                        className={'csv-cell' + (isSelected ? ' csv-cell-selected' : '')}
                        key={col}
                        style={{ width: w }}
                        onMouseDown={() => {
                          if (!isEditing) {
                            setSelected({ row, col });
                            focusGrid();
                          }
                        }}
                        onDoubleClick={() => startEdit(row, col, false)}
                      >
                        {isEditing ? (
                          <input
                            className="csv-input"
                            autoFocus
                            value={editing!.value}
                            onChange={event =>
                              setEditingCell({ row, col, value: event.target.value })
                            }
                            onKeyDown={onInputKeyDown}
                            onBlur={() => {
                              if (suppressBlurRef.current) {
                                // We moved focus ourselves; the commit or the
                                // cancel has already run.
                                suppressBlurRef.current = false;
                                return;
                              }
                              const current = editingRef.current;
                              if (current) {
                                commitEditing(current, 'none');
                              }
                            }}
                          />
                        ) : (
                          <CellText
                            value={cellValue(rows, row, col)}
                            query={query}
                            matchCase={matchCase}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
