import { createDbAccess, normaliseDatabases } from '../dbAccess';

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
