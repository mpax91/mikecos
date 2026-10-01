import { api } from '../api/client';
import type { BarItem } from '../api/types';
import { Modal } from './Modal';

function formatUSD(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Everything about one bottle that doesn't fit on its compact grid tile
 * (see BarPage) — producer/region, price/source, drink window, notes, the
 * quantity stepper, and the jump points to Edit/Tastings/Delete. The tile
 * is a thumbnail meant for browsing a whole rack at a glance; this is
 * where Mike actually lands once he's found the bottle he's looking for. */
export function BarItemDetailModal({
  item,
  onClose,
  onEdit,
  onDelete,
  onAdjustQuantity,
  onOpenTastings,
}: {
  item: BarItem;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAdjustQuantity: (delta: number) => void;
  onOpenTastings: () => void;
}) {
  return (
    <Modal title={item.name} onClose={onClose} className="bar-item-detail-modal">
      <div className="bar-item-detail">
        {item.photoKey && (
          <img
            className={`bar-item-detail__photo${item.photoOrientation === 'landscape' ? ' bar-item-detail__photo--landscape' : ''}`}
            src={api.fileUrl(item.photoKey)}
            alt=""
          />
        )}
        <div className="bar-item-detail__body">
          {item.vintage && <div className="bar-item-detail__vintage">{item.vintage}</div>}
          {(item.color || item.geo || item.category) && (
            <div className="bar-item-detail__meta">{[item.color, item.geo, item.category].filter(Boolean).join(' · ')}</div>
          )}
          {item.producer && <div className="bar-item-detail__meta">{item.producer}</div>}
          {(item.price != null || item.source) && (
            <div className="bar-item-detail__meta">{[item.price != null ? formatUSD(item.price) : null, item.source].filter(Boolean).join(' · ')}</div>
          )}
          {(item.drinkWindowStart || item.drinkWindowEnd) && (
            <div className="bar-item-detail__window">
              Drink {item.drinkWindowStart ?? '?'}–{item.drinkWindowEnd ?? '?'}
            </div>
          )}
          {item.notes && <div className="bar-item-detail__notes">{item.notes}</div>}

          <div className="bar-item-detail__qty">
            <span className="bar-item-detail__qty-label">On hand</span>
            <div className="bar-item-card__qty">
              <button type="button" onClick={() => onAdjustQuantity(-1)} disabled={item.quantity <= 0} aria-label="Decrease quantity">
                −
              </button>
              <span>{item.quantity}</span>
              <button type="button" onClick={() => onAdjustQuantity(1)} aria-label="Increase quantity">
                +
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal__actions">
        <button type="button" className="btn btn--ghost bar-item-detail__danger-btn" onClick={onDelete}>
          Delete
        </button>
        <button type="button" className="btn btn--ghost" onClick={onOpenTastings}>
          Tastings
        </button>
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
      </div>
    </Modal>
  );
}
