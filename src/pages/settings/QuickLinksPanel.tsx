import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { QuickLink } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

interface FormState {
  id: string | null; // null while creating
  name: string;
  url: string;
  type: 'open' | 'copy';
  icon: string;
  category: string;
  thumbnailKey: string | null; // already-uploaded key, if any
  thumbnailPreviewUrl: string | null; // local object URL or the existing thumbnailUrl, for the preview square
}

function blankForm(): FormState {
  return { id: null, name: '', url: '', type: 'open', icon: '🔗', category: 'AI Tools', thumbnailKey: null, thumbnailPreviewUrl: null };
}

function formFromLink(link: QuickLink): FormState {
  return {
    id: link.id,
    name: link.name,
    url: link.url,
    type: link.type,
    icon: link.icon || '🔗',
    category: link.category,
    thumbnailKey: null, // only set when Mike uploads a *new* one this edit — an unchanged thumbnail is left alone
    thumbnailPreviewUrl: link.thumbnailUrl,
  };
}

/** Links — Settings' management screen for the sidebar "Links" tray (see
 * migrations/0028_quick_links.sql). This is the ONLY place links are
 * added, edited, reordered, or removed — the Links page itself is
 * click-only, per Mike's request that it stay clean and finished-looking
 * rather than carrying its own "+ Add" affordance. */
export function QuickLinksPanel() {
  const [links, setLinks] = useState<QuickLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null); // non-null = panel open
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<QuickLink | null>(null);
  const [reordering, setReordering] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    api
      .listQuickLinks()
      .then((res) => {
        setLinks(res.links);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setForm(blankForm());
    setSaveError(null);
  }

  function openEdit(link: QuickLink) {
    setForm(formFromLink(link));
    setSaveError(null);
  }

  async function handleThumbnailChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !form) return;
    const localPreview = URL.createObjectURL(file);
    setForm({ ...form, thumbnailPreviewUrl: localPreview });
    setUploading(true);
    try {
      const uploaded = await api.uploadInline(file);
      setForm((prev) => (prev ? { ...prev, thumbnailKey: uploaded.r2_key } : prev));
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setUploading(false);
    }
  }

  function clearThumbnail() {
    if (!form) return;
    // "clear" means: on save, stop pointing at any thumbnail and fall back
    // to the emoji icon. Sending thumbnail_key: null on the PATCH/POST does
    // that; the just-uploaded R2 object (if any) is simply left orphaned
    // rather than deleted here, since a still-open panel could still be
    // pointing a *different* link's preview at the same object URL.
    setForm({ ...form, thumbnailKey: null, thumbnailPreviewUrl: null });
  }

  async function handleSave() {
    if (!form) return;
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name,
        url,
        type: form.type,
        icon: form.icon.trim() || '🔗',
        category: form.category.trim() || 'Links',
        // Only send thumbnail_key when it actually changed this edit —
        // undefined means "leave it as-is" on the server; null explicitly
        // clears it (handled by clearThumbnail above setting it to null).
        ...(form.thumbnailKey !== null || form.thumbnailPreviewUrl === null ? { thumbnail_key: form.thumbnailKey } : {}),
      };
      if (form.id) {
        await api.updateQuickLink(form.id, payload);
      } else {
        await api.createQuickLink(payload);
      }
      setForm(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(link: QuickLink) {
    setLinks((prev) => (prev ? prev.filter((l) => l.id !== link.id) : prev));
    await api.deleteQuickLink(link.id);
    setDeleting(null);
  }

  // Swap sort_order with the neighbor above/below — simple and predictable
  // for what's expected to stay a ~10-item list, without pulling in a
  // drag-and-drop dependency for it.
  async function move(link: QuickLink, dir: -1 | 1) {
    if (!links) return;
    const i = links.findIndex((l) => l.id === link.id);
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const other = links[j];
    setReordering(true);
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    setLinks(next);
    try {
      await Promise.all([
        api.updateQuickLink(link.id, { sort_order: other.sortOrder }),
        api.updateQuickLink(other.id, { sort_order: link.sortOrder }),
      ]);
      load();
    } finally {
      setReordering(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load links: {error}</div>;
  if (!links) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Links</h2>
        <button className="btn" onClick={openCreate}>
          + Add Link
        </button>
      </div>
      <p className="settings-page__section-hint">
        Manages the "Links" page in the sidebar — quick jumps to Claude Projects, ChatGPT GPTs, your Cal.com booking
        link, and anything else that gets buried in its own app. "Copies to clipboard" tiles (like Cal.com) copy the
        URL instead of opening it. Links are grouped on the page by Category, in the order shown below.
      </p>

      {links.length === 0 ? (
        <div className="empty-state">No links yet — add your first one.</div>
      ) : (
        <div className="manage-list">
          {links.map((link, i) => (
            <div className="manage-row" key={link.id}>
              <div className="manage-row__move">
                <button type="button" disabled={i === 0 || reordering} onClick={() => move(link, -1)} title="Move up">
                  ▲
                </button>
                <button type="button" disabled={i === links.length - 1 || reordering} onClick={() => move(link, 1)} title="Move down">
                  ▼
                </button>
              </div>
              <div className="manage-row__icon">
                {link.thumbnailUrl ? <img src={link.thumbnailUrl} alt="" /> : link.icon || '🔗'}
              </div>
              <div className="manage-row__body" onClick={() => openEdit(link)}>
                <div className="manage-row__title">
                  {link.name}
                  <span className="manage-row__meta">
                    {' '}
                    · {link.category}
                    {link.type === 'copy' ? ' · copies to clipboard' : ''}
                  </span>
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" onClick={() => openEdit(link)} title="Edit">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(link)} title="Delete">
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Modal title={form.id ? `Edit Link — ${form.name || 'Untitled'}` : 'Add Link'} onClose={() => setForm(null)}>
          <div className="thumb-field">
            <div className="thumb-preview">
              {form.thumbnailPreviewUrl ? <img src={form.thumbnailPreviewUrl} alt="" /> : form.icon || '🔗'}
            </div>
            <div className="thumb-controls">
              <div className="thumb-controls__row">
                <label className="thumb-upload-btn">
                  {uploading ? 'Uploading…' : 'Upload thumbnail…'}
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleThumbnailChange} />
                </label>
                <button type="button" className="thumb-clear-btn" onClick={clearThumbnail}>
                  Use icon instead
                </button>
              </div>
              <div className="thumb-hint">PNG, JPG, or a screenshot crop — square works best. Stored here, not tied to the source site staying up.</div>
            </div>
          </div>

          <input autoFocus placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="URL (https://…)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={{ fontFamily: 'monospace' }} />
          <input placeholder="Icon (emoji, used until a thumbnail is set)" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
          <input placeholder="Category (e.g. AI Tools, Scheduling)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />

          <label className="settings-page__field-label">Behavior</label>
          <div className="type-toggle">
            <div
              className={`type-toggle__opt${form.type === 'open' ? ' is-selected' : ''}`}
              onClick={() => setForm({ ...form, type: 'open' })}
            >
              Opens the link
            </div>
            <div
              className={`type-toggle__opt${form.type === 'copy' ? ' is-selected' : ''}`}
              onClick={() => setForm({ ...form, type: 'copy' })}
            >
              Copies to clipboard
            </div>
          </div>

          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}

          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleSave} disabled={!form.name.trim() || !form.url.trim() || saving || uploading}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this link?"
          body={`"${deleting.name}" will stop showing up on the Links page.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
