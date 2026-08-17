import { fmtBytes, fmtRate, fmtUptime, fmtAgo, fmtPct, pct, toneForPct } from '../format';

describe('fmtBytes', () => {
  it('renders bytes without decimals', () => {
    expect(fmtBytes(512)).toBe('512 B');
  });
  it('scales to KB, MB, GB and TB', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB');
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
    expect(fmtBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.0 TB');
  });
  it('honours a digits argument', () => {
    expect(fmtBytes(1536, 2)).toBe('1.50 KB');
  });
  it('renders an em dash for null and undefined, never a zero', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(undefined)).toBe('—');
  });
  it('renders a real zero as zero', () => {
    expect(fmtBytes(0)).toBe('0 B');
  });
});

describe('fmtRate', () => {
  it('suffixes per second', () => {
    expect(fmtRate(2048)).toBe('2.0 KB/s');
  });
  it('renders an em dash for a null rate', () => {
    // null means "not computable from these two samples". A zero would read as
    // idle, which is the opposite of the truth.
    expect(fmtRate(null)).toBe('—');
  });
});

describe('fmtUptime', () => {
  it('renders minutes under an hour', () => {
    expect(fmtUptime(1800)).toBe('30m');
  });
  it('renders hours and minutes under a day', () => {
    expect(fmtUptime(3600 * 5 + 60 * 7)).toBe('5h 7m');
  });
  it('renders days and hours beyond a day', () => {
    expect(fmtUptime(86400 * 3 + 3600 * 4)).toBe('3d 4h');
  });
  it('renders an em dash for null', () => {
    expect(fmtUptime(null)).toBe('—');
  });
});

describe('fmtAgo', () => {
  const NOW = 1_000_000_000_000;
  it('renders seconds', () => {
    expect(fmtAgo(NOW - 5000, NOW)).toBe('5s ago');
  });
  it('renders minutes', () => {
    expect(fmtAgo(NOW - 120_000, NOW)).toBe('2m ago');
  });
  it('renders hours', () => {
    expect(fmtAgo(NOW - 7_200_000, NOW)).toBe('2h ago');
  });
  it('renders never for a null timestamp', () => {
    expect(fmtAgo(null, NOW)).toBe('never');
  });
  it('clamps a future timestamp to 0s rather than going negative', () => {
    // The server clock drives `at`; a workstation clock behind the server's
    // must not render "-3s ago".
    expect(fmtAgo(NOW + 3000, NOW)).toBe('0s ago');
  });
});

describe('fmtPct', () => {
  it('renders one decimal by default', () => {
    expect(fmtPct(30.963777)).toBe('31.0%');
  });
  it('renders an em dash for null', () => {
    expect(fmtPct(null)).toBe('—');
  });
});

describe('pct', () => {
  it('computes a percentage', () => {
    expect(pct(50, 200)).toBe(25);
  });
  it('returns null for a zero total rather than NaN or Infinity', () => {
    expect(pct(5, 0)).toBeNull();
  });
});

describe('toneForPct', () => {
  it('is ok below 70', () => {
    expect(toneForPct(10)).toBe('ok');
  });
  it('is warn from 70 to under 90', () => {
    expect(toneForPct(70)).toBe('warn');
    expect(toneForPct(89.9)).toBe('warn');
  });
  it('is bad at 90 and above', () => {
    expect(toneForPct(90)).toBe('bad');
    expect(toneForPct(100)).toBe('bad');
  });
  it('is neutral for null', () => {
    expect(toneForPct(null)).toBe('');
  });
});
