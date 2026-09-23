import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, VaultEntryDetail, VaultFact } from '../api/types';
import { EntityCard } from '../components/EntityCard';
import { TaskRow } from '../components/TaskRow';
import { NewTaskRow } from '../components/NewTaskRow';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { NewNoteTile, NewFileTile, NewPasswordTile } from '../components/NewItemTiles';
import { Section } from '../components/Section';
import { VaultFactsTable } from '../components/VaultFactsTable';
import { VaultLinkRow } from '../components/VaultLinkRow';
import { VaultNoteModal } from '../components/VaultNoteModal';
import { PasswordCard } from '../components/PasswordCard';
import { PasswordDetailModal } from '../components/PasswordDetailModal';
import { KebabMenu } from '../components/KebabMenu';
import { ConfirmModal } from '../components/ConfirmModal';
import { LinkModal } from '../components/LinkModal';
import { RenameModal } from '../components/RenameModal';
import { ExpirationModal } from '../components/ExpirationModal';
import { useIsCompact } from '../hooks/useIsMobile';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';

const noop = () => {};
// is_password entries are type='note' children too (see the is_jot/is_list
// flag-on-existing-type precedent) — excluded here so a password card
// doesn't also render in the plain Notes section below.
const isFileOrNote = (c: Entity) => (c.type === 'file' || c.type === 'note') && c.is_password !== 1;

/** Vault — the Evernote-replacement filing cabinet. An entry is a lightweight
 * quick-facts table (label/value, added inline — no field/group/template
 * setup) plus the same Notes/Links/Tasks/Pinned children Projects already
 * use, reframed as reference rather than active work: no status lifecycle,
 * no folder nesting. A "Folder" from v1 is gone — Google Drive is the real
 * file repository, so a folder's job is now just a styled Link to it. */
