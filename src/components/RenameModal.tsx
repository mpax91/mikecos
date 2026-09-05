import { useRef, useState } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    if (value.trim()) onSave(value.trim());
    onClose();
  }

  return (
    <Modal title={`Rename`} onClose={onClose}>
      <input
        ref={inputRef}
        autoFocus
        // Select the existing text (usually a generic default like "New
        // Folder") so typing replaces it outright instead of requiring a
        // manual select-all first.
        onFocus={(e) => e.target.select()}
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
