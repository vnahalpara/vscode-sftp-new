import { Delimiter, Eol } from './types';

// The wire format between the editor provider and the grid webview. Shared by
// BOTH sides: the host compiles it with webpack, the webview imports it from
// Vite by relative path. That means no `vscode` import, no Node API, and no
// `export ... from` re-export of a type (esbuild would turn one into a runtime
// re-export of a binding that does not exist and Rollup would fail).

export type SortDirection = 'asc' | 'desc';

export interface SetCellOp {
  type: 'setCell';
  row: number;
  col: number;
  value: string;
}

export interface InsertRowsOp {
  type: 'insertRows';
  at: number;
  count: number;
}

export interface DuplicateRowsOp {
  type: 'duplicateRows';
  rows: number[];
}

export interface DeleteRowsOp {
  type: 'deleteRows';
  rows: number[];
}

export interface InsertColumnOp {
  type: 'insertColumn';
  at: number;
}

export interface DeleteColumnOp {
  type: 'deleteColumn';
  col: number;
}

export interface SortOp {
  type: 'sort';
  col: number;
  direction: SortDirection;
  hasHeader: boolean;
}

export interface ReplaceAllOp {
  type: 'replaceAll';
  find: string;
  replace: string;
  // Absent means every column.
  col?: number;
  matchCase: boolean;
  hasHeader: boolean;
}

export type CsvOp =
  | SetCellOp
  | InsertRowsOp
  | DuplicateRowsOp
  | DeleteRowsOp
  | InsertColumnOp
  | DeleteColumnOp
  | SortOp
  | ReplaceAllOp;

export interface ReadyMessage {
  type: 'ready';
}

export interface OpMessage {
  type: 'op';
  // The document version the op was made against. The host rejects the op if
  // the document has moved on, because the webview's copy is then not the
  // document any more.
  base: number;
  op: CsvOp;
}

export interface OpenAsTextMessage {
  type: 'openAsText';
}

export type WebviewMessage = ReadyMessage | OpMessage | OpenAsTextMessage;

export interface TableMessage {
  type: 'table';
  revision: number;
  rows: string[][];
  delimiter: Delimiter;
  eol: Eol;
  readOnly: boolean;
  readOnlyReason?: string;
}

export interface AckMessage {
  type: 'ack';
  revision: number;
}

export interface TooLargeMessage {
  type: 'tooLarge';
  bytes: number;
  limit: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type HostMessage = TableMessage | AckMessage | TooLargeMessage | ErrorMessage;

export function delimiterLabel(delimiter: Delimiter): string {
  if (delimiter === ',') {
    return 'Comma';
  }
  if (delimiter === ';') {
    return 'Semicolon';
  }
  if (delimiter === '\t') {
    return 'Tab';
  }
  return 'Pipe';
}

export function eolLabel(eol: Eol): string {
  return eol === '\r\n' ? 'CRLF' : 'LF';
}
