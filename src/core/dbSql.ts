// Pure SQL helpers (no I/O) so they are unit-testable.

// Split a script into individual statements on `;`, respecting string/identifier
// quotes and -- , # and /* */ comments.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null; // ' " or `
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote) {
        // handle doubled-quote escape
        if (next === quote) {
          current += next;
          i += 2;
          continue;
        }
        quote = null;
      } else if (ch === '\\' && quote !== '`') {
        // backslash escape inside '...' / "..."
        current += next || '';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // line comments
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      i++;
      continue;
    }

    if (ch === ';') {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements;
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

export function hasWhere(statement: string): boolean {
  return /\bwhere\b/i.test(statement);
}
