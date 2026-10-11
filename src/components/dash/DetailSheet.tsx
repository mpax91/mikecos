import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Drill-down panel for a dashboard tile or row: slides up from the bottom
 * on phones, a wide centered panel on desktop. Esc / backdrop / × close. */
export function DetailSheet({ title, sub, onClose, children }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="detail-sheet__backdrop" onClick={onClose}>
      <div className="detail-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="detail-sheet__grab" aria-hidden="true" />
        <div className="detail-sheet__head">
          <div className="detail-sheet__titles">
            <h3 className="detail-sheet__title">{title}</h3>
            {sub && <div className="detail-sheet__sub">{sub}</div>}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="detail-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
