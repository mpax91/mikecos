import { useState } from 'react';
import { Modal } from './Modal';

export function RenameModal({
  initialValue,
  label = 'Name',
  onSave,
  onClose,
}: {
  initialValue: string;
  label?: string;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  function commit() {
    if (value.trim()) onSave(value.trim());
    onClose();
  }

  return (
    <Modal title={`Rename`} onClose={onClose}>
      <input
        autoFocus
        placeholder={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={commit} disabled={!value.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
