import { ROW_HEIGHT, virtualWindow } from '../useVirtualRows';

describe('ROW_HEIGHT', () => {
  it('matches the --csv-row-height in styles.css', () => {
    expect(ROW_HEIGHT).toBe(24);
  });
});

describe('virtualWindow', () => {
  it('renders from the top with a buffer of nothing above it', () => {
    const view = virtualWindow(0, 240, 24, 1000, 5);
    expect(view.start).toBe(0);
    expect(view.padTop).toBe(0);
    expect(view.end).toBeGreaterThanOrEqual(10);
  });

  it('starts a buffer above the first visible row', () => {
    // 480px down is row 20; five rows of buffer means starting at 15.
    expect(virtualWindow(480, 240, 24, 1000, 5).start).toBe(15);
  });

  it('offsets the rendered block by exactly the skipped rows', () => {
    expect(virtualWindow(480, 240, 24, 1000, 5).padTop).toBe(15 * 24);
  });

  it('renders the viewport plus a buffer on both sides', () => {
    const view = virtualWindow(480, 240, 24, 1000, 5);
    // 10 rows visible + 5 above + 5 below + 1 partial row.
    expect(view.end - view.start).toBe(21);
  });

  it('never runs past the last row', () => {
    const view = virtualWindow(100000, 240, 24, 30, 5);
    expect(view.end).toBe(30);
    expect(view.start).toBeLessThanOrEqual(30);
  });

  it('renders nothing for an empty table', () => {
    expect(virtualWindow(0, 240, 24, 0, 5)).toEqual({ start: 0, end: 0, padTop: 0 });
  });

  it('survives a viewport that has not been measured yet', () => {
    expect(virtualWindow(0, 0, 24, 100, 5).end).toBeGreaterThan(0);
  });
});
