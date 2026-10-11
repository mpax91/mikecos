import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitMenu, type MenuPlacement } from '../../utils/fitMenu';

/** ⓘ next to a title: tap to read the explainer that used to sit on the page
 * as grey text (Mike, 2026-10-11 — dashboards stay clean). Placed with
 * fitMenu like every popup; Esc / outside tap closes. */
export function InfoTip({ children, label = 'About this' }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    setPos(fitMenu({ width: p.width, height: p.height, below: r.bottom, above: r.top, anchorLeft: r.left - 8 }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`info-tip${open ? ' is-open' : ''}`}
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className="info-tip__pop"
            role="tooltip"
            style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: -9999, left: -9999 }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Card/section title with an optional ⓘ. */
export function DashTitle({ children, info, as: Tag = 'h3', className = 'fin-dash__card-title' }: { children: React.ReactNode; info?: React.ReactNode; as?: 'h2' | 'h3' | 'h4'; className?: string }) {
  return (
    <Tag className={`${className} dash-title`}>
      {children}
      {info && <InfoTip label={`About ${typeof children === 'string' ? children : 'this'}`}>{info}</InfoTip>}
    </Tag>
  );
}
