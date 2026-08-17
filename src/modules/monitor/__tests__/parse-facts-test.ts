import { parseDf, parsePs, parseAddr, parseOsRelease, parseCpuModel } from '../parse';
import { DF, PS, IP_ADDR, OS_RELEASE, CPUINFO, CPUINFO_ARM } from '../__fixtures__/proc';

describe('parseDf', () => {
  it('drops pseudo filesystems', () => {
    expect(parseDf(DF).map(m => m.mount)).toEqual(['/', '/mnt/my data']);
  });

  it('reads device, type and byte totals', () => {
    const root = parseDf(DF)[0];
    expect(root.device).toBe('/dev/vda1');
    expect(root.fstype).toBe('ext4');
    expect(root.totalBytes).toBe(111669149696);
    expect(root.usedBytes).toBe(25554579456);
  });

  it('keeps mount points containing spaces intact', () => {
    expect(parseDf(DF)[1].mount).toBe('/mnt/my data');
  });

  it('maps a device path to its diskstats name', () => {
    expect(parseDf(DF)[0].deviceName).toBe('vda1');
  });

  it('ignores the header row', () => {
    expect(parseDf(DF).length).toBe(2);
  });
});

describe('parsePs', () => {
  it('reads pid, user, threads and full args', () => {
    const rows = parsePs(PS);
    expect(rows.length).toBe(3);
    expect(rows[2].pid).toBe(209906);
    expect(rows[2].user).toBe('meilise+');
    expect(rows[2].threads).toBe(23);
    expect(rows[2].args).toBe('/usr/local/bin/meilisearch --http-addr 127.0.0.1:7700');
  });

  it('ignores blank lines', () => {
    expect(parsePs('\n\n').length).toBe(0);
  });
});

describe('parseAddr', () => {
  it('maps interface names to addresses', () => {
    expect(parseAddr(IP_ADDR)).toEqual([
      { name: 'lo', address: '127.0.0.1/8' },
      { name: 'eth0', address: '66.154.126.186/24' },
    ]);
  });
});

describe('parseOsRelease', () => {
  it('reads the pretty name unquoted', () => {
    expect(parseOsRelease(OS_RELEASE).prettyName).toBe('Ubuntu 22.04.5 LTS (Jammy Jellyfish)');
  });

  it('reads the distro id without matching ID_LIKE or VERSION_ID', () => {
    expect(parseOsRelease(OS_RELEASE).id).toBe('ubuntu');
  });

  it('falls back to empty strings when the file is missing', () => {
    expect(parseOsRelease('')).toEqual({ prettyName: '', id: '' });
  });
});

describe('parseCpuModel', () => {
  it('reads the first model name', () => {
    expect(parseCpuModel(CPUINFO)).toBe('Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz');
  });

  it('returns an empty string when there is no model name field', () => {
    expect(parseCpuModel(CPUINFO_ARM)).toBe('');
  });
});
