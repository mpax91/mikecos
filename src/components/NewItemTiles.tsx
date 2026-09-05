import { useEffect, useRef, useState } from 'react';

/** Dashed "+" tile at the end of the Folders section — click to create a
 * new folder immediately, no modal needed. Always rendered (not only when
 * empty) so there's always an obvious way to add another. */
export function NewFolderTile({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="folder-tile folder-tile--ghost" onClick={onCreate}>
      <div className="folder-tile__top" />
      <div className="folder-tile__icon folder-tile__icon--ghost">+</div>
      <div className="folder-tile__title folder-tile__title--ghost">New Folder</div>
    </div>
  );
}

/** Dashed "+" card at the end of the Notes section — click to create and
 * jump straight into a new note. */
export function NewNoteTile({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="entity-card entity-card--ghost entity-card--note-ghost" onClick={onCreate}>
      <div className="entity-card__ghost-plus">+</div>
      <div className="entity-card__title entity-card__title--ghost">New Note</div>
    </div>
  );
}

/** Dashed "+" card at the end of the Files section. Files can be either an
 * upload or a link, so clicking it opens a tiny inline menu instead of
 * acting immediately. */
export function NewFileTile({
  onUploadFile,
  onAddLink,
}: {
  onUploadFile: (file: File) => void;
  onAddLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div ref={ref} className="entity-card entity-card--ghost" style={{ position: 'relative' }} onClick={() => setOpen((v) => !v)}>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        // A programmatic .click() on this input (from the "Upload File" menu
        // item below) is itself a real DOM click event that bubbles up to
        // the card's own onClick — without stopping it here, that bubble
        // re-toggles `open` right back to true immediately after the menu
        // item closed it, so the very next real click on the card looks
        // like it does nothing (it's actually closing a menu that never
        // visibly reopened).
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadFile(file);
          e.target.value = '';
        }}
      />
      <div className="entity-card__ghost-plus">+</div>
      <div className="entity-card__title entity-card__title--ghost">New Media</div>
      {open && (
        <div
          className="card new-file-tile__menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="new-file-tile__menu-item"
            onClick={() => {
              setOpen(false);
              fileInputRef.current?.click();
            }}
          >
            Upload File
          </div>
          <div
            className="new-file-tile__menu-item"
            onClick={() => {
              setOpen(false);
              onAddLink();
            }}
          >
            Add Link
          </div>
        </div>
      )}
    </div>
  );
}
