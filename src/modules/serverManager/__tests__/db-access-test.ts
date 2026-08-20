import { createDbAccess, normaliseDatabases } from '../dbAccess';
import { DbClient } from '../../../core/dbClient';

const DBS = [
  { username: 'u1', password: 'p1', name: 'shop' },
  { username: 'u2', password: 'p2', name: 'blog', label: 'Blog (staging)' },
];

function accessWith(open: any = () => ({} as any)) {
  return createDbAccess(DBS as any, open);
}

describe('normaliseDatabases', () => {
  it('returns the configured databases', () => {
    expect(normaliseDatabases({ database: DBS })).toHaveLength(2);
  });

  it('returns an empty array when none are configured', () => {
    expect(normaliseDatabases({})).toEqual([]);
    expect(normaliseDatabases({ database: 'not-an-array' })).toEqual([]);
  });

  it('drops entries missing the fields a connection needs', () => {
    expect(normaliseDatabases({ database: [{ name: 'x' }] })).toEqual([]);
  });

  // A local/dev MySQL with no password set is a legitimate config --
  // config.ts declares database[].password `.required().allow('')` for
  // exactly this case. This must keep passing; do not "fix" it by requiring
  // a non-empty password.
  it('keeps an entry with an empty password', () => {
    const withBlankPassword = [{ username: 'u1', password: '', name: 'shop' }];
    expect(normaliseDatabases({ database: withBlankPassword })).toEqual(withBlankPassword);
  });
});

describe('createDbAccess.list', () => {
  it('gives each database a positional id', () => {
    expect(accessWith().list().map(d => d.id)).toEqual(['db0', 'db1']);
  });

  it('falls back to the name when no label is set', () => {
    expect(accessWith().list()[0].label).toBe('shop');
  });

  it('uses the label when one is set', () => {
    expect(accessWith().list()[1].label).toBe('Blog (staging)');
  });

  // The descriptor list is serialised straight to the browser. Same contract
  // RedactedProfile upholds: an allowlist of named fields, built fresh.
  it('never carries a username or password', () => {
    const json = JSON.stringify(accessWith().list());
    expect(json).not.toContain('p1');
    expect(json).not.toContain('u1');
  });
});

describe('createDbAccess.client', () => {
  it('opens a client for a known id', () => {
    const marker = { marker: true } as any;
    expect(accessWith(() => marker).client('db0')).toBe(marker);
  });

  it('returns null for an unknown id', () => {
    expect(accessWith().client('db9')).toBeNull();
    expect(accessWith().client('nonsense')).toBeNull();
  });

  // 'db1x' must not be parsed as 1, and '' must not be parsed as 0.
  it('rejects an id that is not exactly dbN', () => {
    expect(accessWith().client('db1x')).toBeNull();
    expect(accessWith().client('')).toBeNull();
    expect(accessWith().client('db-1')).toBeNull();
  });

  it('passes the matching config to the opener', () => {
    const seen: any[] = [];
    accessWith((cfg: any) => {
      seen.push(cfg);
      return {} as any;
    }).client('db1');
    expect(seen[0].name).toBe('blog');
  });

  // Documents a real hazard, not a mock artifact: DbClient.dbConfig is
  // TypeScript-`private` (compile-time only), so it is a plain enumerable
  // runtime property and JSON.stringify prints it -- same as config() would.
  // Callers of client() must never serialise what it returns.
  it('returns a client whose JSON form leaks the password (TS `private` is not runtime-private)', () => {
    const dbConfig = { username: 'u1', password: 'p1', name: 'shop' } as any;
    const realClient = new DbClient(dbConfig, async () => ({} as any));
    const access = createDbAccess([dbConfig], () => realClient);
    expect(JSON.stringify(access.client('db0'))).toContain('p1');
  });
});

describe('createDbAccess.config', () => {
  it('returns the entry for a known id', () => {
    expect(accessWith().config('db1')).toEqual(DBS[1]);
  });

  // Every id form client() rejects must be rejected here too -- config() is
  // the credential-bearing accessor, so it must be at least as strict.
  it('returns null for every id form client() rejects', () => {
    const access = accessWith();
    expect(access.config('db9')).toBeNull();
    expect(access.config('nonsense')).toBeNull();
    expect(access.config('db1x')).toBeNull();
    expect(access.config('')).toBeNull();
    expect(access.config('db-1')).toBeNull();
  });

  // Documentation-by-test: config() DOES carry the password. If a future
  // change redacts it here, this test fails and says why that is the wrong
  // layer -- list() is the redaction point; config() exists precisely so a
  // server-side caller (a future export route) can reach the real
  // credential. See the doc comment on DbAccess.config for the rules on
  // where its return value may go.
  it('carries the plaintext password -- this is intentional, see the doc comment on config()', () => {
    expect(accessWith().config('db0')?.password).toBe('p1');
  });
});

describe('createDbAccess.tables', () => {
  it('lists tables through the client', async () => {
    const access = accessWith(() => ({ listTables: async () => ['a', 'b'] } as any));
    await expect(access.tables('db0')).resolves.toEqual(['a', 'b']);
  });

  it('rejects for an unknown id', async () => {
    await expect(accessWith().tables('db9')).rejects.toThrow();
  });
});
