import { useEffect, useRef, useState } from 'react';

export interface KebabMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
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
            <div
              key={item.label}
              className={`kebab-menu__item${item.danger ? ' is-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
