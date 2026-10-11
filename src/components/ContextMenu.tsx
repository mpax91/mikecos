import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fitMenu, type MenuPlacement } from '../utils/fitMenu';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** A right-click menu positioned at the cursor, reusing the same visual
 * language as KebabMenu's dropdown (card chrome, item/separator styles) so
 * it doesn't read as a one-off. Rendered once, globally, by TabsProvider —
 * callers just call showContextMenu(x, y, items) from an onContextMenu
 * handler instead of managing their own open/closed state. */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPlacement | null>(null);

  // Measure the real menu (invisible on the first render), then place it at
  // the cursor — flipped up/left when it would run off the bottom/right.
  useLayoutEffect(() => {
    if (!state) {
      setPos(null);
      return;
    }
    const menu = ref.current;
    if (!menu) return;
    setPos(
      fitMenu({
        width: menu.offsetWidth,
        height: menu.scrollHeight,
        below: state.y - 4,
        above: state.y + 4,
        anchorLeft: state.x,
      })
    );
  }, [state]);

  useEffect(() => {
    if (!state) return;
    // Only close on a mousedown OUTSIDE the menu — same pattern as
    // KebabMenu. Without the containment check, the mousedown that starts a
    // click on a menu item would close (and unmount) the menu before the
    // matching click ever fires on that item.
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    // Any scroll (capture phase catches scrolling inside a nested pane too)
    // invalidates the menu's fixed x/y — closing is simpler and safer than
    // trying to track it.
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    function onScroll(e: Event) {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    maxHeight: pos?.maxHeight,
    overflowY: pos?.maxHeight ? 'auto' : undefined,
    visibility: pos ? 'visible' : 'hidden',
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu card" style={style} onClick={(e) => e.stopPropagation()}>
      {state.items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separatorBefore && <div className="kebab-menu__separator" />}
          <div
            className={`kebab-menu__item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
