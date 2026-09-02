import * as React from 'react';

export interface FindReplaceProps {
  query: string;
  onQuery(value: string): void;
  matchCase: boolean;
  onMatchCase(value: boolean): void;
  // null means every column.
  scopeCol: number | null;
  onScopeCol(value: number | null): void;
  headers: string[];
  replaceText: string;
  onReplaceText(value: string): void;
  onReplaceAll(): void;
  readOnly: boolean;
  inputRef: { current: HTMLInputElement | null };
}

export default function FindReplace(props: FindReplaceProps) {
  return (
    <span className="csv-find">
      <input
        ref={props.inputRef}
        className="csv-text"
        type="search"
        placeholder="Search (Ctrl F)"
        value={props.query}
        onChange={event => props.onQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onQuery('');
          }
        }}
      />
      <select
        className="csv-select"
        title="Which column to search"
        value={props.scopeCol === null ? 'all' : String(props.scopeCol)}
        onChange={event =>
          props.onScopeCol(event.target.value === 'all' ? null : Number(event.target.value))
        }
      >
        <option value="all">All columns</option>
        {props.headers.map((label, index) => (
          <option key={index} value={String(index)}>
            {label === '' ? String(index + 1) : label}
          </option>
        ))}
      </select>
      <button
        className={'csv-button csv-case' + (props.matchCase ? ' csv-on' : '')}
        title="Match case"
        onClick={() => props.onMatchCase(!props.matchCase)}
      >
        Aa
      </button>
      <input
        className="csv-text"
        type="text"
        placeholder="Replace"
        value={props.replaceText}
        disabled={props.readOnly}
        onChange={event => props.onReplaceText(event.target.value)}
      />
      {/* No confirmation: the match count is already on screen and undo is one
          keystroke. */}
      <button
        className="csv-button"
        disabled={props.readOnly || props.query === ''}
        title="Replace every match in scope, as one undoable change"
        onClick={props.onReplaceAll}
      >
        Replace All
      </button>
    </span>
  );
}
