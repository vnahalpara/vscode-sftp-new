import { ColumnInfo, DatabaseConfig, DbClient } from '../../core/dbClient';

// What the browser is told about a configured database: enough to name it in a
// picker, and nothing else. This object is serialised straight over
// GET /api/db -- the same contract RedactedProfile (registry.ts) upholds, and
// for the same reason: it is built fresh from named fields, never by stripping
// keys off the raw config, so a new credential field cannot leak by omission.
//
// `id` is positional into the FILTERED `database[]` array (see `indexOfId`
// below), not the raw one from sftp.json. If a config edit later fixes a
// previously-invalid entry, every id after it shifts -- ids are not stable
// across a config edit, which is fine because the browser only ever learns
// the current mapping from a fresh list().
export interface DbDescriptor {
  id: string;
  name: string;
  label: string;
}

export interface DbAccess {
  // Browser-safe surface: nothing these return may carry a credential.
  list(): DbDescriptor[];
  client(id: string): DbClient | null;
  tables(id: string): Promise<string[]>;
  columns(id: string, table: string): Promise<ColumnInfo[]>;

  // Credential-bearing. `config(id)` returns the raw DatabaseConfig,
  // PASSWORD INCLUDED. It exists only for server-side code that has to build
  // an out-of-process invocation from the real credentials -- e.g. a future
  // export route shelling out to `mysqldump` -- where a DbClient's own
  // in-process connection is not what's needed. Its return value must never
  // be serialised to the browser, written to the activity log, or passed to
  // anything that logs its argument (see global-constraints.md #1: activity
  // entries are a description, never a command string, for exactly this
  // reason). Contrast with list(), which is the one method above this line
  // that is actually safe to hand to a route that answers the browser.
  config(id: string): DatabaseConfig | null;
}

// Ids are positional (`db0`, `db1`, ...) and match the FILTERED `database[]`
// array returned by normaliseDatabases, in order -- not the raw array as
// written in sftp.json. An invalid entry earlier in the file is dropped
// before ids are assigned, so `db0` need not be `database[0]`, and ids
// renumber if a previously-invalid entry is fixed in a later edit. Ids are
// not the name either: two entries may legitimately share a `name` (the same
// schema name on a different host), and `label` is free text. The id is
// opaque to the browser, which learns the current mapping from list().
const ID_PATTERN = /^db(0|[1-9][0-9]*)$/;

function indexOfId(id: string, count: number): number {
  const match = ID_PATTERN.exec(String(id || ''));
  if (!match) {
    return -1;
  }
  const index = Number(match[1]);
  return index < count ? index : -1;
}

// A `database[]` entry missing a username, password or name field entirely
// cannot open a connection; surfacing it would put a picker entry in the UI
// whose every request fails with a driver error. This checks that the three
// fields are STRINGS, not that they are non-empty: an empty password is a
// legitimate, intentionally-accepted config (a local/dev MySQL with no
// password set) -- config.ts declares it `Joi.string().required().allow('')`
// for exactly that case, and rejecting it here would break real profiles.
// (`name` alone is checked for non-empty, since an unnamed database can't be
// selected in SQL.) A config can reach this function from a hand-edited file
// that failed Joi validation earlier in the load, so this filters rather than
// trusts.
export function normaliseDatabases(config: any): DatabaseConfig[] {
  const raw = config && config.database;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry: any) =>
      entry &&
      typeof entry.name === 'string' &&
      entry.name !== '' &&
      typeof entry.username === 'string' &&
      typeof entry.password === 'string'
  );
}

// `open` is injected rather than importing getDbClient directly so this whole
// module is testable without an SSH connection -- index.ts supplies the real
// one, which closes over fileService and config.
export function createDbAccess(
  databases: DatabaseConfig[],
  open: (dbConfig: DatabaseConfig) => DbClient
): DbAccess {
  function configFor(id: string): DatabaseConfig | null {
    const index = indexOfId(id, databases.length);
    return index === -1 ? null : databases[index];
  }

  function clientFor(id: string): DbClient | null {
    const dbConfig = configFor(id);
    return dbConfig ? open(dbConfig) : null;
  }

  function require(id: string): DbClient {
    const client = clientFor(id);
    if (!client) {
      throw new Error(`No database "${id}" is configured for this profile.`);
    }
    return client;
  }

  return {
    list: () =>
      databases.map((dbConfig, index) => ({
        id: `db${index}`,
        name: dbConfig.name,
        label: dbConfig.label || dbConfig.name,
      })),
    // Returns a DbClient, not a plain value. TypeScript's `private` on
    // DbClient.dbConfig is compile-time only -- it is a normal enumerable
    // runtime property -- so JSON.stringify(access.client(id)) prints the
    // password same as config() would. Never serialise, log, or otherwise
    // stringify what this returns.
    client: clientFor,
    tables: async id => require(id).listTables(),
    columns: async (id, table) => require(id).listColumns(table),
    config: configFor,
  };
}

// The access a session with no `database[]` gets. Exported so every existing
// ManagedSession construction site (and every existing test) keeps working
// without being edited.
export const NO_DATABASES: DbAccess = createDbAccess([], () => {
  throw new Error('No databases are configured for this profile.');
});
