import { formatBytes, formatSpeed, formatDuration, SpeedWindow } from '../transferFormat';

describe('formatBytes', () => {
  it('formats zero as 0 B', () => expect(formatBytes(0)).toBe('0 B'));
  it('formats bytes with no decimals', () => expect(formatBytes(512)).toBe('512 B'));
  it('formats 1023 B without rolling to KB', () => expect(formatBytes(1023)).toBe('1023 B'));
  it('formats exactly 1 KB', () => expect(formatBytes(1024)).toBe('1 KB'));
  it('trims trailing zeros', () => expect(formatBytes(1536)).toBe('1.5 KB'));
  it('keeps two decimals', () => expect(formatBytes(1258)).toBe('1.23 KB'));
  it('formats whole MB', () => expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB'));
  it('formats GB', () => expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB'));
});

describe('formatSpeed', () => {
  it('appends /s', () => expect(formatSpeed(450 * 1024)).toBe('450 KB/s'));
  it('formats zero speed', () => expect(formatSpeed(0)).toBe('0 B/s'));
});

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(44)).toBe('44s'));
  it('rounds fractional seconds', () => expect(formatDuration(44.6)).toBe('45s'));
  it('formats whole minutes', () => expect(formatDuration(360)).toBe('6m'));
  it('formats minutes and seconds', () => expect(formatDuration(366)).toBe('6m 6s'));
  it('formats whole hours', () => expect(formatDuration(7200)).toBe('2h'));
  it('formats hours and minutes', () => expect(formatDuration(7260)).toBe('2h 1m'));
});

describe('SpeedWindow', () => {
  it('returns 0 with fewer than two samples', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    expect(w.speed()).toBe(0);
  });
  it('computes bytes/sec across samples', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(500, 500); // 500 bytes in 0.5s => 1000 B/s
    expect(w.speed()).toBe(1000);
  });
  it('drops samples older than the window', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(1000, 1000);
    w.add(2000, 3000); // window keeps baseline at t=1000: 2000 bytes in 1s => 2000 B/s
    expect(w.speed()).toBe(2000);
  });
  it('resets', () => {
    const w = new SpeedWindow(1000);
    w.add(0, 0);
    w.add(500, 500);
    w.reset();
    expect(w.speed()).toBe(0);
  });
});
