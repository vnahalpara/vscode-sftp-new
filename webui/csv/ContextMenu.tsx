import * as React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  run(): void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export default function ContextMenu(props: ContextMenuProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  // Measured before the browser paints, so a menu opened near the right or
  // bottom edge is never drawn half off-screen.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) {
      return;
    }
    const box = el.getBoundingClientRect();
    setPos({
      left: Math.max(0, Math.min(props.x, window.innerWidth - box.width)),
      top: Math.max(0, Math.min(props.y, window.innerHeight - box.height)),
    });
  }, [props.x, props.y]);

  useEffect(() => {
    // The right-click's own mousedown has already happened by the time this
    // listener is attached, so the menu does not close itself on open.
    const close = () => props.onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        props.onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    // Capture, not bubble: the grid's scroll container is what actually
    // scrolls, and a scroll event does not bubble. The menu is fixed, so the
    // row it is about would otherwise slide out from under it.
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [props.onClose]);

  return (
    <div
      className="csv-menu"
      role="menu"
      ref={boxRef}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={event => event.stopPropagation()}
    >
      {props.items.map((item, index) => (
        <button
          className="csv-menu-item"
          role="menuitem"
          key={index}
          onClick={() => {
            item.run();
            props.onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
