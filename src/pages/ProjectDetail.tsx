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
import { TaskDetailModal } from '../components/TaskDetailModal';
import { NewFolderTile, NewNoteTile, NewFileTile } from '../components/NewItemTiles';
import { Section } from '../components/Section';
import { EditableText } from '../components/EditableText';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { LinkModal } from '../components/LinkModal';
import { Toast } from '../components/Toast';
import { useIsMobile } from '../hooks/useIsMobile';

const isFileOrLink = (c: Entity) => c.type === 'file' || c.type === 'link';

function typePredicate(type: Entity['type']): (e: Entity) => boolean {
  if (type === 'file' || type === 'link') return isFileOrLink;
  return (e: Entity) => e.type === type;
}

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const isNewNote = Boolean((location.state as { isNew?: boolean } | null)?.isNew);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [renaming, setRenaming] = useState<Entity | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [toast, setToast] = useState<{ message: string; actionLabel?: string; onAction?: () => void } | null>(null);
  // Stack of task ids for the Todoist-style detail panel: [taskId] when a
  // top-level task/subtask is opened from the project list, with deeper
  // ids pushed as the panel itself drills into a subtask's own subtasks.
  const [taskStack, setTaskStack] = useState<string[]>([]);

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

  // Tasks can be a direct child of the project OR nested one level deeper
  // as a subtask (attached under a parent task's own `.subtasks`, not in
  // the flat `children` array) — these helpers patch/remove at whichever
  // level actually holds the id so optimistic updates work for both.
  function mapChildrenWithSubtasks(list: Entity[], targetId: string, patch: Partial<Entity>): Entity[] {
    return list.map((c) => {
      if (c.id === targetId) return { ...c, ...patch };
      if (c.subtasks?.length) {
        return { ...c, subtasks: c.subtasks.map((s) => (s.id === targetId ? { ...s, ...patch } : s)) };
      }
      return c;
    });
  }

  function removeChildEverywhere(list: Entity[], targetId: string): Entity[] {
    return list
      .filter((c) => c.id !== targetId)
      .map((c) => (c.subtasks?.length ? { ...c, subtasks: c.subtasks.filter((s) => s.id !== targetId) } : c));
  }

  async function toggleTask(entity: Entity) {
    const nextStatus = entity.status === 'done' ? 'open' : 'done';
    setDetail((prev) => (prev ? { ...prev, children: mapChildrenWithSubtasks(prev.children, entity.id, { status: nextStatus }) } : prev));
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
    setDetail((prev) => (prev ? { ...prev, children: mapChildrenWithSubtasks(prev.children, entity.id, { pinned: next }) } : prev));
    await api.setPinned(entity.id, next === 1);
  }

  async function deleteEntity(entity: Entity) {
    setDetail((prev) => (prev ? { ...prev, children: removeChildEverywhere(prev.children, entity.id) } : prev));
    await api.deleteEntity(entity.id);
    setDeleting(null);
  }

  // Reverse of Notes' "Move to Project": pulls a project note back out to
  // the standalone Notes section, with the same undo affordance.
  async function moveToNotes(entity: Entity) {
    if (!detail) return;
    const movedTitle = entity.title || 'Untitled Note';
    // The entity this page is showing may itself be a folder nested inside
    // the project, not the project — walk up via the breadcrumb to find the
    // actual top-level project whose "last modified" badge is affected.
    const projectAncestor = detail.entity.is_top_level ? detail.entity : detail.breadcrumb[0];
    const previousLastTouched = projectAncestor?.last_touched ?? null;
    setDetail((prev) => (prev ? { ...prev, children: removeChildEverywhere(prev.children, entity.id) } : prev));
    await api.moveEntity(entity.id, null);
    setToast({
      message: `"${movedTitle}" moved to Notes.`,
      actionLabel: 'Undo',
      onAction: async () => {
        if (!id) return;
        await api.moveEntity(entity.id, id);
        // Restore the project's "last modified" stamp to what it was before
        // this move — otherwise a move-then-immediate-undo still leaves the
        // project looking freshly touched.
        if (projectAncestor) await api.updateEntity(projectAncestor.id, { last_touched: previousLastTouched });
        load();
      },
    });
  }

  function openTask(entity: Entity) {
    setTaskStack([entity.id]);
  }

  function openSubtask(taskId: string) {
    setTaskStack((prev) => [...prev, taskId]);
  }

  function backTask() {
    setTaskStack((prev) => prev.slice(0, -1));
  }

  function closeTaskModal() {
    setTaskStack([]);
  }

  // Persist a new order for exactly the entities in `orderedIds` (the API
  // only touches those rows) and reload from the server rather than
  // hand-splicing local state — `position` is one flat field shared by every
  // child regardless of type, so a reorder scoped to one slice (a type group,
  // or the cross-type Pinned list) can shift how children interleave in ways
  // a naive local splice won't reproduce. Refetching guarantees what's on
  // screen always matches what's actually persisted.
  async function persistReorder(orderedIds: string[]) {
    if (!id) return;
    await api.reorder(id, orderedIds);
    load();
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

  // Promote/demote replace drag-to-reorder: swap an item with its neighbor
  // within its own section (folders move among folders, tasks among tasks,
  // etc.) and persist the swap the same way a drag reorder used to.
  function groupFor(entity: Entity): Entity[] {
    if (!detail) return [];
    const predicate = typePredicate(entity.type);
    return detail.children.filter(predicate);
  }

  function promote(entity: Entity) {
    promoteWithin(groupFor(entity), entity);
  }

  function demote(entity: Entity) {
    demoteWithin(groupFor(entity), entity);
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

  // Inside Pinned, "promote/demote" needs to move an item relative to its
  // fellow pinned items (any type), not relative to its type-siblings —
  // otherwise promoting the one pinned note is a no-op whenever it's already
  // first among ALL notes, pinned or not, even though it visually sits next
  // to a pinned file it should be able to swap with.
  function renderTile(c: Entity, isPinnedView = false) {
    const onPromote = isPinnedView ? (e: Entity) => promoteWithin(pinned, e) : promote;
    const onDemote = isPinnedView ? (e: Entity) => demoteWithin(pinned, e) : demote;
    // On phone widths a full-size post-it note is too large next to everything
    // else in its section, so notes borrow the same compact rectangle sizing
    // Pinned already uses — purely visual, unrelated to promote/demote scope.
    const compact = isPinnedView || (isMobile && c.type === 'note');
    if (c.type === 'folder') {
      return (
        <FolderTile
          key={c.id}
          entity={c}
          onDelete={setDeleting}
          onTogglePin={togglePin}
          onRename={setRenaming}
          onPromote={onPromote}
          onDemote={onDemote}
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
          onOpen={openTask}
          onPromote={onPromote}
          onDemote={onDemote}
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
        onPromote={onPromote}
        onDemote={onDemote}
        onMoveToNotes={c.type === 'note' ? moveToNotes : undefined}
        compact={compact}
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
        <Section title="Pinned" count={pinned.length} defaultExpanded={!isMobile}>
          {pinned.length === 0 ? (
            <div className="empty-state empty-state--section">Pin anything from below to keep it here for quick reference.</div>
          ) : (
            <div className="entity-card-grid">{pinned.map((c) => renderTile(c, true))}</div>
          )}
        </Section>
      )}

      <Section title="Folders" count={folders.length} defaultExpanded={!isMobile}>
        <div className="folder-tile-grid">
          {folders.map((c) => renderTile(c))}
          <NewFolderTile onCreate={() => createChild('folder')} />
        </div>
      </Section>

      <Section title="Notes" count={notes.length} defaultExpanded={!isMobile}>
        <div className="entity-card-grid">
          {notes.map((c) => renderTile(c))}
          <NewNoteTile onCreate={() => createChild('note')} compact={isMobile} />
        </div>
      </Section>

      <Section title="Media" count={files.length} defaultExpanded={!isMobile}>
        <div className="entity-card-grid">
          {files.map((c) => renderTile(c))}
          <NewFileTile onUploadFile={uploadFile} onAddLink={() => setAddingLink(true)} />
        </div>
      </Section>

      <Section title="Tasks" count={openTasks.length} defaultExpanded={!isMobile}>
        <div className="task-list">
          {openTasks.map((c) => renderTile(c))}
          <NewTaskRow onCreate={createTask} />
          {doneTasks.length > 0 && (
            <>
              <div className="task-divider">Completed</div>
              {doneTasks.map((c) => renderTile(c))}
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

      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}

      {taskStack.length > 0 && (
        <TaskDetailModal
          key={taskStack[taskStack.length - 1]}
          taskId={taskStack[taskStack.length - 1]}
          onBack={taskStack.length > 1 ? backTask : undefined}
          onClose={closeTaskModal}
          onOpenSubtask={openSubtask}
          onMutated={load}
          onRequestDelete={(entityToDelete) => {
            closeTaskModal();
            setDeleting(entityToDelete);
          }}
        />
      )}
    </div>
  );
}
