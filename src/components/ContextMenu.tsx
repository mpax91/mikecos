import { useEffect, useRef } from 'react';

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
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  // Keep the menu on-screen even when the click lands near the right/bottom
  // edge of the viewport.
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(state.y, window.innerHeight - 12 - state.items.length * 34),
    left: Math.min(state.x, window.innerWidth - 180),
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
