import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitMenu, type MenuPlacement } from '../utils/fitMenu';

export interface KebabMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Calls out a safe/affirmative action (e.g. Download) in the accent color. */
  positive?: boolean;
  /** Renders a divider line above this item, to set it apart from the items before it. */
  separatorBefore?: boolean;
  /** Grays the item out and makes it non-clickable — used for actions that
   * exist but aren't ready to be exposed yet ("Coming soon"). */
  disabled?: boolean;
}

export function KebabMenu({ items, className }: { items: KebabMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  // Viewport placement for the portaled dropdown — null while the menu is
  // being measured (rendered invisibly), then set before the first paint.
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      // The dropdown is portaled to document.body, so it's no longer a DOM
      // descendant of `ref` — a click inside it would otherwise look like an
      // outside click and close the menu before onClick fires.
      if (ref.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // A card that clips its contents (rounded-corner overflow: hidden) or sits
  // in a horizontally-scrolling row (the Shelf) would otherwise slice the
  // dropdown off — portaling to <body> escapes both, but means we place it
  // ourselves. fitMenu flips it above the trigger when there isn't room
  // below (the last row of a list) and clamps it on-screen sideways.
  function place() {
    const rect = ref.current?.getBoundingClientRect();
    const menu = dropdownRef.current;
    if (!rect || !menu) return;
    setPos(
      fitMenu({
        width: menu.offsetWidth,
        height: menu.scrollHeight,
        below: rect.bottom,
        above: rect.top,
        anchorRight: rect.right,
      })
    );
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    function onResize() {
      setPos(null); // re-measure without the old max-height
      requestAnimationFrame(place);
    }
    // The trigger's on-screen position goes stale the moment its scroll
    // container moves — closing instead of re-tracking matches how a native
    // menu behaves. Scrolling INSIDE a height-capped menu must not close it.
    function onScroll(e: Event) {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className={`kebab-menu${className ? ` ${className}` : ''}`}
      // Task rows key their kebab trigger's hover-only visibility off
      // whether its menu is open (see .task-row .kebab-menu[data-open] in
      // global.css) — now that the dropdown itself is portaled out to
      // <body> and can't be selected via :has() from here, this attribute
      // is what that CSS keys off instead.
      data-open={open || undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="kebab-menu__trigger"
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        aria-label="More actions"
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className="kebab-menu__dropdown card"
            style={{
              position: 'fixed',
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              right: 'auto',
              maxHeight: pos?.maxHeight,
              overflowY: pos?.maxHeight ? 'auto' : undefined,
              visibility: pos ? 'visible' : 'hidden',
              zIndex: 1000,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <div key={item.label}>
                {item.separatorBefore && <div className="kebab-menu__separator" />}
                <div
                  className={`kebab-menu__item${item.danger ? ' is-danger' : ''}${item.positive ? ' is-positive' : ''}${
                    item.disabled ? ' is-disabled' : ''
                  }`}
                  onClick={() => {
                    if (item.disabled) return;
                    setOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
