import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, VaultEntryDetail, VaultFieldGroup, VaultTemplate } from '../api/types';
import { NoteEditor } from '../components/NoteEditor';
import { EntityCard } from '../components/EntityCard';
import { NewFileTile } from '../components/NewItemTiles';
import { Section } from '../components/Section';
import { VaultFieldRow } from '../components/VaultFieldRow';
import { KebabMenu } from '../components/KebabMenu';
import { ConfirmModal } from '../components/ConfirmModal';
import { LinkModal } from '../components/LinkModal';
import { Modal } from '../components/Modal';
import { useIsCompact } from '../hooks/useIsMobile';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';

const noop = () => {};

function NewEntryModal({ templates, onCreate, onClose }: { templates: VaultTemplate[]; onCreate: (templateId?: string) => void; onClose: () => void }) {
  return (
    <Modal title="New Vault Entry" onClose={onClose}>
      <div className="vault-new-entry__list">
        <button className="vault-new-entry__option" onClick={() => onCreate()}>
          <span className="vault-new-entry__option-icon">📄</span>
          <span>
            <div className="vault-new-entry__option-title">Blank entry</div>
            <div className="vault-new-entry__option-sub">Start empty, add fields as you go</div>
          </span>
        </button>
        {templates.map((t) => (
          <button key={t.id} className="vault-new-entry__option" onClick={() => onCreate(t.id)}>
            <span className="vault-new-entry__option-icon">📋</span>
            <span>
              <div className="vault-new-entry__option-title">{t.name}</div>
              <div className="vault-new-entry__option-sub">{t.groups.length ? t.groups.map((g) => g.name).join(', ') : 'No preset fields'}</div>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function AddGroupModal({ groups, onAdd, onClose }: { groups: VaultFieldGroup[]; onAdd: (groupId: string) => void; onClose: () => void }) {
  return (
    <Modal title="Add a field group" onClose={onClose}>
      {groups.length === 0 ? (
        <div className="empty-state empty-state--section">
          No field groups yet — create one in Settings → Vault Fields first.
        </div>
      ) : (
        <div className="vault-new-entry__list">
          {groups.map((g) => (
            <button key={g.id} className="vault-new-entry__option" onClick={() => onAdd(g.id)}>
              <span className="vault-new-entry__option-icon">🗂️</span>
              <span>
                <div className="vault-new-entry__option-title">{g.name}</div>
                <div className="vault-new-entry__option-sub">{g.fields.map((f) => f.field_name).join(', ') || 'No fields'}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Vault — the Evernote-replacement filing cabinet: structured, form-driven
 * entries (grouped fields with copy/open icons, a freeform note body, and a
 * Media section for attachments) rather than freeform notes with tags.
 * Same split-view pattern as Notes (list + detail on desktop, list-then-
 * detail on mobile), since mobile here is mainly for *reading* an entry
 * back and desktop for building/editing one. */
export function VaultPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isCompact = useIsCompact();
  const { openTab, showContextMenu } = useTabs();

  const [entries, setEntries] = useState<Entity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultEntryDetail | null>(null);
  const [media, setMedia] = useState<Entity[]>([]);
  const [entryTitle, setEntryTitle] = useState('');
  const [templates, setTemplates] = useState<VaultTemplate[]>([]);
  const [groups, setGroups] = useState<VaultFieldGroup[]>([]);
  const [creating, setCreating] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [deleting, setDeleting] = useState<Entity | null>(null);

  const load = useCallback(() => {
    api.listVaultEntries().then(setEntries).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    api.listVaultTemplates().then(setTemplates).catch(() => {});
    api.listVaultGroups().then(setGroups).catch(() => {});
  }, [load]);

  const loadDetail = useCallback((entryId: string) => {
    api.getVaultEntry(entryId).then(setDetail).catch((e) => setError(String(e)));
    api.getEntity(entryId).then((d) => setMedia(d.children.filter((c) => c.type === 'file' || c.type === 'link'))).catch(() => setMedia([]));
  }, []);

  useEffect(() => {
    if (id) loadDetail(id);
    else setDetail(null);
  }, [id, loadDetail]);

  useEffect(() => {
    setEntryTitle(detail?.title ?? '');
  }, [detail?.id]);

  useReportTabMeta(detail ? entryTitle || 'Untitled Entry' : 'Vault', detail ? 'vault' : 'vault-list');

  async function handleCreate(templateId?: string) {
    const entry = await api.createVaultEntry({ template_id: templateId });
    setCreating(false);
    load();
    navigate(`/vault/${entry.id}`);
  }

  function handleTitleChange(value: string) {
    if (!detail) return;
    setEntryTitle(value);
    setEntries((prev) => (prev ? prev.map((e) => (e.id === detail.id ? { ...e, title: value } : e)) : prev));
    api.updateVaultEntry(detail.id, { title: value });
  }

  function handleContentSave(json: string) {
    if (!detail) return;
    api.updateVaultEntry(detail.id, { content: json });
  }

  async function togglePin(entry: Entity) {
    const next = entry.pinned === 1 ? 0 : 1;
    setEntries((prev) => (prev ? prev.map((e) => (e.id === entry.id ? { ...e, pinned: next } : e)) : prev));
    await api.setPinned(entry.id, next === 1);
    load();
  }

  async function deleteEntry(entry: Entity) {
    setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev));
    await api.deleteVaultEntry(entry.id);
    setDeleting(null);
    navigate('/vault');
  }

  async function handleAddGroup(groupId: string) {
    if (!detail) return;
    await api.addVaultEntryGroup(detail.id, groupId);
    setAddingGroup(false);
    loadDetail(detail.id);
  }

  async function handleRemoveGroup(entryGroupId: string) {
    if (!detail) return;
    await api.deleteVaultEntryGroup(entryGroupId);
    loadDetail(detail.id);
  }

  async function handleFieldSave(entryGroupId: string, fieldDefId: string, value: string | null) {
    if (!detail) return;
    // Bulk endpoint expects the whole group's values — but it upserts by
    // field_def_id, so a single-field array is enough; it won't touch
    // sibling fields in the same group.
    await api.saveVaultFieldValues(entryGroupId, [{ field_def_id: fieldDefId, value }]);
    loadDetail(detail.id);
  }

  async function uploadFile(file: File) {
    if (!detail) return;
    await api.uploadFile(file, detail.id);
    loadDetail(detail.id);
  }

  async function addLink(url: string, title: string) {
    if (!detail) return;
    await api.createLink(detail.id, url, title);
    setAddingLink(false);
    loadDetail(detail.id);
  }

  async function deleteMedia(entity: Entity) {
    await api.deleteEntity(entity.id);
    if (detail) loadDetail(detail.id);
  }

  async function toggleMediaPin(entity: Entity) {
    await api.setPinned(entity.id, entity.pinned !== 1);
    if (detail) loadDetail(detail.id);
  }

  if (error) return <div className="empty-state">Couldn't load Vault: {error}</div>;
  if (!entries) return <div className="empty-state">Loading…</div>;

  const showList = !isCompact || !id;
  const showDetail = !isCompact || !!id;

  return (
    <div>
      {showList && (
        <div className="toolbar-row">
          <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
            Vault
          </h1>
          <button className="btn" onClick={() => setCreating(true)}>
            + New Entry
          </button>
        </div>
      )}
      <div className={`notes-page${isCompact ? ' notes-page--mobile' : ''}`}>
        {showList && (
          <div className="notes-page__sidebar">
            {entries.length === 0 ? (
              <div className="empty-state empty-state--section">Nothing filed yet — add your first entry.</div>
            ) : (
              <div className="notes-page__list">
                {entries.map((e) => (
                  <div
                    key={e.id}
                    className={`notes-page__row${e.id === id ? ' is-active' : ''}`}
                    onClick={(ev) => {
                      if (ev.metaKey || ev.ctrlKey) {
                        openTab(`/vault/${e.id}`, { background: true, title: e.title || 'Untitled Entry', kind: 'vault' });
                        return;
                      }
                      navigate(`/vault/${e.id}`);
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      showContextMenu(ev.clientX, ev.clientY, [
                        { label: 'Open in New Tab', onClick: () => openTab(`/vault/${e.id}`, { background: true, title: e.title || 'Untitled Entry', kind: 'vault' }) },
                      ]);
                    }}
                  >
                    {e.pinned === 1 && (
                      <span className="notes-page__row-pin" title="Pinned">
                        📌
                      </span>
                    )}
                    <div className="notes-page__row-body">
                      <div className="notes-page__row-title-row">
                        <span className="notes-page__row-title">{e.title || 'Untitled Entry'}</span>
                        <span className="last-modified-badge" title={new Date(e.last_touched ?? e.updated_at).toLocaleString()}>
                          {formatRelativeTime(e.last_touched ?? e.updated_at)}
                        </span>
                      </div>
                    </div>
                    <KebabMenu
                      className="notes-page__row-kebab"
                      items={[
                        { label: e.pinned === 1 ? 'Unpin' : 'Pin to top', onClick: () => togglePin(e) },
                        { label: 'Delete', onClick: () => setDeleting(e), danger: true, separatorBefore: true },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {showDetail && detail && (
          <div className="notes-page__detail">
            {isCompact && (
              <div className="breadcrumb notes-page__back-row">
                <button type="button" className="breadcrumb__back" onClick={() => navigate('/vault')} title="Back" aria-label="Back">
                  ‹
                </button>
                <Link to="/vault" className="breadcrumb__link">
                  Vault
                </Link>
              </div>
            )}
            <div className="notes-page__detail-header">
              <input
                className="notes-page__title-input"
                value={entryTitle}
                placeholder="Untitled Entry"
                onChange={(e) => handleTitleChange(e.target.value)}
                onFocus={(e) => e.target.select()}
              />
            </div>

            <div className="vault-groups">
              {detail.groups.map((eg) => (
                <div key={eg.id} className="vault-group-card">
                  <div className="vault-group-card__header">
                    <span>{eg.label || eg.group?.name || 'Group'}</span>
                    <KebabMenu items={[{ label: 'Remove group', onClick: () => handleRemoveGroup(eg.id), danger: true }]} />
                  </div>
                  {(eg.group?.fields ?? []).map((f) => {
                    const fv = eg.values.find((v) => v.field_def_id === f.field_def_id);
                    return (
                      <VaultFieldRow
                        key={f.field_def_id}
                        label={f.field_name}
                        type={f.field_type}
                        value={fv?.value ?? null}
                        onSave={(v) => handleFieldSave(eg.id, f.field_def_id, v)}
                      />
                    );
                  })}
                </div>
              ))}
              <button type="button" className="vault-add-group-btn" onClick={() => setAddingGroup(true)}>
                + Add field group
              </button>
            </div>

            <Section title="Notes" defaultExpanded={!isCompact}>
              <NoteEditor key={detail.id} content={detail.content} onSave={handleContentSave} />
            </Section>

            <Section title="Media" count={media.length} defaultExpanded={!isCompact}>
              <div className="entity-card-grid">
                {media.map((m) => (
                  <EntityCard key={m.id} entity={m} onDelete={deleteMedia} onTogglePin={toggleMediaPin} onRename={noop} onPromote={noop} onDemote={noop} />
                ))}
                <NewFileTile onUploadFile={uploadFile} onAddLink={() => setAddingLink(true)} />
              </div>
            </Section>
          </div>
        )}

        {showDetail && !detail && (
          <div className="notes-page__detail notes-page__detail--empty">
            <div className="empty-state">Select an entry, or file your first one.</div>
          </div>
        )}
      </div>

      {creating && <NewEntryModal templates={templates} onCreate={handleCreate} onClose={() => setCreating(false)} />}
      {addingGroup && <AddGroupModal groups={groups} onAdd={handleAddGroup} onClose={() => setAddingGroup(false)} />}
      {addingLink && <LinkModal onSave={addLink} onClose={() => setAddingLink(false)} />}

      {deleting && (
        <ConfirmModal
          title="Delete this entry?"
          body={`"${deleting.title || 'Untitled'}" will be permanently deleted, including its attachments.`}
          onConfirm={() => deleteEntry(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
