import { Framer, splitSections } from '../frame';

const block = (ms: number) =>
  `==TICK ${ms}\n--stat\ncpu  1 2 3 4 5 0 0 0 0 0\n--mem\nMemTotal: 100 kB\n==END\n`;

describe('Framer', () => {
  it('returns a whole block delivered in one chunk', () => {
    const f = new Framer();
    expect(f.push(block(1000)).length).toBe(1);
  });

  it('returns nothing until the terminator arrives', () => {
    const f = new Framer();
    expect(f.push('==TICK 1000\n--stat\ncpu 1 2 3 4\n')).toEqual([]);
  });

  it('reassembles a block split across chunks', () => {
    const f = new Framer();
    const whole = block(1000);
    const mid = Math.floor(whole.length / 2);
    expect(f.push(whole.slice(0, mid))).toEqual([]);
    const done = f.push(whole.slice(mid));
    expect(done.length).toBe(1);
    expect(done[0]).toContain('MemTotal');
  });

  it('returns two blocks arriving in a single chunk', () => {
    const f = new Framer();
    expect(f.push(block(1000) + block(3000)).length).toBe(2);
  });

  it('frames a block delivered one byte at a time', () => {
    const f = new Framer();
    const whole = block(1000);
    let got: string[] = [];
    for (let i = 0; i < whole.length; i++) {
      got = got.concat(f.push(whole[i]));
    }
    expect(got.length).toBe(1);
  });

  it('discards leading noise before the first tick', () => {
    const f = new Framer();
    expect(f.push('bash: warning: setlocale failed\n' + block(1000)).length).toBe(1);
  });

  it('drops the buffer instead of growing without bound when no terminator arrives', () => {
    const f = new Framer();
    const junk = '==TICK 1\n' + new Array(1025).join('x');
    let out: string[] = [];
    for (let i = 0; i < 5000; i++) {
      out = out.concat(f.push(junk));
    }
    expect(out).toEqual([]);
    expect(f.buffered()).toBeLessThan(6 * 1024 * 1024);
  });

  it('recovers and frames the next block after an overflow reset', () => {
    const f = new Framer();
    f.push('==TICK 1\n' + new Array(5 * 1024 * 1024).join('x'));
    expect(f.push(block(2000)).length).toBe(1);
  });
});

describe('splitSections', () => {
  it('reads the server timestamp from the tick line', () => {
    expect(splitSections(block(1700000000123)).at).toBe(1700000000123);
  });

  it('keys each section body by its marker', () => {
    const s = splitSections(block(1000)).sections;
    expect(s.stat.trim()).toBe('cpu  1 2 3 4 5 0 0 0 0 0');
    expect(s.mem.trim()).toBe('MemTotal: 100 kB');
  });

  it('stops at the end marker', () => {
    const s = splitSections(block(1000) + 'trailing junk\n').sections;
    expect(s.mem).not.toContain('trailing');
  });

  it('returns an empty section map for a block with no markers', () => {
    expect(splitSections('==TICK 5\n==END\n').sections).toEqual({});
  });

  it('returns at = 0 when the tick line has no timestamp', () => {
    expect(splitSections('==TICK\n--stat\nx\n==END\n').at).toBe(0);
  });
});
