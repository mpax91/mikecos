import { useEffect, useState } from 'react';
import { api, normalizeUrl } from '../api/client';
import type { Entity, VaultFact } from '../api/types';
import { Modal } from './Modal';
import { VaultFactsTable } from './VaultFactsTable';

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7z" stroke="currentColor" strokeWidth="1.7" fill="none" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" fill="none" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M3 3l18 18M9.9 5.5A10.6 10.6 0 0112 5c6.2 0 10 7 10 7a17.7 17.7 0 01-4.2 4.9M6.5 6.7C3.9 8.4 2 12 2 12s3.8 7 10 7c1.4 0 2.7-.3 3.8-.8M14.1 14.1a3 3 0 01-4.2-4.2" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** One editable row: label, a value input, and a copy button. Autosaves on
 * blur (only when the value actually changed), matching how the rest of
 * Vault already behaves (entry title, quick facts) rather than needing an
 * explicit Save button. */
function DetailField({
  label,
  value,
  onCommit,
  placeholder,
  type = 'text',
  rightButton,
  autoFocus,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: string;
  rightButton?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="password-modal__field">
      <span>{label}</span>
      <div className="password-modal__field-row">
        <input
          type={type}
          value={draft}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        {rightButton}
      </div>
    </label>
  );
}

export function PasswordDetailModal({
  entity,
  onSave,
  onDelete,
  onClose,
}: {
  entity: Entity;
  onSave: (patch: { title?: string; url?: string; username?: string; password?: string }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);
  const [facts, setFacts] = useState<VaultFact[]>([]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.getVaultEntryFacts(entity.id).then(setFacts).catch(() => {});
  }, [entity.id]);

  function copy(field: 'username' | 'password', value: string | null | undefined) {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(field);
      setTimeout(() => setCopied((c) => (c === field ? null : c)), 1200);
    });
  }

  async function addFact(label: string, value: string) {
    const fact = await api.addVaultFact(entity.id, label, value || null);
    setFacts((prev) => [...prev, fact]);
  }

  async function updateFact(fact: VaultFact, patch: { label?: string; value?: string }) {
    const updated = await api.updateVaultFact(fact.id, { label: patch.label, value: patch.value ?? undefined });
    setFacts((prev) => prev.map((f) => (f.id === fact.id ? updated : f)));
  }

  async function deleteFact(fact: VaultFact) {
    setFacts((prev) => prev.filter((f) => f.id !== fact.id));
    await api.deleteVaultFact(fact.id);
  }

  async function reorderFacts(orderedIds: string[]) {
    const byId = new Map(facts.map((f) => [f.id, f]));
    setFacts(orderedIds.map((id) => byId.get(id)!).filter(Boolean));
    await api.reorderVaultFacts(entity.id, orderedIds);
  }

  return (
    <Modal title="Password details" onClose={onClose}>
      <div className="password-modal">
        <DetailField label="Name" value={entity.title} onCommit={(v) => onSave({ title: v || 'Untitled Password' })} placeholder="e.g. google.com" autoFocus={!entity.title} />

        <DetailField
          label="URL"
          value={entity.url ?? ''}
          onCommit={(v) => onSave({ url: v })}
          placeholder="example.com"
          rightButton={
            entity.url ? (
              <button type="button" className="password-modal__icon-btn" title="Open" onClick={() => window.open(normalizeUrl(entity.url!), '_blank', 'noopener,noreferrer')}>
                ↗
              </button>
            ) : undefined
          }
        />

        <DetailField
          label="Username"
          value={entity.username ?? ''}
          onCommit={(v) => onSave({ username: v })}
          placeholder="you@example.com"
          rightButton={
            entity.username ? (
              <button type="button" className="password-modal__icon-btn" title="Copy" onClick={() => copy('username', entity.username)}>
                {copied === 'username' ? '✓' : '⧉'}
              </button>
            ) : undefined
          }
        />

        <DetailField
          label="Password"
          value={entity.password ?? ''}
          onCommit={(v) => onSave({ password: v })}
          type={revealed ? 'text' : 'password'}
          placeholder="—"
          rightButton={
            <>
              <button type="button" className="password-modal__icon-btn" title={revealed ? 'Hide' : 'Reveal'} onClick={() => setRevealed((v) => !v)}>
                <EyeIcon open={revealed} />
              </button>
              {entity.password && (
                <button type="button" className="password-modal__icon-btn" title="Copy" onClick={() => copy('password', entity.password)}>
                  {copied === 'password' ? '✓' : '⧉'}
                </button>
              )}
            </>
          }
        />

        <div className="password-modal__facts">
          <span className="password-modal__facts-label">Custom fields</span>
          <VaultFactsTable facts={facts} onAdd={addFact} onUpdate={updateFact} onDelete={deleteFact} onReorder={reorderFacts} />
        </div>
      </div>

      <div className="modal__actions">
        <button type="button" className="btn btn--ghost password-modal__delete" onClick={() => setDeleting(true)}>
          Delete
        </button>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>

      {deleting && (
        <div className="password-modal__confirm">
          <span>Delete "{entity.title || 'Untitled Password'}"? This can't be undone.</span>
          <div className="password-modal__confirm-actions">
            <button type="button" className="btn btn--ghost" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
