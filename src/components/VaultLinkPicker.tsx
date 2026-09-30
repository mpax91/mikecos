import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Entity } from '../api/types';

/** Link-or-create-a-Vault-entry field, shared by anything in Home that
 * points at a Vault entry (fixtures, and now doors/windows) — pulled out
 * once a second caller needed the exact same ~90 lines rather than
 * duplicating the search/create/link UI a second time. */
export function VaultLinkPicker({
  vaultEntryId,
  vaultEntryTitle,
  suggestedTitle,
  onChange,
}: {
  vaultEntryId: string | null;
  vaultEntryTitle: string | null;
  suggestedTitle: string;
  onChange: (value: { vaultEntryId: string | null; vaultEntryTitle: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entity[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (pickerOpen && entries === null) api.listVaultEntries().then(setEntries).catch(() => setEntries([]));
  }, [pickerOpen, entries]);

  const filtered = (entries ?? []).filter((e) => e.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 25);

  async function createAndLink() {
    const created = await api.createVaultEntry({ title: suggestedTitle.trim() || 'Untitled Entry' });
    onChange({ vaultEntryId: created.id, vaultEntryTitle: created.title });
    setPickerOpen(false);
  }

  return (
    <div className="wallet-editor__field">
      <span>Vault entry</span>
      {vaultEntryId && !pickerOpen ? (
        <div className="home-vault-link">
          <span>{vaultEntryTitle ?? 'Linked entry'}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPickerOpen(true)}>
            Change
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange({ vaultEntryId: null, vaultEntryTitle: null })}>
            Unlink
          </button>
        </div>
      ) : pickerOpen ? (
        <div className="home-vault-picker">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Vault entries…" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={createAndLink}>
            + Create new Vault entry{suggestedTitle.trim() ? ` "${suggestedTitle.trim()}"` : ''}
          </button>
          {entries === null ? (
            <div className="home-vault-picker__hint">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="home-vault-picker__hint">No matches.</div>
          ) : (
            <div className="home-vault-picker__list">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="home-vault-picker__item"
                  onClick={() => {
                    onChange({ vaultEntryId: e.id, vaultEntryTitle: e.title });
                    setPickerOpen(false);
                  }}
                >
                  {e.title}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPickerOpen(true)}>
          Link or create a Vault entry
        </button>
      )}
    </div>
  );
}
