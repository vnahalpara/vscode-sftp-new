# Manage Server — Database tab (design)

**Status:** approved 2026-08-20. Scope decided by the user: **full parity** with the
existing VS Code data browser (browse, sort, filter, page, edit, delete, raw SQL,
export), not a read-only first cut.

## Why full parity is the right call

The read-only lean recorded in `docs/superpowers/notes/database-tab-recon.md` rested
on "the dashboard is reachable from a plain browser tab, so writes are a bigger step
than reads". That argument does not survive contact with the shipped product: the
dashboard already carries a **Terminal** tab bridged to a real SSH shell as the
profile's own user. Anyone holding the session token can already type `mysql` at that
shell. Row edits and a SQL runner are therefore a better *interface* to a capability
the token already confers, not a new privilege.

What that does NOT excuse is sloppiness in the new surface. The threat we are actually
defending against is not "an attacker with the token" — that is already game over — it
is **the authenticated user's own mistakes** (a DELETE with no WHERE, a page-size of
2,000,000) and **the server's own leaks** (a database password reaching the activity
log). Those are what the constraints below are aimed at.

## What already exists

`src/core/` already contains a working MySQL/MariaDB engine used by the VS Code panel:

| File | Role |
|---|---|
| `dbClient.ts` | `DbClient`: connects per `database[]` entry over SSH. Prefers a forwarded TCP stream (real mysql2 protocol); falls back to piping SQL into the `mysql` CLI over an exec channel when the host disables forwarding. `listTables`, `listColumns`, `textColumns`, `query(sql, params)`. |
| `dbQuery.ts` | Pure builders: `buildWhere`, `buildOrderBy`, `buildSelect`, `buildUpdate`, `buildDelete`, `buildCount`. |
| `dbSql.ts` | Pure: `splitStatements`, `applyDefaultLimit`, `isMutating`, `hasWhere`. |
| `dbSearch.ts` | `quoteId` (backtick escaping) and cross-table search. |
| `dbExec.ts` | `buildMysqlCommand`, `buildMysqldumpCommand`, `buildTableDumpCommand`, `parseMysqlBatch`, `mysqlError`. |
| `dbConnectionManager.ts` | `getDbClient(fileService, config, dbConfig)` — one client per (connection, database). |
| `dbExport.ts` | Dump on the server, gzip, pull back over SFTP. |

The Database tab is therefore an **exposure** job, not a build-from-scratch: put the
existing engine behind the dashboard's HTTP surface and render a grid.

## Architecture

```
browser  ──HTTP+token──>  routes.ts  /api/db/*
                              │
                              ├─ ops/db.ts        pure validation & planning (no I/O)
                              └─ dbAccess.ts      session-scoped: which databases, which client
                                      │
                                      └─ core/dbConnectionManager.getDbClient(...)
                                              └─ core/dbClient.DbClient  ──SSH──> MySQL
```

Three new server modules, mirroring how the Cloudflare and log features are split:

- **`ops/db.ts`** — pure. Every decision that can be made without I/O: is this table
  in the allowlist, is this column real, is this page size sane, does this raw SQL
  statement need a confirmation, what does the request translate to in `dbQuery`
  builder terms. Unit-testable with no SSH and no database.
- **`dbAccess.ts`** — the session-scoped adapter. Holds the profile's `database[]`
  array, hands out stable ids, resolves an id to a `DbClient`, and answers "what may
  the browser be told about these databases" (name and label — never credentials).
- **`dbExportStream.ts`** — the browser download path: dump to a gzip on the server,
  stream it back through the HTTP response, always clean the temp file up.

### Session wiring

`ManagedSession` gains a `readonly db: DbAccess`, wired in `ensureSession` exactly the
way `cloudflareConfig` is: built from the raw config, never reachable from `state()`.
`DbAccess` closes over `fileService` and `config` so no database password is ever
stored as a field on the session object.

### Identity

Databases are addressed by a **stable id derived from position**: `db0`, `db1`, …
matching the `database[]` array order. A name is not usable as the key (two entries may
legitimately share a `name` on different hosts, and a label is free text). The id is
opaque to the browser; `GET /api/db` returns the mapping.

## HTTP surface

