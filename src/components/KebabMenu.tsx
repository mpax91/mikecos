import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  // Viewport coordinates for the portaled dropdown — null until computed,
  // which is also how the dropdown decides whether it's ready to render.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
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

  useEffect(() => {
    if (!open) return;
    // A card that clips its contents (rounded-corner overflow: hidden) or
    // sits in a horizontally-scrolling row (the Shelf) would otherwise slice
    // the dropdown off — portaling to <body> escapes both, but means we lose
    // free CSS-relative positioning and have to track the trigger ourselves.
    function updatePosition() {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    updatePosition();
    // The trigger's on-screen position goes stale the moment its scroll
    // container moves (e.g. dragging the Shelf's row) — closing instead of
    // re-tracking keeps this simple and matches how a native menu behaves.
    function onScroll() {
      setOpen(false);
    }
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', onScroll, true);
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
        pos &&
        createPortal(
          <div
            ref={dropdownRef}
            className="kebab-menu__dropdown card"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
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
