import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, VaultEntryDetail, VaultFact } from '../api/types';
import { EntityCard } from '../components/EntityCard';
import { NewFileTile, NewPasswordTile } from '../components/NewItemTiles';
import { Section } from '../components/Section';
import { VaultFactsTable } from '../components/VaultFactsTable';
import { VaultLinkRow } from '../components/VaultLinkRow';
import { VaultNoteRow } from '../components/VaultNoteRow';
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

// is_password entries are type='note' children too (see the is_jot/is_list
// flag-on-existing-type precedent) — excluded here so a password card
// doesn't also render in the plain Notes section below.
const isPlainNote = (c: Entity) => c.type === 'note' && c.is_password !== 1;

/** Vault — the Evernote-replacement filing cabinet. An entry is a lightweight
 * quick-facts table (label/value, added inline — no field/group/template
 * setup) plus Attachments/Notes/Passwords/Links children, reframed as
 * reference rather than active work: no status lifecycle, no folder
 * nesting, and — as of 0044_vault_drop_tasks — no Tasks section either,
 * since a Vault attachment's own expiration date already covers the
 * renewal-reminder case a per-entry to-do list would have been used for
 * (see ExpirationModal / the "Renew: ..." task it generates in Today). A
 * "Folder" from v1 is gone too — Google Drive is the real file repository,
 * so a folder's job is now just a styled Link to it. */
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

  // ---- Children: Attachments, Notes, Links, Pinned ----

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

  async function togglePinChild(entity: Entity) {
    const next = entity.pinned === 1 ? 0 : 1;
    setChildren((prev) => prev.map((c) => (c.id === entity.id ? { ...c, pinned: next } : c)));
    await api.setPinned(entity.id, next === 1);
  }

  // Promote/demote swap an item with its neighbor within a given group and
  // persist via the same scoped reorder endpoint ProjectDetail uses — see
  // its promoteWithin/demoteWithin for why a refetch (not a local splice)
  // is what keeps `position` correct once children can mix groups (Pinned).
  async function persistReorder(orderedIds: string[]) {
    if (!detail) return;
    await api.reorder(detail.id, orderedIds);
    loadDetail(detail.id);
  }

  function promoteWithin(group: Entity[], entity: Entity) {
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx <= 0) return;
    const ordered = [...group];
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    persistReorder(ordered.map((o) => o.id));
  }

  function demoteWithin(group: Entity[], entity: Entity) {
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx === -1 || idx >= group.length - 1) return;
    const ordered = [...group];
    [ordered[idx + 1], ordered[idx]] = [ordered[idx], ordered[idx + 1]];
    persistReorder(ordered.map((o) => o.id));
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

  const attachments = children.filter((c) => c.type === 'file');
  const notes = children.filter(isPlainNote);
  const passwords = children.filter((c) => c.is_password === 1);
  const links = children.filter((c) => c.type === 'link');
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
                    ) : (
                      <EntityCard
                        key={c.id}
                        entity={c}
                        onDelete={setDeleting}
                        onTogglePin={togglePinChild}
                        onRename={setRenaming}
                        onPromote={(e) => promoteWithin(pinned, e)}
                        onDemote={(e) => demoteWithin(pinned, e)}
                        onOpenNote={setOpenNote}
                        onSetExpiration={setSettingExpiration}
                        compact
                      />
                    )
                  )}
                </div>
              </Section>
            )}

            <Section title="Attachments" count={attachments.length} defaultExpanded={!isCompact}>
              <div className="entity-card-grid">
                {attachments.map((c) => (
                  <EntityCard
                    key={c.id}
                    entity={c}
                    onDelete={setDeleting}
                    onTogglePin={togglePinChild}
                    onRename={setRenaming}
                    onPromote={(e) => promoteWithin(attachments, e)}
                    onDemote={(e) => demoteWithin(attachments, e)}
                    onSetExpiration={setSettingExpiration}
                    compact={isCompact}
                  />
                ))}
                <NewFileTile onUploadFile={uploadFile} onAddLink={() => setAddingLink(true)} />
              </div>
            </Section>

            <Section title="Notes" count={notes.length} defaultExpanded={!isCompact}>
              <div className="vault-note-list">
                {notes.map((c) => (
                  <VaultNoteRow key={c.id} entity={c} onOpen={setOpenNote} onDelete={setDeleting} onTogglePin={togglePinChild} />
                ))}
                <button type="button" className="vault-note-row vault-note-row--ghost" onClick={createNote}>
                  ＋ new note
                </button>
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
    </div>
  );
}