All routes require the session token, like every other `/api/*` route. All return the
existing `resolve()` 404 when the session is gone.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/db` | — | `{ databases: [{id, name, label}] }` |
| GET | `/api/db/:id/tables` | — | `{ tables: string[] }` |
| GET | `/api/db/:id/tables/:table/columns` | — | `{ columns: ColumnInfo[] }` |
| POST | `/api/db/:id/tables/:table/rows` | `{sort, filter, limit, offset}` | `{columns, rows, total, durationMs, truncated}` |
| POST | `/api/db/:id/tables/:table/update` | `{set, where, usingPk}` | `{ok, affectedRows}` |
| POST | `/api/db/:id/tables/:table/delete` | `{where, usingPk}` | `{ok, affectedRows}` |
| POST | `/api/db/:id/sql` | `{sql, confirm, confirmUnfiltered}` | `{results: [...]}` or `{needsConfirm, reason}` |
| GET | `/api/db/:id/export` | `?table=` (optional) | `application/gzip` attachment stream |

`CAPABILITIES.database` in `routes.ts` flips from `false` to `true` in the same task
that lands the routes — not earlier, so a partially-built tab is never reachable.

## Safety requirements

These are requirements, not suggestions. Each one exists because the obvious
implementation gets it wrong.

### 1. The database password must never reach the activity log

`buildMysqlCommand` and `buildMysqldumpCommand` both embed `MYSQL_PWD='<password>'`
literally in the command string. The activity log is serialised to the browser over
`GET /api/activity` **and** written to the VS Code output channel. A DB route that
logs its command the way `runPrivileged` does would leak the database password to both.
Every activity entry from a DB route logs a **description** (`select from wp_posts`,
`export database shop`), never a built command string. This is the same class of bug as
the Cloudflare token leak fixed in 1.27.0, and it must not be re-introduced.

### 2. Identifiers come from an allowlist, not from the request

`quoteId` correctly escapes backticks, and is not the thing being relied on here.
Every table name in a path, and every column name in a sort, filter, `set` or `where`,
is checked against the live `listTables()` / `listColumns()` answer for that database
before any SQL is built. An unknown identifier is a 400, not a query.

### 3. LIMIT and OFFSET are interpolated, so they must be integers

`buildSelect` splices `limit` and `offset` into the SQL directly (they cannot be
parameters in MySQL prepared statements). The route coerces both with `Number`,
rejects anything non-integer or negative, and caps `limit` at **500**.

### 4. UPDATE and DELETE need a row identity and a LIMIT

A `where` object that is empty, or whose keys are not all real columns, is a 400.
When the row was identified by its primary key, no limit is needed; when it was
identified by matching all its columns (`usingPk: false`), `LIMIT 1` is mandatory —
`buildUpdate`/`buildDelete` already take that flag, and the route must pass it.

### 5. Mutating raw SQL requires an explicit confirmation flag

`POST /api/db/:id/sql` runs `splitStatements`, then `applyDefaultLimit` on bare
SELECTs. If any statement `isMutating`, the request must carry `confirm: true`; if any
mutating statement additionally lacks a WHERE, it must carry `confirmUnfiltered: true`.
Without them the route returns `200 {needsConfirm, reason, statements}` and runs
nothing. The browser renders the confirmation; the server enforces it. The check is
server-side so a stale or scripted client cannot skip it.

### 6. The exec transport's parameter inlining must be mode-independent

`DbClient._inline` escapes `'` as `\'`. Under `sql_mode=NO_BACKSLASH_ESCAPES` a
backslash is not an escape character, so that produces a syntax error at best and an
injection at worst. Strings are inlined as a hex literal with an explicit character-set
introducer instead — `_utf8mb4 X'<hex>'` — which is exact and identical under both
modes, and avoids the illegal-mix-of-collations a bare `X'…'` risks against a utf8mb4
column. This fixes the VS Code panel at the same time; it shares the code.

### 7. Cell values are capped

A single `longblob` or `longtext` cell can be megabytes, and a 500-row page of them
would be serialised into one JSON response held entirely in the extension host's heap.
Cell values are truncated server-side at **64 KiB**, with the response carrying a
`truncated` flag so the grid can say so rather than silently showing a clipped value.

### 8. The export temp file is always cleaned up

The download stages `<remotePath>/.sftp-db-export-tmp/<random>.sql.gz` on the server,
streams it back, and removes it in a `finally` — including when the browser aborts the
download mid-stream, which is the case the VS Code path never had to handle.

## UI

A new `Database` tab in the server tab bar, plus the existing (currently disabled)
`Database` sidebar entry, which navigates to the same tab.

Layout: a database picker and a table list on the left; the grid on the right, with a
filter row, sortable headers, pagination, and an inline cell editor. A collapsible SQL
runner sits under the grid. Export buttons for "this table" and "whole database".

The tab is added to `PERSISTENT_TABS` in `App.jsx`. It holds no live socket, but it
holds a lot of state a user does not want to retype — selected database, selected
table, filter, sort, page — and losing it on a tab switch is the same annoyance the
user reported for Terminal in 1.26.1.

## Out of scope

- **Cross-table search** (`dbSearch.ts`). It is progressive and wants a streaming
  channel; it is not part of the parity list the user named. The VS Code command
  palette keeps it.
- **Schema changes** (CREATE/ALTER/DROP through a UI). The SQL runner can express them
  behind the confirmation gate; no dedicated UI.
- **Postgres.** The engine is MySQL/MariaDB only, and this changes nothing about that.
