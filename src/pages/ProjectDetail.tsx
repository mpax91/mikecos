import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, EntityDetail } from '../api/types';
import { Breadcrumb } from '../components/Breadcrumb';
import { NoteEditor } from '../components/NoteEditor';
import { EntityCard } from '../components/EntityCard';
import { FolderTile } from '../components/FolderTile';
import { TaskRow } from '../components/TaskRow';
import { NewTaskRow } from '../components/NewTaskRow';
import { NewFolderTile, NewNoteTile, NewFileTile } from '../components/NewItemTiles';
import { Section } from '../components/Section';
import { EditableText } from '../components/EditableText';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { LinkModal } from '../components/LinkModal';

const isFileOrLink = (c: Entity) => c.type === 'file' || c.type === 'link';

function typePredicate(type: Entity['type']): (e: Entity) => boolean {
  if (type === 'file' || type === 'link') return isFileOrLink;
  return (e: Entity) => e.type === type;
}

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewNote = Boolean((location.state as { isNew?: boolean } | null)?.isNew);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [renaming, setRenaming] = useState<Entity | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [addingLink, setAddingLink] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api
      .getEntity(id)
      .then((d) => {
        setDetail(d);
        setNoteTitle(d.entity.title);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    load();
  }, [load]);

  async function createChild(type: 'folder' | 'note') {
    if (!id) return;
    const child = await api.createEntity({ type, parent_id: id });
    if (type === 'note') {
      // The isNew flag tells the note screen to auto-select its title
      // input on mount, so typing a real name replaces "Untitled Note"
      // immediately instead of requiring a separate rename step later.
      navigate(`/projects/${child.id}`, { state: { isNew: true } });
    } else {
      load();
      // Same idea for folders: open straight into rename instead of
      // leaving it titled "New Folder" until the user thinks to fix it.
      setRenaming(child);
    }
  }

  async function createTask(title: string) {
    if (!id) return;
    await api.createEntity({ type: 'task', parent_id: id, title });
    load();
  }

  async function addLink(url: string, title: string) {
    if (!id) return;
    await api.createLink(id, url, title);
    setAddingLink(false);
    load();
  }

  async function uploadFile(file: File) {
    if (!id) return;
    await api.uploadFile(file, id);
    load();
  }

  async function toggleTask(entity: Entity) {
    const nextStatus = entity.status === 'done' ? 'open' : 'done';
    setDetail((prev) =>
      prev
        ? { ...prev, children: prev.children.map((c) => (c.id === entity.id ? { ...c, status: nextStatus } : c)) }
        : prev
    );
    await api.updateEntity(entity.id, { status: nextStatus });
  }

  async function renameEntity(entity: Entity, newTitle: string) {
    setDetail((prev) =>
      prev
        ? { ...prev, children: prev.children.map((c) => (c.id === entity.id ? { ...c, title: newTitle } : c)) }
        : prev
    );
    await api.updateEntity(entity.id, { title: newTitle });
  }

  async function togglePin(entity: Entity) {
    const next = entity.pinned === 1 ? 0 : 1;
    setDetail((prev) =>
      prev
        ? { ...prev, children: prev.children.map((c) => (c.id === entity.id ? { ...c, pinned: next } : c)) }
        : prev
    );
    await api.setPinned(entity.id, next === 1);
  }

  async function deleteEntity(entity: Entity) {
    setDetail((prev) => (prev ? { ...prev, children: prev.children.filter((c) => c.id !== entity.id) } : prev));
    await api.deleteEntity(entity.id);
    setDeleting(null);
  }

  async function reorderGroup(predicate: (e: Entity) => boolean, ordered: Entity[]) {
    if (!id) return;
    setDetail((prev) => {
      if (!prev) return prev;
      const others = prev.children.filter((c) => !predicate(c));
      return { ...prev, children: [...others, ...ordered] };
    });
    await api.reorder(
      id,
      ordered.map((o) => o.id)
    );
  }

  // Promote/demote replace drag-to-reorder: swap an item with its neighbor
  // within its own section (folders move among folders, tasks among tasks,
  // etc.) and persist the swap the same way a drag reorder used to.
  function groupFor(entity: Entity): Entity[] {
    if (!detail) return [];
    const predicate = typePredicate(entity.type);
    return detail.children.filter(predicate);
  }

  function promote(entity: Entity) {
    const group = groupFor(entity);
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx <= 0) return;
    const ordered = [...group];
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    reorderGroup(typePredicate(entity.type), ordered);
  }

  function demote(entity: Entity) {
    const group = groupFor(entity);
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx === -1 || idx >= group.length - 1) return;
    const ordered = [...group];
    [ordered[idx + 1], ordered[idx]] = [ordered[idx], ordered[idx + 1]];
    reorderGroup(typePredicate(entity.type), ordered);
  }

  // Bound to the loaded entity's own id (not the route param `id`), which
  // only changes once the fetch for the new route resolves. The route id
  // updates immediately on navigation, one render before `detail` catches
  // up — binding to it here would let a stale note's save land on whatever
  // entity the URL just changed to.
  function handleNoteTitleChange(value: string, noteId: string) {
    setNoteTitle(value);
    api.updateEntity(noteId, { title: value });
  }

  function handleNoteContentSave(json: string, noteId: string) {
    api.updateEntity(noteId, { content: json });
  }

  if (error) return <div className="empty-state">Couldn't load: {error}</div>;
  if (!detail) return <div className="empty-state">Loading…</div>;

  const { entity, breadcrumb, children } = detail;

  if (entity.type === 'note') {
    return (
      <div>
        <Breadcrumb trail={breadcrumb} current={entity} />
        <input
          className="project-header__title"
          style={{
            border: 'none',
            background: 'transparent',
            width: '100%',
            fontFamily: 'var(--font-serif)',
            fontSize: 22,
            padding: 0,
            marginBottom: 16,
          }}
          value={noteTitle}
          placeholder="Untitled Note"
          onChange={(e) => handleNoteTitleChange(e.target.value, entity.id)}
          onFocus={(e) => e.target.select()}
          autoFocus={isNewNote}
        />
        {/* key={entity.id} forces a full remount (not a prop update) when
            navigating between notes, so the flush-on-unmount save in
            NoteEditor always fires against the note it was actually
            editing, never a transient mismatch during route changes. */}
        <NoteEditor
          key={entity.id}
          content={entity.content}
          onSave={(json) => handleNoteContentSave(json, entity.id)}
        />
      </div>
    );
  }

  const folders = children.filter((c) => c.type === 'folder');
  const notes = children.filter((c) => c.type === 'note');
  const files = children.filter(isFileOrLink);
  const tasks = children.filter((c) => c.type === 'task');
  // Completed tasks render in their own group below a divider rather than
  // sitting wherever they happened to be created — a display-only split, so
  // promote/demote (which act on `tasks` in its real position order) keep
  // working the same way underneath.
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');
  // Pinned items from every section, in one quick-reference list — only on
  // the project's own top-level screen, not inside a folder.
  const pinned = entity.is_top_level ? children.filter((c) => c.pinned === 1) : [];

  function renderTile(c: Entity) {
    if (c.type === 'folder') {
      return (
        <FolderTile
          key={c.id}
          entity={c}
          onDelete={setDeleting}
          onTogglePin={togglePin}
          onRename={setRenaming}
          onPromote={promote}
          onDemote={demote}
        />
      );
    }
    if (c.type === 'task') {
      return (
        <TaskRow
          key={c.id}
          entity={c}
          onToggle={toggleTask}
          onDelete={setDeleting}
          onTogglePin={togglePin}
          onRename={renameEntity}
          onPromote={promote}
          onDemote={demote}
        />
      );
    }
    return (
      <EntityCard
        key={c.id}
        entity={c}
        onDelete={setDeleting}
        onTogglePin={togglePin}
        onRename={setRenaming}
        onPromote={promote}
        onDemote={demote}
      />
    );
  }

  return (
    <div>
      <Breadcrumb trail={breadcrumb} current={entity} />

      {entity.is_top_level ? (
        <div className="project-header">
          <EditableText
            value={entity.title}
            placeholder="Untitled Project"
            onSave={(v) => id && api.updateEntity(id, { title: v })}
            className="project-header__title-input"
            displayClassName="project-header__title"
          />
        </div>
      ) : (
        <EditableText
          value={entity.title}
          placeholder="Untitled Folder"
          onSave={(v) => id && api.updateEntity(id, { title: v })}
          className="folder-header-input"
          displayClassName="folder-header"
        />
      )}

      {entity.is_top_level && (
        <Section title="Pinned">
          {pinned.length === 0 ? (
            <div className="empty-state empty-state--section">Pin anything from below to keep it here for quick reference.</div>
          ) : (
            <div className="entity-card-grid">{pinned.map(renderTile)}</div>
          )}
        </Section>
      )}

      <Section title="Folders">
        <div className="folder-tile-grid">
          {folders.map(renderTile)}
          <NewFolderTile onCreate={() => createChild('folder')} />
        </div>
      </Section>

      <Section title="Notes">
        <div className="entity-card-grid">
          {notes.map(renderTile)}
          <NewNoteTile onCreate={() => createChild('note')} />
        </div>
      </Section>

      <Section title="Media">
        <div className="entity-card-grid">
          {files.map(renderTile)}
          <NewFileTile onUploadFile={uploadFile} onAddLink={() => setAddingLink(true)} />
        </div>
      </Section>

      <Section title="Tasks">
        <div className="task-list">
          {openTasks.map(renderTile)}
          <NewTaskRow onCreate={createTask} />
          {doneTasks.length > 0 && (
            <>
              <div className="task-divider">Completed</div>
              {doneTasks.map(renderTile)}
            </>
          )}
        </div>
      </Section>

      {renaming && (
        <RenameModal
          initialValue={renaming.title}
          label={renaming.type === 'folder' ? 'Folder Name' : 'Name'}
          onSave={(v) => renameEntity(renaming, v)}
          onClose={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.type}?`}
          body={
            deleting.type === 'folder'
              ? `"${deleting.title}" and everything inside it will be permanently deleted.`
              : `"${deleting.title || 'Untitled'}" will be permanently deleted.`
          }
          onConfirm={() => deleteEntity(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {addingLink && <LinkModal onSave={addLink} onClose={() => setAddingLink(false)} />}
    </div>
  );
}
