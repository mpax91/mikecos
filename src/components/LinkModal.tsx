import { useState } from 'react';
import { Modal } from './Modal';
import { normalizeUrl } from '../api/client';

export function LinkModal({
  initialUrl = '',
  initialTitle = '',
  heading = 'Add Link',
  submitLabel = 'Add',
  showLabelField = true,
  onSave,
  onClose,
}: {
  initialUrl?: string;
  initialTitle?: string;
  heading?: string;
  submitLabel?: string;
  /** "Insert link preview" fetches its own title server-side — the optional
   * label field only makes sense for a plain inline link, so callers that
   * don't want it (a fetched title would just be overwritten) can hide it. */
  showLabelField?: boolean;
  onSave: (url: string, title: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);

  function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    onSave(normalizeUrl(trimmed), title.trim());
  }

  return (
    <Modal title={heading} onClose={onClose}>
      <input
        autoFocus
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {showLabelField && (
        <input
          placeholder="Label (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={submit} disabled={!url.trim()}>
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}
