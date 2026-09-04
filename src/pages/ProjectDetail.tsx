import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, EntityDetail } from '../api/types';
import { Breadcrumb } from '../components/Breadcrumb';
import { NewMenu } from '../components/NewMenu';
import { NoteEditor } from '../components/NoteEditor';
import { SortableGrid } from '../components/SortableGrid';
import { EntityCard } from '../components/EntityCard';
import { TaskRow } from '../components/TaskRow';
import { Section } from '../components/Section';
import { EditableText } from '../components/EditableText';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [renaming, setRenaming] = useState<Entity | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);

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

  async function createChild(type: 'folder' | 'note' | 'task') {
    if (!id) return;
    const child = await api.createEntity({ type, parent_id: id });
    if (type === 'note') {
      navigate(`/projects/${child.id}`);
    } else {
      load();
    }
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

  async function reorderSection(type: Entity['type'], ordered: Entity[]) {
    if (!id) return;
    setDetail((prev) => {
      if (!prev) return prev;
      const others = prev.children.filter((c) => c.type !== type);
      return { ...prev, children: [...others, ...ordered] };
    });
    await api.reorder(
      id,
      ordered.map((o) => o.id)
    );
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
          placeholder="Untitled note"
          onChange={(e) => handleNoteTitleChange(e.target.value, entity.id)}
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
  const tasks = children.filter((c) => c.type === 'task');

  return (
    <div>
      <Breadcrumb trail={breadcrumb} current={entity} />

      {entity.is_top_level ? (
        <div className="project-header">
          <EditableText
            value={entity.title}
            placeholder="Untitled project"
            onSave={(v) => id && api.updateEntity(id, { title: v })}
            className="project-header__title-input"
            displayClassName="project-header__title"
          />
        </div>
      ) : (
        <EditableText
          value={entity.title}
          placeholder="Untitled folder"
          onSave={(v) => id && api.updateEntity(id, { title: v })}
          className="folder-header-input"
          displayClassName="folder-header"
        />
      )}

      <div className="toolbar-row" style={{ marginBottom: 8 }}>
        <div />
        <NewMenu onCreate={createChild} />
      </div>

      {children.length === 0 ? (
        <div className="empty-state">Nothing here yet — use "+ New" to add a folder, note, or task.</div>
      ) : (
        <>
          <Section title="Folders" count={folders.length}>
            <SortableGrid
              items={folders}
              onReorder={(ordered) => reorderSection('folder', ordered)}
              className="entity-card-grid"
              renderItem={(c) => (
                <EntityCard key={c.id} entity={c} onDelete={setDeleting} onTogglePin={togglePin} onRename={setRenaming} />
              )}
            />
          </Section>

          <Section title="Notes" count={notes.length}>
            <SortableGrid
              items={notes}
              onReorder={(ordered) => reorderSection('note', ordered)}
              className="entity-card-grid"
              renderItem={(c) => (
                <EntityCard key={c.id} entity={c} onDelete={setDeleting} onTogglePin={togglePin} onRename={setRenaming} />
              )}
            />
          </Section>

          <Section title="Tasks" count={tasks.length}>
            <SortableGrid
              items={tasks}
              onReorder={(ordered) => reorderSection('task', ordered)}
              className="task-list"
              layout="list"
              renderItem={(c) => (
                <TaskRow
                  key={c.id}
                  entity={c}
                  onToggle={toggleTask}
                  onDelete={setDeleting}
                  onTogglePin={togglePin}
                  onRename={renameEntity}
                />
              )}
            />
          </Section>
        </>
      )}

      {renaming && (
        <RenameModal
          initialValue={renaming.title}
          label={renaming.type === 'folder' ? 'Folder name' : 'Name'}
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
    </div>
  );
}
