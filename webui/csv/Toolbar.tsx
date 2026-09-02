import * as React from 'react';

export interface ToolbarProps {
  readOnly: boolean;
  hasHeader: boolean;
  canDeleteRows: boolean;
  canAddColumn: boolean;
  status: string;
  matchText: string;
  onAddRow(): void;
  onDeleteRows(): void;
  onAddColumn(): void;
  onToggleHeader(): void;
  onOpenAsText(): void;
  // The search and replace controls slot in here, so adding them does not
  // change this file.
  children?: any;
}

export default function Toolbar(props: ToolbarProps) {
  return (
    <div className="csv-toolbar">
      <button
        className="csv-button"
        disabled={props.readOnly}
        onClick={props.onAddRow}
        title="Insert a row after the selection, or at the end"
      >
        Add Row
      </button>
      <button
        className="csv-button"
        disabled={props.readOnly || !props.canDeleteRows}
        onClick={props.onDeleteRows}
      >
        Delete Rows
      </button>
      <button
        className="csv-button"
        disabled={props.readOnly || !props.canAddColumn}
        onClick={props.onAddColumn}
      >
        Add Column
      </button>
      <label className="csv-toggle" title="Show the first row as column headers">
        <input type="checkbox" checked={props.hasHeader} onChange={props.onToggleHeader} />
        Header row
      </label>

      {props.children}

      <span className="csv-spacer" />
      {props.matchText ? <span className="csv-match-count">{props.matchText}</span> : null}
      <span className="csv-status">{props.status}</span>
      <button className="csv-button" onClick={props.onOpenAsText} title="Open the raw text in the editor">
        Open as Text
      </button>
    </div>
  );
}
