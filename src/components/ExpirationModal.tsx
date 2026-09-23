import { useState } from 'react';
import { Modal } from './Modal';

/** Set/change/clear a note or file's expiration date — see
 * worker/migrations/0039_entity_expiration.sql. Saving a date auto-creates
 * (or updates) a real task due 30 days out; clearing it (Remove) deletes
 * that task. Kept generic — not Vault-specific — since any note/file
 * anywhere could eventually get this wired in, same convention as
 * RenameModal. */
export function ExpirationModal({
  title,
  initialValue,
  onSave,
  onClose,
}: {
  title: string;
  initialValue: string | null;
  onSave: (expiresAt: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue ?? '');

  function commit() {
    onSave(value || null);
    onClose();
  }

  return (
    <Modal title="Expiration Date" onClose={onClose}>
      <p className="modal__hint">
        {title} — a reminder task ("Renew: …") will show up in Today 30 days before this date.
      </p>
      <input type="date" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <div className="modal__actions">
        {initialValue && (
          <button
            className="btn btn--ghost"
            style={{ marginRight: 'auto' }}
            onClick={() => {
              onSave(null);
              onClose();
            }}
          >
            Remove
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={commit} disabled={!value}>
          Save
        </button>
      </div>
    </Modal>
  );
}