export function VaultPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isCompact = useIsCompact();
  const { openTab, showContextMenu } = useTabs();

  const [entries, setEntries] = useState<Entity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultEntryDetail | null>(null);
  const [children, setChildren] = useState<Entity[]>([]);
  const [entryTitle, setEntryTitle] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [renaming, setRenaming] = useState<Entity | null>(null);
  const [settingExpiration, setSettingExpiration] = useState<Entity | null>(null);
  const [openNote, setOpenNote] = useState<Entity | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);
  const [openPassword, setOpenPassword] = useState<Entity | null>(null);

  const load = useCallback(() => {
    api.listVaultEntries().then(setEntries).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback((entryId: string) => {
    api.getVaultEntry(entryId).then(setDetail).catch((e) => setError(String(e)));
    api.getEntity(entryId).then((d) => setChildren(d.children)).catch(() => setChildren([]));
  }, []);

  useEffect(() => {
    if (id) loadDetail(id);
    else setDetail(null);
  }, [id, loadDetail]);

  useEffect(() => {
    setEntryTitle(detail?.title ?? '');
  }, [detail?.id]);

  useReportTabMeta(detail ? entryTitle || 'Untitled Entry' : 'Vault', detail ? 'vault' : 'vault-list');

  async function handleCreate() {
    const entry = await api.createVaultEntry();
    load();
    navigate(`/vault/${entry.id}`);
  }

  function handleTitleChange(value: string) {
    if (!detail) return;
    setEntryTitle(value);
    setEntries((prev) => (prev ? prev.map((e) => (e.id === detail.id ? { ...e, title: value } : e)) : prev));
    api.updateVaultEntry(detail.id, { title: value });
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

  // ---- Quick facts ----

  async function addFact(label: string, value: string) {
    if (!detail) return;
    const fact = await api.addVaultFact(detail.id, label, value || null);
    setDetail((prev) => (prev ? { ...prev, facts: [...prev.facts, fact] } : prev));
  }

  async function updateFact(fact: VaultFact, patch: { label?: string; value?: string }) {
    const updated = await api.updateVaultFact(fact.id, { label: patch.label, value: patch.value ?? undefined });
    setDetail((prev) => (prev ? { ...prev, facts: prev.facts.map((f) => (f.id === fact.id ? updated : f)) } : prev));
  }

  async function deleteFact(fact: VaultFact) {
    setDetail((prev) => (prev ? { ...prev, facts: prev.facts.filter((f) => f.id !== fact.id) } : prev));
    await api.deleteVaultFact(fact.id);
  }

  async function reorderFacts(orderedIds: string[]) {
    if (!detail) return;
    const byId = new Map(detail.facts.map((f) => [f.id, f]));
    setDetail((prev) => (prev ? { ...prev, facts: orderedIds.map((fid) => byId.get(fid)!).filter(Boolean) } : prev));
    await api.reorderVaultFacts(detail.id, orderedIds);
  }

  // ---- Children: Notes (incl. uploaded files), Links, Tasks, Pinned ----

  async function createNote() {
    if (!detail) return;
    const note = await api.createEntity({ type: 'note', parent_id: detail.id });
    loadDetail(detail.id);
    setOpenNote(note);
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

  async function createTask(title: string) {
    if (!detail) return;
    await api.createEntity({ type: 'task', parent_id: detail.id, title });
    loadDetail(detail.id);
  }

  async function toggleTask(entity: Entity) {
    const nextStatus = entity.status === 'done' ? 'open' : 'done';
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? { ...c, status: nextStatus } : c)));
    await api.updateEntity(entity.id, { status: nextStatus });
  }

  async function togglePinChild(entity: Entity) {
    const next = entity.pinned === 1 ? 0 : 1;
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? { ...c, pinned: next } : c)));
    await api.setPinned(entity.id, next === 1);
  }

  async function deleteChild(entity: Entity) {
    setChildren((prev) => prev.filter((c) => c.id !== entity.id));
    await api.deleteEntity(entity.id);
    setDeleting(null);
    if (openNote?.id === entity.id) setOpenNote(null);
    if (openPassword?.id === entity.id) setOpenPassword(null);
  }

  async function renameChild(entity: Entity, newTitle: string) {
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? { ...c, title: newTitle } : c)));
    setRenaming(null);
    await api.updateEntity(entity.id, { title: newTitle });
  }

  async function setChildExpiration(entity: Entity, expiresAt: string | null) {
    const updated = await api.updateEntity(entity.id, { expires_at: expiresAt });
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? updated : c)));
    setSettingExpiration(null);
  }

  function saveNoteTitle(noteId: string, title: string) {
    setChildren((prev) => prev.map((c) => (c.id === noteId ? { ...c, title } : c)));
    api.updateEntity(noteId, { title });
  }

  function saveNoteContent(noteId: string, json: string) {
    api.updateEntity(noteId, { content: json });
  }

  // ---- Passwords ----

  async function createPassword() {
    if (!detail) return;
    const password = await api.createVaultPassword(detail.id, {});
    loadDetail(detail.id);
    setOpenPassword(password);
  }

  async function savePassword(entity: Entity, patch: { title?: string; url?: string; username?: string; password?: string }) {
    const updated = await api.updateVaultPassword(entity.id, patch);
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? updated : c)));
    setOpenPassword((prev) => (prev && prev.id === entity.id ? updated : prev));
  }

  if (error) return <div className="empty-state">Couldn't load Vault: {error}</div>;
  if (!entries) return <div className="empty-state">Loading…</div>;

  const showList = !isCompact || !id;
  const showDetail = !isCompact || !!id;

  const notes = children.filter(isFileOrNote);
  const passwords = children.filter((c) => c.is_password === 1);
  const links = children.filter((c) => c.type === 'link');
  const tasks = children.filter((c) => c.type === 'task');
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const pinned = children.filter((c) => c.pinned === 1);

  return (
    <div>
      {showList && (
        <div className="toolbar-row">
          <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
            Vault
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/vault/rollups" className="btn btn--ghost">
              Rollups
            </Link>
            <button className="btn" onClick={handleCreate}>
              + New Entry
            </button>
          </div>
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

            <Section title="Quick facts" defaultExpanded={true}>
              <VaultFactsTable facts={detail.facts} onAdd={addFact} onUpdate={updateFact} onDelete={deleteFact} onReorder={reorderFacts} />
            </Section>

            {pinned.length > 0 && (
              <Section title="Pinned" count={pinned.length} defaultExpanded={true}>
                <div className="entity-card-grid">
                  {pinned.map((c) =>
                    c.type === 'link' ? (
                      <VaultLinkRow key={c.id} entity={c} onDelete={setDeleting} onTogglePin={togglePinChild} />
                    ) : c.type === 'task' ? (
                      <TaskRow key={c.id} entity={c} onToggle={toggleTask} onDelete={setDeleting} onTogglePin={togglePinChild} onOpen={(e) => setTaskStack([e.id])} />
                    ) : (
                      <EntityCard
                        key={c.id}
                        entity={c}
                        onDelete={setDeleting}
                        onTogglePin={togglePinChild}
                        onRename={setRenaming}
                        onPromote={noop}
                        onDemote={noop}
                        onOpenNote={setOpenNote}
                        onSetExpiration={setSettingExpiration}
                        compact
                      />
                    )
                  )}
                </div>
              </Section>
            )}

            <Section title="Notes" count={notes.length} defaultExpanded={!isCompact}>
              <div className="entity-card-grid">
                {notes.map((c) => (
                  <EntityCard
                    key={c.id}
                    entity={c}
                    onDelete={setDeleting}
                    onTogglePin={togglePinChild}
                    onRename={setRenaming}
                    onPromote={noop}
                    onDemote={noop}
                    onOpenNote={setOpenNote}
                    onSetExpiration={setSettingExpiration}
                    compact={isCompact}
                  />
                ))}
                <NewNoteTile onCreate={createNote} compact={isCompact} />
                <NewFileTile onUploadFile={uploadFile} onAddLink={() => setAddingLink(true)} />
              </div>
            </Section>

            <Section title="Passwords" count={passwords.length} defaultExpanded={!isCompact}>
              <div className="entity-card-grid">
                {passwords.map((c) => (
                  <PasswordCard key={c.id} entity={c} onOpen={setOpenPassword} onDelete={setDeleting} />
                ))}
                <NewPasswordTile onCreate={createPassword} />
              </div>
            </Section>

            <Section title="Links" count={links.length} defaultExpanded={!isCompact}>
              <div className="vault-link-list">
                {links.map((c) => (
                  <VaultLinkRow key={c.id} entity={c} onDelete={setDeleting} onTogglePin={togglePinChild} />
                ))}
                <button type="button" className="vault-link-row vault-link-row--ghost" onClick={() => setAddingLink(true)}>
                  ＋ add a link
                </button>
              </div>
            </Section>

            <Section title="Tasks" count={openTasks.length} defaultExpanded={true}>
              <div className="task-list">
                {openTasks.map((c) => (
                  <TaskRow key={c.id} entity={c} onToggle={toggleTask} onDelete={setDeleting} onTogglePin={togglePinChild} onOpen={(e) => setTaskStack([e.id])} />
                ))}
                <NewTaskRow onCreate={createTask} />
                {doneTasks.length > 0 && (
                  <>
                    <div className="task-divider">Completed</div>
                    {doneTasks.map((c) => (
                      <TaskRow key={c.id} entity={c} onToggle={toggleTask} onDelete={setDeleting} onTogglePin={togglePinChild} onOpen={(e) => setTaskStack([e.id])} />
                    ))}
                  </>
                )}
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

      {addingLink && <LinkModal onSave={addLink} onClose={() => setAddingLink(false)} />}

      {renaming && (
        <RenameModal
          initialValue={renaming.title}
          label={renaming.type === 'file' ? 'File Name' : 'Name'}
          onSave={(v) => renameChild(renaming, v)}
          onClose={() => setRenaming(null)}
        />
      )}

      {settingExpiration && (
        <ExpirationModal
          title={settingExpiration.title || 'Untitled'}
          initialValue={settingExpiration.expires_at}
          onSave={(expiresAt) => setChildExpiration(settingExpiration, expiresAt)}
          onClose={() => setSettingExpiration(null)}
        />
      )}

      {openNote && (
        <VaultNoteModal
          note={openNote}
          onSaveTitle={(title) => saveNoteTitle(openNote.id, title)}
          onSaveContent={(json) => saveNoteContent(openNote.id, json)}
          onClose={() => setOpenNote(null)}
        />
      )}

      {openPassword && (
        <PasswordDetailModal
          entity={openPassword}
          onSave={(patch) => savePassword(openPassword, patch)}
          onDelete={() => deleteChild(openPassword)}
          onClose={() => setOpenPassword(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.type === 'vault_entry' ? 'this entry' : deleting.type}?`}
          body={
            deleting.type === 'vault_entry'
              ? `"${deleting.title || 'Untitled'}" will be permanently deleted, including its facts and attachments.`
              : `"${deleting.title || 'Untitled'}" will be permanently deleted.`
          }
          onConfirm={() => (deleting.type === 'vault_entry' ? deleteEntry(deleting) : deleteChild(deleting))}
          onCancel={() => setDeleting(null)}
        />
      )}

      {taskStack.length > 0 && detail && (
        <TaskDetailModal
          key={taskStack[taskStack.length - 1]}
          taskId={taskStack[taskStack.length - 1]}
          onBack={taskStack.length > 1 ? () => setTaskStack((prev) => prev.slice(0, -1)) : undefined}
          onClose={() => setTaskStack([])}
          onOpenSubtask={(taskId) => setTaskStack((prev) => [...prev, taskId])}
          onMutated={() => loadDetail(detail.id)}
          onRequestDelete={(entityToDelete) => {
            setTaskStack([]);
            setDeleting(entityToDelete);
          }}
        />
      )}
    </div>
  );
}
