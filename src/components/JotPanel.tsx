import { useState } from 'react';
import { NoteEditor } from './NoteEditor';
import { api } from '../api/client';

/** Slide-over editing surface for an existing Jot — same panel treatment as
 * the Task detail panel, just holding the same rich editor Jots share with
 * Notes. Closing doesn't need an explicit save: NoteEditor already
 * autosaves (debounced) and flushes on unmount. */
export function JotPanel({
  jotId,
  content,
  title,
  onClose,
}: {
  jotId: string;
  content: string | null;
  title: string;
  onClose: () => void;
}) {
  const [titleValue, setTitleValue] = useState(title);

  function handleTitleChange(value: string) {
    setTitleValue(value);
    api.updateEntity(jotId, { title: value });
  }

  return (
    <div className="task-panel-backdrop" onClick={onClose}>
      <div className="jot-panel task-panel" onClick={(e) => e.stopPropagation()}>
        <div className="task-panel__header">
          <span className="task-panel__back" style={{ cursor: 'default' }}>
            Jot
          </span>
          <button className="task-panel__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <input
          className="jot-panel__title"
          placeholder="Title"
          value={titleValue}
          onChange={(e) => handleTitleChange(e.target.value)}
        />
        <NoteEditor
          key={jotId}
          content={content}
          autoFocus
          compact
          onSave={(json) => api.updateEntity(jotId, { content: json })}
        />
      </div>
    </div>
  );
}
