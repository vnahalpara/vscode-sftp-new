# Database tab — reconnaissance (banked 2026-08-19)

Found incidentally by an agent exploring for the Database milestone. Verify before
relying on it; recorded so the finding is not lost.

## The gap is narrower than "build a database manager"

This codebase ALREADY has a working database manager, wired into VS Code's command
palette and the "Databases" sidebar tree. It is simply not surfaced in the browser
dashboard:

- `src/core/dbClient.ts` — connects over SSH per `database` config entry, preferring
  an SSH TCP-forward (real mysql2 protocol) and falling back to running the `mysql`
  CLI over an SSH exec channel when the host disables forwarding (shared/cPanel).
- `src/core/dbQuery.ts` / `dbSql.ts` / `dbSearch.ts` — paged/sorted/filtered SELECT,
  UPDATE/DELETE keyed by row identity, a raw-SQL runner with mutation and
  WHERE-less guardrails, cross-column search.
- `src/modules/dbDataBrowser/index.ts` (~669 lines) — the Adminer-style UI.
- `src/modules/dbExport.ts` + two commands — CSV/SQL export.
- The profile's `database` array already supports multiple entries.

So the Database milestone is mostly: expose the existing engine over the dashboard's
HTTP/WS surface, and flip `CAPABILITIES.database` (hard-coded `false` in routes.ts,
with a disabled nav item already waiting).

## Open design question for that milestone

Full parity (browse + sort/filter/page + edit/delete + raw SQL + export) vs a
read-only v1 (pick database -> browse tables -> view/page/filter).

MY LEAN: read-only first. The dashboard is reachable from a plain browser tab, not
just inside VS Code, and it points at what is usually a production database. The
existing VS Code panel has a different threat model -- it lives behind the editor.
Shipping write access and a raw-SQL runner to a browser surface is a materially
bigger step than shipping the read path, and it can follow once the read path has
been reviewed. This is the user's call, not mine, and should be ASKED at the start
of that milestone rather than assumed.

## Sequencing note
The Cloudflare purge plan is already written
(docs/superpowers/plans/2026-08-19-cloudflare-cache-purge.md) and is smaller. The
Database tab should get its own brainstorm/spec pass first given the scope above.
