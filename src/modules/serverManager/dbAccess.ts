import { ColumnInfo, DatabaseConfig, DbClient } from '../../core/dbClient';

// What the browser is told about a configured database: enough to name it in a
// picker, and nothing else. This object is serialised straight over
// GET /api/db -- the same contract RedactedProfile (registry.ts) upholds, and
// for the same reason: it is built fresh from named fields, never by stripping
// keys off the raw config, so a new credential field cannot leak by omission.
export interface DbDescriptor {
  id: string;
  name: string;
  label: string;
}

export interface DbAccess {
  list(): DbDescriptor[];
  config(id: string): DatabaseConfig | null;
  client(id: string): DbClient | null;
  tables(id: string): Promise<string[]>;
  columns(id: string, table: string): Promise<ColumnInfo[]>;
}

// Ids are positional (`db0`, `db1`, ...) and match the `database[]` array
// order. Not the name: two entries may legitimately share a `name` (the same
// schema name on a different host), and `label` is free text. The id is opaque
// to the browser, which learns the mapping from list().
const ID_PATTERN = /^db(0|[1-9][0-9]*)$/;

function indexOfId(id: string, count: number): number {
  const match = ID_PATTERN.exec(String(id || ''));
  if (!match) {
    return -1;
  }
  const index = Number(match[1]);
  return index < count ? index : -1;
}

// A `database[]` entry with no username, password or name cannot open a
// connection; surfacing it would put a picker entry in the UI whose every
// request fails with a driver error. Joi already requires all three, but a
// config can reach here from a hand-edited file that failed validation
// earlier in the load, so this filters rather than trusts.
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
    config: configFor,
    client: clientFor,
    tables: async id => require(id).listTables(),
    columns: async (id, table) => require(id).listColumns(table),
  };
}

// The access a session with no `database[]` gets. Exported so every existing
// ManagedSession construction site (and every existing test) keeps working
// without being edited.
export const NO_DATABASES: DbAccess = createDbAccess([], () => {
  throw new Error('No databases are configured for this profile.');
});
