import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { WalletCategory } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

/** Settings' management screen for Wallet's category pick list (see
 * migrations/0046_wallet_categories.sql) — add/rename/reorder/remove the
 * options the card editor's Category field suggests. The field itself
 * always stays free text, so this is a curated shortlist, not a fence:
 * removing a category here never touches any card already using that
 * text. Same add/rename/reorder shape as QuickLinksPanel. */
export function WalletCategoriesPanel() {
  const [categories, setCategories] = useState<WalletCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WalletCategory | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<WalletCategory | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);

  function load() {
    api
      .listWalletCategories()
      .then((res) => {
        setCategories(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createWalletCategory(name);
      setAdding(false);
      setNewName('');
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleRename() {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateWalletCategory(renaming.id, { name });
      setRenaming(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(cat: WalletCategory) {
    setCategories((prev) => (prev ? prev.filter((c) => c.id !== cat.id) : prev));
    await api.deleteWalletCategory(cat.id);
    setDeleting(null);
  }

  async function move(cat: WalletCategory, dir: -1 | 1) {
    if (!categories) return;
    const i = categories.findIndex((c) => c.id === cat.id);
    const j = i + dir;
    if (j < 0 || j >= categories.length) return;
    const other = categories[j];
    setReordering(true);
    const next = [...categories];
    [next[i], next[j]] = [next[j], next[i]];
    setCategories(next);
    try {
      await Promise.all([
        api.updateWalletCategory(cat.id, { sortOrder: other.sortOrder }),
        api.updateWalletCategory(other.id, { sortOrder: cat.sortOrder }),
      ]);
      load();
    } finally {
      setReordering(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load categories: {error}</div>;
  if (!categories) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Wallet Categories</h2>
        <button className="btn" onClick={() => { setAdding(true); setSaveError(null); }}>
          + Add Category
        </button>
      </div>
      <p className="settings-page__section-hint">
        The pick list Wallet's Add/Edit Card screen suggests for the Category field. The field always accepts
        anything you type — this list is just the shortcuts. Removing one here doesn't change any card already
        using that category; it just stops offering it for new cards.
      </p>

      {categories.length === 0 ? (
        <div className="empty-state">No categories yet — add your first one.</div>
      ) : (
        <div className="manage-list">
          {categories.map((cat, i) => (
            <div className="manage-row" key={cat.id}>
              <div className="manage-row__move">
                <button type="button" disabled={i === 0 || reordering} onClick={() => move(cat, -1)} title="Move up">
                  ▲
                </button>
                <button type="button" disabled={i === categories.length - 1 || reordering} onClick={() => move(cat, 1)} title="Move down">
                  ▼
                </button>
              </div>
              <div className="manage-row__body" onClick={() => { setRenaming(cat); setRenameValue(cat.name); setSaveError(null); }}>
                <div className="manage-row__title">{cat.name}</div>
              </div>
              <div className="manage-row__actions">
                <button type="button" onClick={() => { setRenaming(cat); setRenameValue(cat.name); setSaveError(null); }} title="Rename">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(cat)} title="Delete">
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Add Category" onClose={() => setAdding(false)}>
          <input
            autoFocus
            placeholder="e.g. Recreation Pass"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleAdd} disabled={!newName.trim() || saving}>
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title={`Rename "${renaming.name}"`} onClose={() => setRenaming(null)}>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleRename} disabled={!renameValue.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this category?"
          body={`"${deleting.name}" will stop showing up as a suggestion — any card already using it keeps that category text.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
