import { useEffect, useRef, useState } from 'react';
import { api, normalizeUrl } from '../api/client';
import type { Entity, FileMeta, LinkMeta, TaskMeta } from '../api/types';
import { RenameModal } from './RenameModal';
import { LinkModal } from './LinkModal';

const DESCRIPTION_DEBOUNCE_MS = 800;
const TITLE_DEBOUNCE_MS = 500;

function parseTaskMeta(content: string | null): TaskMeta {
  if (!content) return {};
  try {
    return JSON.parse(content) as TaskMeta;
  } catch {
    return {};
  }
}

function parseFileMeta(entity: Entity): FileMeta | null {
  if (!entity.content) return null;
  try {
    return JSON.parse(entity.content) as FileMeta;
  } catch {
    return null;
  }
}

function parseLinkMeta(entity: Entity): LinkMeta | null {
  if (!entity.content) return null;
  try {
    return JSON.parse(entity.content) as LinkMeta;
  } catch {
    return null;
  }
}

/** Todoist-style task detail panel: opens on top of the project view when a
 * task or subtask is clicked. Handles its own title/description/due-date/
 * subtask/attachment state against the API directly, and tells the parent
 * (via onMutated) to refresh the underlying project list whenever something
 * here would change what that list shows. */
export function TaskDetailModal({
  taskId,
  onClose,
  onBack,
  onOpenSubtask,
  onMutated,
  onRequestDelete,
}: {
  taskId: string;
  onClose: () => void;
  onBack?: () => void;
  onOpenSubtask: (id: string) => void;
  onMutated: () => void;
  onRequestDelete: (entity: Entity) => void;
}) {
  const [entity, setEntity] = useState<Entity | null>(null);
  const [parentTitle, setParentTitle] = useState<string | null>(null);
  const [children, setChildren] = useState<Entity[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [editingAttachment, setEditingAttachment] = useState<Entity | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    api.getEntity(taskId).then((d) => {
      setEntity(d.entity);
      setChildren(d.children);
      setTitle(d.entity.title);
      const meta = parseTaskMeta(d.entity.content);
      setDescription(meta.description ?? '');
      setDueDate(meta.due_date ?? '');
      const parent = d.breadcrumb[d.breadcrumb.length - 1];
      setParentTitle(parent && parent.type === 'task' ? parent.title || 'Untitled Task' : null);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  function saveMeta(patch: Partial<TaskMeta>) {
    const merged = { ...parseTaskMeta(entity?.content ?? null), ...patch };
    const json = JSON.stringify(merged);
    // Reflect the merge locally right away so a second meta field changed
    // moments later (description right after due date, say) composes on
    // top of this update instead of a stale `entity.content` closure —
    // otherwise whichever save lands second would silently wipe the first.
    setEntity((prev) => (prev ? { ...prev, content: json } : prev));
    api.updateEntity(taskId, { content: json });
    onMutated();
  }

  function handleTitleChange(value: string) {
    setTitle(value);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      api.updateEntity(taskId, { title: value });
      onMutated();
    }, TITLE_DEBOUNCE_MS);
  }

  function handleDescriptionChange(value: string) {
    setDescription(value);
    if (descTimer.current) clearTimeout(descTimer.current);
    descTimer.current = setTimeout(() => saveMeta({ description: value }), DESCRIPTION_DEBOUNCE_MS);
  }

  function handleDueDateChange(value: string) {
    setDueDate(value);
    saveMeta({ due_date: value || null });
  }

  async function toggleDone() {
    if (!entity) return;
    const next = entity.status === 'done' ? 'open' : 'done';
    setEntity({ ...entity, status: next });
    await api.updateEntity(taskId, { status: next });
    onMutated();
  }

  async function createSubtask() {
    const trimmed = newSubtask.trim();
    if (!trimmed) return;
    setNewSubtask('');
    await api.createEntity({ type: 'task', parent_id: taskId, title: trimmed });
    load();
    onMutated();
  }

  async function toggleSubtask(sub: Entity) {
    const next = sub.status === 'done' ? 'open' : 'done';
    setChildren((prev) => prev.map((c) => (c.id === sub.id ? { ...c, status: next } : c)));
    await api.updateEntity(sub.id, { status: next });
    onMutated();
  }

  async function deleteSubtask(sub: Entity) {
    setChildren((prev) => prev.filter((c) => c.id !== sub.id));
    await api.deleteEntity(sub.id);
    onMutated();
  }

  async function uploadAttachment(file: File) {
    await api.uploadFile(file, taskId);
    load();
    onMutated();
  }

  async function addAttachmentLink() {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    setLinkUrl('');
    setAddingLink(false);
    await api.createLink(taskId, trimmed);
    load();
    onMutated();
  }

  async function removeAttachment(item: Entity) {
    setChildren((prev) => prev.filter((c) => c.id !== item.id));
    await api.deleteEntity(item.id);
    onMutated();
  }

  async function saveAttachmentTitle(newTitle: string) {
    if (!editingAttachment) return;
    const id = editingAttachment.id;
    setEditingAttachment(null);
    setChildren((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    await api.updateEntity(id, { title: newTitle });
    onMutated();
  }

  async function saveAttachmentLink(url: string, linkTitle: string) {
    if (!editingAttachment) return;
    const id = editingAttachment.id;
    setEditingAttachment(null);
    const content = JSON.stringify({ url });
    const finalTitle = linkTitle || url;
    setChildren((prev) => prev.map((c) => (c.id === id ? { ...c, content, title: finalTitle } : c)));
    await api.updateEntity(id, { content, title: finalTitle });
    onMutated();
  }

  if (!entity) {
    return (
      <div className="task-panel-backdrop" onClick={onClose}>
        <div className="task-panel" onClick={(e) => e.stopPropagation()}>
          <div className="empty-state">Loading…</div>
        </div>
      </div>
    );
  }

  const subtasks = children.filter((c) => c.type === 'task');
  const media = children.filter((c) => c.type === 'file' || c.type === 'link');
  const isDone = entity.status === 'done';

  return (
    <div className="task-panel-backdrop" onClick={onClose}>
      <div className="task-panel" onClick={(e) => e.stopPropagation()}>
        <div className="task-panel__header">
          {onBack ? (
            <button type="button" className="task-panel__back" onClick={onBack}>
              ‹ {parentTitle || 'Back'}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="task-panel__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="task-panel__title-row">
          <input
            type="checkbox"
            checked={isDone}
            onChange={toggleDone}
            className="task-panel__checkbox"
          />
          <input
            className={`task-panel__title${isDone ? ' is-done' : ''}`}
            value={title}
            placeholder="Untitled Task"
            onChange={(e) => handleTitleChange(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </div>

        <div className="task-panel__field">
          <label className="task-panel__label">Due date</label>
          <div className="task-panel__field-row">
            <input type="date" value={dueDate} onChange={(e) => handleDueDateChange(e.target.value)} />
            {dueDate && (
              <button type="button" className="task-panel__clear" onClick={() => handleDueDateChange('')}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="task-panel__field">
          <label className="task-panel__label">Description</label>
          <textarea
            className="task-panel__description"
            value={description}
            placeholder="Add a description…"
            onChange={(e) => handleDescriptionChange(e.target.value)}
          />
        </div>

        <div className="task-panel__section">
          <div className="task-panel__section-title">
            Subtasks{subtasks.filter((s) => s.status !== 'done').length > 0 ? ` (${subtasks.filter((s) => s.status !== 'done').length})` : ''}
          </div>
          {subtasks.map((sub) => (
            <div key={sub.id} className={`task-panel__subtask-row${sub.status === 'done' ? ' is-done' : ''}`}>
              <input
                type="checkbox"
                checked={sub.status === 'done'}
                onChange={() => toggleSubtask(sub)}
                className="task-row__checkbox"
              />
              <span className="task-panel__subtask-title" onClick={() => onOpenSubtask(sub.id)}>
                {sub.title || 'Untitled Task'}
              </span>
              {(sub.subtasks ?? []).filter((s) => s.status !== 'done').length > 0 && (
                <span className="task-row__subtask-count">
                  {(sub.subtasks ?? []).filter((s) => s.status !== 'done').length}
                </span>
              )}
              <button
                type="button"
                className="task-panel__remove"
                onClick={() => deleteSubtask(sub)}
                aria-label="Delete subtask"
              >
                ×
              </button>
            </div>
          ))}
          <div className="task-panel__subtask-row task-panel__subtask-row--new">
            <input type="checkbox" disabled className="task-row__checkbox" />
            <input
              className="task-panel__subtask-title task-panel__subtask-input"
              placeholder="Add subtask"
              value={newSubtask}
              onChange={(e) => setNewSubtask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  createSubtask();
                }
              }}
              onBlur={createSubtask}
            />
          </div>
        </div>

        <div className="task-panel__section">
          <div className="task-panel__section-title">Attachments</div>
          {media.map((item) => {
            const fileMeta = item.type === 'file' ? parseFileMeta(item) : null;
            const linkMeta = item.type === 'link' ? parseLinkMeta(item) : null;
            const label = item.title || fileMeta?.filename || linkMeta?.url || 'Untitled';
            const href = fileMeta ? api.fileUrl(fileMeta.r2_key) : linkMeta ? normalizeUrl(linkMeta.url) : undefined;
            return (
              <div key={item.id} className="task-panel__media-row">
                <a
                  className="task-panel__media-link"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {item.type === 'link' ? '🔖' : '📎'} {label}
                </a>
                <button
                  type="button"
                  className="task-panel__edit"
                  onClick={() => setEditingAttachment(item)}
                  aria-label={item.type === 'link' ? 'Edit link' : 'Rename attachment'}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="task-panel__remove"
                  onClick={() => removeAttachment(item)}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="task-panel__add-row">
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadAttachment(file);
                e.target.value = '';
              }}
            />
            <button type="button" className="task-panel__add-btn" onClick={() => fileInputRef.current?.click()}>
              + File
            </button>
            {addingLink ? (
              <input
                className="task-panel__link-input"
                autoFocus
                placeholder="https://…"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addAttachmentLink()}
                onBlur={addAttachmentLink}
              />
            ) : (
              <button type="button" className="task-panel__add-btn" onClick={() => setAddingLink(true)}>
                + Link
              </button>
            )}
          </div>
        </div>

        <button type="button" className="task-panel__delete-btn" onClick={() => onRequestDelete(entity)}>
          Delete Task
        </button>
      </div>

      {editingAttachment && editingAttachment.type === 'file' && (
        <RenameModal
          initialValue={editingAttachment.title || parseFileMeta(editingAttachment)?.filename || ''}
          label="File Name"
          onSave={saveAttachmentTitle}
          onClose={() => setEditingAttachment(null)}
        />
      )}

      {editingAttachment && editingAttachment.type === 'link' && (
        <LinkModal
          heading="Edit Link"
          submitLabel="Save"
          initialUrl={parseLinkMeta(editingAttachment)?.url ?? ''}
          initialTitle={editingAttachment.title || ''}
          onSave={saveAttachmentLink}
          onClose={() => setEditingAttachment(null)}
        />
      )}
    </div>
  );
}
