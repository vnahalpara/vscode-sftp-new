import { useEffect, useState } from 'react';

// Only the rows in view (plus a buffer) are in the DOM. The scroll container
// still gets the full height, so the scrollbar tells the truth about a
// 200,000-row file.
export const ROW_HEIGHT = 24;
const BUFFER_ROWS = 8;

export interface VirtualWindow {
  // First row index to render.
  start: number;
  // One past the last row index to render.
  end: number;
  // Pixels the rendered block is pushed down by.
  padTop: number;
}

export function virtualWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  buffer: number
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0 };
  }
  // Clamped to the last row: an over-scrolled container must not offset the
  // rendered block past the end of the list.
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight) - buffer),
    Math.max(0, total - 1)
  );
  // +1 for the row the viewport is only showing half of.
  const count = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + buffer * 2 + 1;
  return { start, end: Math.min(total, start + count), padTop: start * rowHeight };
}

// Takes the element itself, not a ref object: the grid does not render a
// scroll container on the empty-file screen, and an effect keyed on a ref
// object would never re-run when the container mounted later.
export function useVirtualRows(container: HTMLElement | null, total: number): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  // A sane guess until the element is measured; virtualWindow tolerates a
  // zero height, it just renders the buffer.
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = container;
    if (!el) {
      return undefined;
    }
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setHeight(el.clientHeight);
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
    };
  }, [container]);

  return virtualWindow(scrollTop, height, ROW_HEIGHT, total, BUFFER_ROWS);
}
