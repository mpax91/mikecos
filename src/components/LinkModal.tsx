import { useState } from 'react';
import { Modal } from './Modal';

export function LinkModal({ onSave, onClose }: { onSave: (url: string, title: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');

  function normalizedUrl() {
    const trimmed = url.trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function submit() {
    const finalUrl = normalizedUrl();
    if (!finalUrl) return;
    onSave(finalUrl, title.trim());
  }

  return (
    <Modal title="Add Link" onClose={onClose}>
      <input
        autoFocus
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        placeholder="Label (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={submit} disabled={!url.trim()}>
          Add
        </button>
      </div>
    </Modal>
  );
}
