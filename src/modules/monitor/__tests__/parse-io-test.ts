import { parseNetDev, parseDiskstats, parsePidStats } from '../parse';
import { NET_DEV, DISKSTATS, PID_STATS } from '../__fixtures__/proc';

describe('parseNetDev', () => {
  it('parses every interface', () => {
    expect(parseNetDev(NET_DEV).map(i => i.name)).toEqual(['lo', 'eth0', 'ens5']);
  });

  it('reads rx and tx byte counters', () => {
    const eth = parseNetDev(NET_DEV).filter(i => i.name === 'eth0')[0];
    expect(eth.rxBytes).toBe(4500000000);
    expect(eth.txBytes).toBe(1845000000);
  });

  it('handles a counter butted against the colon with no space', () => {
    const ens = parseNetDev(NET_DEV).filter(i => i.name === 'ens5')[0];
    expect(ens.rxBytes).toBe(9999999999);
    expect(ens.txBytes).toBe(8888888888);
  });

  it('ignores the two header lines', () => {
    expect(parseNetDev(NET_DEV).length).toBe(3);
  });
});

describe('parseDiskstats', () => {
  it('parses devices and partitions', () => {
    expect(parseDiskstats(DISKSTATS).map(d => d.name)).toEqual(['vda', 'vda1', 'loop0']);
  });

  it('converts sectors to bytes at 512 bytes per sector', () => {
    const vda1 = parseDiskstats(DISKSTATS).filter(d => d.name === 'vda1')[0];
    expect(vda1.readBytes).toBe(19900000 * 512);
    expect(vda1.writeBytes).toBe(119000000 * 512);
  });

  it('reads io counts and service times', () => {
    const vda1 = parseDiskstats(DISKSTATS).filter(d => d.name === 'vda1')[0];
    expect(vda1.reads).toBe(499000);
    expect(vda1.writes).toBe(799000);
    expect(vda1.readMs).toBe(399000);
    expect(vda1.writeMs).toBe(899000);
  });

  it('ignores short or malformed lines', () => {
    expect(parseDiskstats('252 0 vda 1 2\n\n').length).toBe(0);
  });
});

describe('parsePidStats', () => {
  it('parses one entry per process', () => {
    expect(parsePidStats(PID_STATS).map(p => p.pid)).toEqual([1, 831, 209906]);
  });

  it('reads comm, cpu jiffies, threads, starttime and rss pages', () => {
    const maria = parsePidStats(PID_STATS).filter(p => p.pid === 831)[0];
    expect(maria.comm).toBe('mariadbd');
    expect(maria.utime).toBe(45000);
    expect(maria.stime).toBe(12000);
    expect(maria.threads).toBe(9);
    expect(maria.startTime).toBe(900);
    expect(maria.rssPages).toBe(25100);
  });

  it('handles a comm containing spaces and parentheses', () => {
    const weird = parsePidStats(PID_STATS).filter(p => p.pid === 209906)[0];
    expect(weird.comm).toBe('meili (search) x');
    expect(weird.utime).toBe(600);
    expect(weird.stime).toBe(300);
    expect(weird.threads).toBe(23);
    expect(weird.startTime).toBe(12000);
  });

  it('skips entries whose stat line is truncated', () => {
    expect(parsePidStats('==> /proc/5/stat <==\n5 (short) S 0 1\n')).toEqual([]);
  });
});
