import { useState } from 'react';
import type { BarItem, BarTasting } from '../api/types';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import { StarRating } from './StarRating';
import { BarTastingModal, type TastingFormValue } from './BarTastingModal';

/** Every logged tasting for one Bar item, oldest-editing-newest-first —
 * this is what makes "what did I think of that Barolo" answerable even
 * once the bottle's gone, since tastings never get cleared when quantity
 * hits zero. "+ Log a tasting" is available regardless of current stock,
 * on purpose — a wine you drank at a restaurant is just as loggable. */
export function BarTastingHistoryModal({
  item,
  tastings,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  item: BarItem;
  tastings: BarTasting[];
  onCreate: (value: TastingFormValue) => Promise<void>;
  onUpdate: (id: string, value: TastingFormValue) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BarTasting | null>(null);
  const [deleting, setDeleting] = useState<BarTasting | null>(null);

  return (
    <>
      <Modal title={`Tastings — ${item.name}`} onClose={onClose}>
        <div className="bar-tasting-history__toolbar">
          <button className="btn" onClick={() => setAdding(true)}>
            + Log a tasting
          </button>
        </div>

        {tastings.length === 0 ? (
          <div className="empty-state">No tastings logged yet.</div>
        ) : (
          <div className="bar-tasting-history__list">
            {tastings.map((t) => (
              <div key={t.id} className="bar-tasting-history__row" onClick={() => setEditing(t)}>
                <div className="bar-tasting-history__row-top">
                  <span className="bar-tasting-history__date">{t.consumedAt || 'No date'}</span>
                  {t.score !== null && <StarRating value={t.score} readOnly size={14} />}
                  {t.buyAgain !== null && <span title={t.buyAgain ? 'Would buy again' : 'Would not buy again'}>{t.buyAgain ? '👍' : '👎'}</span>}
                </div>
                {t.tags.length > 0 && (
                  <div className="bar-tasting-history__tags">
                    {t.tags.map((tag) => (
                      <span key={tag} className="chip chip--static">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {t.notes && <div className="bar-tasting-history__notes">{t.notes}</div>}
              </div>
            ))}
          </div>
        )}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>

      {adding && (
        <BarTastingModal
          itemName={item.name}
          onSave={async (value) => {
            await onCreate(value);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && (
        <BarTastingModal
          itemName={item.name}
          initial={editing}
          onSave={async (value) => {
            await onUpdate(editing.id, value);
            setEditing(null);
          }}
          onDelete={() => {
            setDeleting(editing);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete this tasting?"
          body={`This tasting from ${deleting.consumedAt || 'an unknown date'} will be permanently deleted.`}
          onConfirm={async () => {
            await onDelete(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
