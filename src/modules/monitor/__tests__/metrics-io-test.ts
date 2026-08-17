import { parseNetDev, parseDiskstats } from '../parse';
import { netMetrics, diskMetrics } from '../metrics';
import { NET_DEV, NET_DEV_NEXT, DISKSTATS, DISKSTATS_NEXT } from '../__fixtures__/proc';

const eth = (rows: { name: string }[]) => rows.filter(r => r.name === 'eth0')[0] as any;
const vda1 = (rows: { name: string }[]) => rows.filter(r => r.name === 'vda1')[0] as any;

describe('netMetrics', () => {
  it('returns null rates on the first sample', () => {
    const i = eth(netMetrics(null, parseNetDev(NET_DEV), 2000));
    expect(i.rxBps).toBe(null);
    expect(i.txBps).toBe(null);
  });

  it('always reports absolute totals even without a previous sample', () => {
    const i = eth(netMetrics(null, parseNetDev(NET_DEV), 2000));
    expect(i.rxTotal).toBe(4500000000);
    expect(i.txTotal).toBe(1845000000);
  });

  it('computes bytes per second from the delta and elapsed time', () => {
    const i = eth(netMetrics(parseNetDev(NET_DEV), parseNetDev(NET_DEV_NEXT), 2000));
    expect(i.rxBps).toBe(1000); // 2000 bytes over 2s
    expect(i.txBps).toBe(848); // 1696 bytes over 2s
  });

  it('drops the loopback interface', () => {
    expect(netMetrics(null, parseNetDev(NET_DEV), 2000).map(i => i.name)).toEqual(['eth0', 'ens5']);
  });

  it('reports null rather than a negative rate when a counter resets', () => {
    const i = eth(netMetrics(parseNetDev(NET_DEV_NEXT), parseNetDev(NET_DEV), 2000));
    expect(i.rxBps).toBe(null);
  });

  it('reports null rates when elapsed time is zero', () => {
    const i = eth(netMetrics(parseNetDev(NET_DEV), parseNetDev(NET_DEV_NEXT), 0));
    expect(i.rxBps).toBe(null);
  });

  it('ignores an interface that appeared since the previous sample', () => {
    const prev = parseNetDev(NET_DEV).filter(i => i.name !== 'ens5');
    const ens = netMetrics(prev, parseNetDev(NET_DEV_NEXT), 2000).filter(i => i.name === 'ens5')[0];
    expect(ens.rxBps).toBe(null);
  });
});

describe('diskMetrics', () => {
  it('computes read and write throughput', () => {
    const d = vda1(diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000));
    expect(d.readBps).toBe((1600 * 512) / 2);
    expect(d.writeBps).toBe((800 * 512) / 2);
  });

  it('computes iops', () => {
    const d = vda1(diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000));
    expect(d.readIops).toBe(50); // 100 reads over 2s
    expect(d.writeIops).toBe(25); // 50 writes over 2s
  });

  it('computes average latency as service time per io', () => {
    const d = vda1(diskMetrics(parseDiskstats(DISKSTATS), parseDiskstats(DISKSTATS_NEXT), 2000));
    expect(d.readLatencyMs).toBeCloseTo(0.2, 5); // 20ms across 100 reads
    expect(d.writeLatencyMs).toBeCloseTo(0.2, 5); // 10ms across 50 writes
  });

  it('reports zero latency rather than NaN when no io occurred', () => {
    const loop = diskMetrics(
      parseDiskstats(DISKSTATS),
      parseDiskstats(DISKSTATS_NEXT),
      2000
    ).filter(d => d.name === 'loop0')[0];
    expect(loop.readLatencyMs).toBe(0);
    expect(loop.readIops).toBe(0);
  });

  it('reports absolute totals since boot', () => {
    const d = vda1(diskMetrics(null, parseDiskstats(DISKSTATS), 2000));
    expect(d.readTotal).toBe(19900000 * 512);
    expect(d.writeTotal).toBe(119000000 * 512);
    expect(d.readBps).toBe(null);
  });

  it('reports null rates when counters go backwards', () => {
    const d = vda1(diskMetrics(parseDiskstats(DISKSTATS_NEXT), parseDiskstats(DISKSTATS), 2000));
    expect(d.readBps).toBe(null);
  });
});
