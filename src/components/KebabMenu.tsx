import { useEffect, useRef, useState } from 'react';

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div
      ref={ref}
      className={`kebab-menu${className ? ` ${className}` : ''}`}
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
      {open && (
        <div className="kebab-menu__dropdown card">
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
        </div>
      )}
    </div>
  );
}
