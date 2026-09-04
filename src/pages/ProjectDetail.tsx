import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, EntityDetail } from '../api/types';
import { Breadcrumb } from '../components/Breadcrumb';
import { NewMenu } from '../components/NewMenu';
import { NoteEditor } from '../components/NoteEditor';
import { SortableGroup } from '../components/SortableGroup';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const next = entity.status === 'done' ? 'open' : 'done';
    // optimistic update
    setDetail((prev) =>
      prev
        ? { ...prev, children: prev.children.map((c) => (c.id === entity.id ? { ...c, status: next } : c)) }
        : prev
    );
    await api.updateEntity(entity.id, { status: next });
  }

  async function reorderGroup(parentId: string, ordered: Entity[]) {
    setDetail((prev) => {
      if (!prev) return prev;
      const otherIds = new Set(ordered.map((o) => o.id));
      const rest = prev.children.filter((c) => !otherIds.has(c.id));
      return { ...prev, children: [...rest, ...ordered] };
    });
    await api.reorder(
      parentId,
      ordered.map((o) => o.id)
    );
  }

  function handleNoteTitleChange(value: string) {
    setNoteTitle(value);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => {
      if (id) api.updateEntity(id, { title: value });
    }, 500);
  }

  function handleNoteContentSave(json: string) {
    if (id) api.updateEntity(id, { content: json });
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
          onChange={(e) => handleNoteTitleChange(e.target.value)}
        />
        <NoteEditor content={entity.content} onSave={handleNoteContentSave} />
      </div>
    );
  }

  const folders = children.filter((c) => c.type === 'folder').sort((a, b) => a.position - b.position);
  const rest = children
    .filter((c) => c.type === 'note' || c.type === 'task')
    .sort((a, b) => a.position - b.position);

  return (
    <div>
      <Breadcrumb trail={breadcrumb} current={entity} />

      {entity.is_top_level ? (
        <div className="project-header">
          <h1 className="project-header__title">{entity.title}</h1>
          {entity.content && <p className="project-header__desc">{entity.content}</p>}
        </div>
      ) : (
        <div className="folder-header">{entity.title}</div>
      )}

      <div className="toolbar-row" style={{ marginBottom: 8 }}>
        <div />
        <NewMenu onCreate={createChild} />
      </div>

      {folders.length === 0 && rest.length === 0 && (
        <div className="empty-state">Nothing here yet — use "+ New" to add a folder, note, or task.</div>
      )}

      {folders.length > 0 && (
        <>
          <div className="group-label">Folders</div>
          <SortableGroup items={folders} onReorder={(ordered) => reorderGroup(entity.id, ordered)} />
        </>
      )}

      {rest.length > 0 && (
        <>
          <div className="group-label">Notes &amp; Tasks</div>
          <SortableGroup
            items={rest}
            onReorder={(ordered) => reorderGroup(entity.id, ordered)}
            onToggleTask={toggleTask}
          />
        </>
      )}
    </div>
  );
}
