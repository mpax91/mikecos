import { useState } from 'react';
import type { Entity } from '../api/types';
import { NoteEditor } from './NoteEditor';

/** Opens a Vault entry's child note in place, rather than navigating to a
 * dedicated route — Vault entries don't nest (no Folders), so there's no
 * natural page for a note-inside-an-entry to live at. A modal keeps a
 * quick-reference item feeling quick: open, read or edit, close, still on
 * the entry. */
export function VaultNoteModal({
  note,
  onSaveTitle,
  onSaveContent,
  onClose,
}: {
  note: Entity;
  onSaveTitle: (title: string) => void;
  onSaveContent: (json: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(note.title);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide vault-note-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <input
            className="vault-note-modal__title"
            value={title}
            placeholder="Untitled Note"
            onChange={(e) => {
              setTitle(e.target.value);
              onSaveTitle(e.target.value);
            }}
            onFocus={(e) => e.target.select()}
            autoFocus={!note.title}
          />
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="vault-note-modal__body">
          <NoteEditor key={note.id} content={note.content} onSave={onSaveContent} />
        </div>
      </div>
    </div>
  );
}
