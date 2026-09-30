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

/** One row per non-blank line. A tab or " | " splits title from author —
 * a tab because pasting a column (or two) straight out of a spreadsheet/
 * Goodreads export preserves real tab characters between cells, and " | "
 * as the manual equivalent for typing it by hand. Deliberately NOT
 * splitting on a plain comma or dash — plenty of real titles contain
 * both ("Sapiens: A Brief History..., " a subtitle after a colon, etc.),
 * so guessing there would mis-split more often than it helps. No author
 * on a line just means no author gets set, same as filling nothing in
 * the single-item form. */
function parseBulkLines(text: string): { title: string; author: string | null }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes('\t') ? line.split('\t') : line.split(' | ');
      return { title: parts[0].trim(), author: parts[1]?.trim() || null };
    })
    .filter((r) => r.title);
}

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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFormat, setBulkFormat] = useState<MediaCatalogFormat>('physical_book');
  const [bulkText, setBulkText] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkDone, setBulkDone] = useState<number | null>(null);

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

  function openBulk() {
    setBulkFormat('physical_book');
    setBulkText('');
    setBulkError(null);
    setBulkDone(null);
    setBulkOpen(true);
  }

  const bulkRows = parseBulkLines(bulkText);

  async function handleBulkImport() {
    if (bulkRows.length === 0) return;
    setBulkImporting(true);
    setBulkError(null);
    try {
      const res = await api.bulkCreateMediaCatalogItems(bulkFormat, bulkRows);
      setBulkDone(res.created);
      setBulkText('');
      load();
    } catch (e) {
      setBulkError(String(e));
    } finally {
      setBulkImporting(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load the catalog: {error}</div>;
  if (!items) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Media Catalog</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost" onClick={openBulk}>
            Bulk Import
          </button>
          <button className="btn" onClick={openAdd}>
            + Add Item
          </button>
        </div>
      </div>
      <p className="settings-page__section-hint">
        Physical books, eBooks, and audiobooks that live outside Plex — the Media section shows these under its Physical/Digital
        filters alongside your Plex library. Purely a catalog: no read/listened status, just what you own and where. Got a
        whole shelf to add at once? Use Bulk Import rather than adding one at a time.
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

      {bulkOpen && (
        <Modal title="Bulk Import" onClose={() => setBulkOpen(false)}>
          <p className="settings-page__section-hint" style={{ marginTop: 0 }}>
            Paste one book per line — a title alone is fine, or paste two columns straight out of a spreadsheet (title, then
            author) and the tab between them is picked up automatically. Typing by hand, separate title and author with{' '}
            <code>|</code>. Everything pasted here gets the same format, so do one shelf/list at a time if it's mixed.
          </p>
          <label className="wallet-editor__field">
            <span>Format for this batch</span>
            <select value={bulkFormat} onChange={(e) => setBulkFormat(e.target.value as MediaCatalogFormat)}>
              {(Object.keys(FORMAT_LABEL) as MediaCatalogFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Books</span>
            <textarea
              autoFocus
              value={bulkText}
              onChange={(e) => {
                setBulkText(e.target.value);
                setBulkDone(null);
              }}
              rows={10}
              placeholder={'Atomic Habits\nSapiens | Yuval Noah Harari\nThe Hobbit'}
              style={{ fontFamily: 'monospace', fontSize: 12.5 }}
            />
          </label>
          <div className="wallet-editor__hint">
            {bulkRows.length > 0
              ? `${bulkRows.length.toLocaleString()} item${bulkRows.length === 1 ? '' : 's'} will be added as ${FORMAT_LABEL[bulkFormat]}.`
              : 'Nothing to import yet.'}
          </div>
          {bulkDone !== null && <div className="wallet-editor__hint">Added {bulkDone.toLocaleString()} items.</div>}
          {bulkError && <div className="settings-page__rrule-error">{bulkError}</div>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setBulkOpen(false)}>
              {bulkDone !== null ? 'Done' : 'Cancel'}
            </button>
            <button className="btn" onClick={handleBulkImport} disabled={bulkRows.length === 0 || bulkImporting}>
              {bulkImporting ? 'Importing…' : `Import ${bulkRows.length > 0 ? bulkRows.length.toLocaleString() : ''}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
