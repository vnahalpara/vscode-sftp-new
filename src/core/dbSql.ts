// Pure SQL helpers (no I/O) so they are unit-testable.

// One classified chunk of a scan over a SQL script. `closed` (quote and
// blockComment only) says whether the construct actually terminated inside
// the input (a real closing quote / `*/`) as opposed to running off the end
// of the string unterminated -- stripLiterals needs that distinction to know
// whether a trailing delimiter exists to preserve.
type SqlChunk =
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string; closed: boolean }
  | { kind: 'lineComment'; text: string }
  | { kind: 'blockComment'; text: string; closed: boolean };

// Walks a SQL script once, classifying every character as belonging to a
// quoted string/identifier (`'…'`, `"…"`, `` `…` ``, respecting doubled-quote
// escapes and, outside backticks, backslash escapes), a `--`/`#` line comment,
// a `/* … */` block comment, or plain code. splitStatements and stripLiterals
// both build on this single scanner rather than each re-implementing the same
// quote/comment rules -- see the ADDED REQUIREMENT in task 6's brief for why
// a second, subtly different scanner is exactly what must not happen here.
function scanSql(sql: string, onChunk: (chunk: SqlChunk) => void): void {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      let text = ch;
      let closed = false;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        const n = sql[i + 1];
        if (c === quote) {
          text += c;
          // handle doubled-quote escape
          if (n === quote) {
            text += n;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (c === '\\' && quote !== '`') {
          // backslash escape inside '...' / "..."
          text += c + (n || '');
          i += 2;
          continue;
        }
        text += c;
        i++;
      }
      onChunk({ kind: 'quote', text, closed });
      continue;
    }

    // line comments
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      onChunk({ kind: 'lineComment', text: sql.slice(i, end) });
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      onChunk({ kind: 'blockComment', text: sql.slice(i, end), closed: close !== -1 });
      i = end;
      continue;
    }

    // Plain code: run up to whatever quote/comment starts next.
    let j = i;
    while (j < sql.length) {
      const c = sql[j];
      const n = sql[j + 1];
      if (c === '\'' || c === '"' || c === '`') {
        break;
      }
      if ((c === '-' && n === '-') || c === '#') {
        break;
      }
      if (c === '/' && n === '*') {
        break;
      }
      j++;
    }
    onChunk({ kind: 'code', text: sql.slice(i, j) });
    i = j;
  }
}

// Split a script into individual statements on `;`, respecting string/identifier
// quotes and -- , # and /* */ comments.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  scanSql(sql, chunk => {
    if (chunk.kind !== 'code') {
      current += chunk.text;
      return;
    }
    const text = chunk.text;
    let start = 0;
    for (let k = 0; k < text.length; k++) {
      if (text[k] === ';') {
        current += text.slice(start, k);
        if (current.trim()) {
          statements.push(current.trim());
        }
        current = '';
        start = k + 1;
      }
    }
    current += text.slice(start);
  });

  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements;
}

// Returns `statement` with the CONTENTS of every string/identifier literal
// and every comment replaced by spaces -- the delimiters themselves ('/" /`
// pairs, `--`/`#`, `/*`/`*/`) are left in place, as is every other character,
// and the result is always the same length as the input. This is what lets
// hasWhere (below) tell a real `WHERE` clause from the word "where" sitting
// inside a string literal or a comment, without having to re-parse anything:
// a plain `\bwhere\b` regex over the stripped text cannot match text that
// used to be quoted or commented out, because that text is now spaces.
export function stripLiterals(sql: string): string {
  let out = '';
  scanSql(sql, chunk => {
    if (chunk.kind === 'code') {
      out += chunk.text;
      return;
    }
    if (chunk.kind === 'quote') {
      const text = chunk.text;
      out +=
        chunk.closed && text.length >= 2
          ? text[0] + ' '.repeat(text.length - 2) + text[text.length - 1]
          : text[0] + ' '.repeat(Math.max(0, text.length - 1));
      return;
    }
    if (chunk.kind === 'lineComment') {
      const text = chunk.text;
      // `--` is a two-character marker, `#` a one-character one -- either
      // way everything after it (up to the newline, which is not part of
      // this chunk) is content.
      const markerLen = text.slice(0, 2) === '--' ? 2 : 1;
      out += text.slice(0, markerLen) + ' '.repeat(Math.max(0, text.length - markerLen));
      return;
    }
    // blockComment
    const text = chunk.text;
    out +=
      chunk.closed && text.length >= 4
        ? text.slice(0, 2) + ' '.repeat(text.length - 4) + text.slice(-2)
        : text.slice(0, 2) + ' '.repeat(Math.max(0, text.length - 2));
  });
  return out;
}

// Append a LIMIT to a bare SELECT that has none. Leaves non-SELECT and already-limited queries alone.
export function applyDefaultLimit(statement: string, limit: number): string {
  const trimmed = statement.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed)) {
    return statement;
  }
  if (/\blimit\s+\d/i.test(trimmed)) {
    return statement;
  }
  if (/\binto\b/i.test(trimmed)) {
    return statement; // SELECT ... INTO
  }
  return `${trimmed} LIMIT ${limit}`;
}

export function isMutating(statement: string): boolean {
  return /^\s*(update|delete|insert|replace|drop|alter|truncate|create)\b/i.test(statement);
}

// Hardened per the ADDED REQUIREMENT in task 6's brief: tests the statement
// with every string literal's and every comment's contents blanked out, so
// "where" inside a quoted value or a comment can no longer be mistaken for a
// real WHERE clause and quietly satisfy the confirmationNeeded gate that
// exists specifically for unfiltered mutations (Global Constraint 5).
export function hasWhere(statement: string): boolean {
  return /\bwhere\b/i.test(stripLiterals(statement));
}
