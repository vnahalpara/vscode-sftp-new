import { parseUnits, parseUnitFiles, mergeServices, sortServices, ServiceRow } from '../ops/services';
import {
  UNITS_TEXT, UNIT_FILES_TEXT, EMPTY_UNITS_TEXT, EMPTY_UNIT_FILES_TEXT,
} from '../__fixtures__/ops';

describe('parseUnits', () => {
  const rows = parseUnits(UNITS_TEXT);

  it('parses an ordinary healthy unit', () => {
    const nginx = rows.filter(r => r.unit === 'nginx.service')[0];
    expect(nginx).toEqual({
      unit: 'nginx.service',
      name: 'nginx',
      load: 'loaded',
      active: 'active',
      sub: 'running',
      enabled: 'unknown',
      description: 'A high performance web server',
    });
  });

  it('strips a leading bullet prefix from a failed unit rather than dropping the line', () => {
    const sshd = rows.filter(r => r.unit === 'sshd.service')[0];
    expect(sshd).toBeDefined();
    expect(sshd.unit).toBe('sshd.service');
    expect(sshd.load).toBe('loaded');
    expect(sshd.active).toBe('failed');
    expect(sshd.sub).toBe('failed');
    expect(sshd.description).toBe('OpenSSH server daemon');
  });

  it('parses a not-found load state', () => {
    const bogus = rows.filter(r => r.unit === 'bogus.service')[0];
    expect(bogus.load).toBe('not-found');
    expect(bogus.active).toBe('inactive');
    expect(bogus.sub).toBe('dead');
  });

  it('parses a templated unit, keeping the @ instance syntax intact', () => {
    const getty = rows.filter(r => r.unit === 'getty@tty1.service')[0];
    expect(getty).toBeDefined();
    expect(getty.name).toBe('getty@tty1');
    expect(getty.description).toBe('Getty on tty1');
  });

  it('skips a non-.service unit entirely', () => {
    expect(rows.some(r => r.unit === 'cron.timer')).toBe(false);
    expect(rows.some(r => r.unit.indexOf('cron.timer') !== -1)).toBe(false);
  });

  it('collapses multiple consecutive spaces inside the description text', () => {
    const cron = rows.filter(r => r.unit === 'cron.service')[0];
    expect(cron.description).toBe('Regular background program');
  });

  it('skips a malformed line with fewer than four fields, not a row of undefineds', () => {
    expect(rows.some(r => r.unit === 'brokenline.service')).toBe(false);
    rows.forEach(r => {
      expect(r.unit).not.toBeUndefined();
      expect(r.load).not.toBeUndefined();
      expect(r.active).not.toBeUndefined();
      expect(r.sub).not.toBeUndefined();
    });
  });

  it('defaults enabled to unknown -- parseUnits has no unit-file data to draw on', () => {
    rows.forEach(r => expect(r.enabled).toBe('unknown'));
  });

  it('returns exactly the five valid, well-formed .service rows from the fixture', () => {
    expect(rows.map(r => r.unit).sort()).toEqual(
      ['bogus.service', 'cron.service', 'getty@tty1.service', 'nginx.service', 'sshd.service'].sort()
    );
  });

  it('returns an empty array for a completely empty listing', () => {
    expect(parseUnits(EMPTY_UNITS_TEXT)).toEqual([]);
  });
});

describe('parseUnitFiles', () => {
  const files = parseUnitFiles(UNIT_FILES_TEXT);

  it('maps each unit to its enabled state', () => {
    expect(files['nginx.service']).toBe('enabled');
    expect(files['sshd.service']).toBe('disabled');
    expect(files['getty@tty1.service']).toBe('enabled');
  });

  it('skips a malformed line with fewer than two fields', () => {
    expect(Object.keys(files)).not.toContain('garbageline');
    expect(Object.keys(files).length).toBe(3);
  });

  it('returns an empty object for a completely empty listing', () => {
    expect(parseUnitFiles(EMPTY_UNIT_FILES_TEXT)).toEqual({});
  });
});

describe('mergeServices', () => {
  const units = parseUnits(UNITS_TEXT);
  const files = parseUnitFiles(UNIT_FILES_TEXT);
  const merged = mergeServices(units, files);

  it('fills in the enabled state for a unit present in list-unit-files', () => {
    const nginx = merged.filter(r => r.unit === 'nginx.service')[0];
    expect(nginx.enabled).toBe('enabled');
    const sshd = merged.filter(r => r.unit === 'sshd.service')[0];
    expect(sshd.enabled).toBe('disabled');
  });

  it('leaves enabled as unknown for a unit present in list-units but absent from list-unit-files', () => {
    const cron = merged.filter(r => r.unit === 'cron.service')[0];
    expect(cron.enabled).toBe('unknown');
    const bogus = merged.filter(r => r.unit === 'bogus.service')[0];
    expect(bogus.enabled).toBe('unknown');
  });

  it('does not mutate its inputs', () => {
    expect(units.every(r => r.enabled === 'unknown')).toBe(true);
  });
});

describe('sortServices', () => {
  it('puts active first, then failed, then everything else, alphabetical within each group', () => {
    const units = parseUnits(UNITS_TEXT);
    const files = parseUnitFiles(UNIT_FILES_TEXT);
    const sorted = sortServices(mergeServices(units, files));
    expect(sorted.map(r => r.unit)).toEqual([
      'cron.service',        // active, alphabetically first among active
      'getty@tty1.service',  // active
      'nginx.service',       // active
      'sshd.service',        // failed -- above inactive, deliberately
      'bogus.service',       // inactive -- everything else
    ]);
  });

  it('does not mutate its input array', () => {
    const rows: ServiceRow[] = [
      { unit: 'b.service', name: 'b', load: 'loaded', active: 'inactive', sub: 'dead', enabled: 'unknown', description: '' },
      { unit: 'a.service', name: 'a', load: 'loaded', active: 'active', sub: 'running', enabled: 'unknown', description: '' },
    ];
    const original = rows.slice();
    sortServices(rows);
    expect(rows).toEqual(original);
  });
});

