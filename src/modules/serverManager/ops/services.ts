// Pure parsing/sorting/filtering for `systemctl` output, ported from
// Server-manager/server/ops.js's `listServices` (lines 24-67). This file
// does no I/O and runs no shell command itself -- `command.ts`
// (`servicesCommand`) builds the remote command and `splitAt` frames its
// two `@@units` / `@@files` sections; the caller (Task 4) is responsible for
// running the command and handing each section's text to the functions
// below.

export interface ServiceRow {
  unit: string;
  name: string;
  load: string;
  active: string;
  sub: string;
  enabled: string;
  description: string;
}

// systemd prefixes a FAILED unit's line with a `●` bullet on some versions,
// even under `--plain --no-legend`. The reference implementation this file
// ports does not strip it, which means the bullet becomes field 0 of the
// naive whitespace split and the real unit name becomes field 1 -- the
// row's `unit` ends up as the bullet itself, fails the `.service` suffix
// check below, and the failed unit silently vanishes from the listing. That
// is exactly backwards: a failed unit is the thing an operator opened this
// tab to find, so the bullet (and any whitespace after it) is stripped
// before splitting.
const BULLET_PREFIX_RE = /^\s*●\s*/;

/** Parse `systemctl list-units --type=service --all --plain --no-legend` output. */
export function parseUnits(text: string): ServiceRow[] {
  const rows: ServiceRow[] = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(BULLET_PREFIX_RE, '').trim();
    if (!line) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length < 4) {
      continue;
    }
    const unit = fields[0];
    if (unit.slice(-'.service'.length) !== '.service') {
      continue;
    }
    const load = fields[1];
    const active = fields[2];
    const sub = fields[3];
    const description = fields.slice(4).join(' ');
    rows.push({
      unit,
      name: unit.slice(0, -'.service'.length),
      load,
      active,
      sub,
      enabled: 'unknown',
      description,
    });
  }
  return rows;
}

/** Parse `systemctl list-unit-files --type=service --plain --no-legend` output. */
export function parseUnitFiles(text: string): { [unit: string]: string } {
  const files: { [unit: string]: string } = Object.create(null);
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length < 2) {
      continue;
    }
    files[fields[0]] = fields[1];
  }
  return files;
}

/** Fill in each row's `enabled` state from the unit-files map; 'unknown' if absent. */
export function mergeServices(units: ServiceRow[], files: { [unit: string]: string }): ServiceRow[] {
  return units.map(row => {
    const enabled = Object.prototype.hasOwnProperty.call(files, row.unit) ? files[row.unit] : 'unknown';
    return { ...row, enabled };
  });
}

// Running first, then failed, then alphabetical -- the things you act on
// are at the top. `failed` ranks above `inactive` deliberately: a failed
// unit is what an operator opened this tab to find.
function activeRank(row: ServiceRow): number {
  if (row.active === 'active') {
    return 0;
  }
  if (row.active === 'failed') {
    return 1;
  }
  return 2;
}

/** Sort by active-state group (active, failed, other), alphabetical within each group. */
export function sortServices(rows: ServiceRow[]): ServiceRow[] {
  return rows.slice().sort((a, b) => {
    const rankDiff = activeRank(a) - activeRank(b);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
  });
}

/** Case-insensitive substring match against the unit name or description; empty needle matches all. */
export function filterServices(rows: ServiceRow[], needle: string): ServiceRow[] {
  const trimmed = (needle || '').trim().toLowerCase();
  if (!trimmed) {
    return rows.slice();
  }
  return rows.filter(row =>
    row.unit.toLowerCase().indexOf(trimmed) !== -1 || row.description.toLowerCase().indexOf(trimmed) !== -1
  );
}
