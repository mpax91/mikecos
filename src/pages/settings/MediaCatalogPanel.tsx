import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MediaCatalogFormat, MediaCatalogItem } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { TrashIcon } from '../../components/icons';

const FORMAT_LABEL: Record<MediaCatalogFormat, string> = {
  physical_book: 'Physical Book',
  ebook: 'eBook',
  audiobook: 'Audiobook',
};

/** Settings' entry point for the Media section's physical/digital
 * catalog (see worker/migrations/0073_media_catalog.sql) — Mike said
 * he's happy to add these by hand as things come in, but wanted the
 * add-flow to live here rather than inline on the Media page itself, so
 * this is the only *creation* path; the Media page's Physical/Digital
 * views can still edit/delete an existing entry for quick fixes. Same
 * add/rename/delete shape as WalletCategoriesPanel. */
export function MediaCatalogPanel() {
  const [items, setItems] = useState<MediaCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MediaCatalogItem | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<MediaCatalogFormat>('physical_book');
  const [notes, setNotes] = useState('');
  const [deleting, setDeleting] = useState<MediaCatalogItem | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .listMediaCatalog()
      .then((res) => {
        setItems(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  function openAdd() {
    setTitle('');
    setAuthor('');
    setFormat('physical_book');
    setNotes('');
    setSaveError(null);
    setAdding(true);
  }

  function openEdit(item: MediaCatalogItem) {
    setTitle(item.title);
    setAuthor(item.author ?? '');
    setFormat(item.format);
    setNotes(item.notes ?? '');
    setSaveError(null);
    setEditing(item);
  }

  async function handleAdd() {
    if (!title.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createMediaCatalogItem({ title: title.trim(), author: author.trim() || null, format, notes: notes.trim() || null });
      setAdding(false);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!editing || !title.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateMediaCatalogItem(editing.id, { title: title.trim(), author: author.trim() || null, format, notes: notes.trim() || null });
      setEditing(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: MediaCatalogItem) {
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    await api.deleteMediaCatalogItem(item.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load the catalog: {error}</div>;
  if (!items) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Media Catalog</h2>
        <button className="btn" onClick={openAdd}>
          + Add Item
        </button>
      </div>
      <p className="settings-page__section-hint">
        Physical books, eBooks, and audiobooks that live outside Plex — the Media section shows these under its Physical/Digital
        filters alongside your Plex library. Purely a catalog: no read/listened status, just what you own and where.
      </p>

      {items.length === 0 ? (
        <div className="empty-state">Nothing catalogued yet — add your first item.</div>
      ) : (
        <div className="manage-list">
          {items.map((item) => (
            <div className="manage-row" key={item.id}>
              <div className="manage-row__body" onClick={() => openEdit(item)}>
                <div className="manage-row__title">
                  {item.title}
                  <span className="manage-row__meta"> · {[item.author, FORMAT_LABEL[item.format]].filter(Boolean).join(' · ')}</span>
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" onClick={() => openEdit(item)} title="Edit">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(item)} title="Delete">
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <Modal title={editing ? `Edit "${editing.title}"` : 'Add Media Item'} onClose={() => (editing ? setEditing(null) : setAdding(false))}>
          <label className="wallet-editor__field">
            <span>Title</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="wallet-editor__field">
            <span>Author</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label className="wallet-editor__field">
            <span>Format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as MediaCatalogFormat)}>
              {(Object.keys(FORMAT_LABEL) as MediaCatalogFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Where it lives, who borrowed it, etc." />
          </label>
          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => (editing ? setEditing(null) : setAdding(false))}>
              Cancel
            </button>
            <button className="btn" onClick={editing ? handleSaveEdit : handleAdd} disabled={!title.trim() || saving}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Add'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this item?"
          body={`"${deleting.title}" will be removed from the catalog.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
