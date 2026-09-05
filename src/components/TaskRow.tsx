import { useEffect, useRef, useState } from 'react';
import type { Entity, FileMeta, LinkMeta } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { api } from '../api/client';

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

/** Small paperclip + count on a task row that has file/link attachments —
 * click it to see (and open) them right from the project view, no need to
 * open the task's own detail panel first. */
function TaskMediaIndicator({ media }: { media: Entity[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div ref={ref} className="task-row__media" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-row__media-trigger"
        onClick={() => setOpen((v) => !v)}
        title={`${media.length} attachment${media.length === 1 ? '' : 's'}`}
      >
        📎 {media.length}
      </button>
      {open && (
        <div className="task-row__media-dropdown card">
          {media.map((item) => {
            const fileMeta = item.type === 'file' ? parseFileMeta(item) : null;
            const linkMeta = item.type === 'link' ? parseLinkMeta(item) : null;
            const label = item.title || fileMeta?.filename || linkMeta?.url || 'Untitled';
            const href = fileMeta ? api.fileUrl(fileMeta.r2_key) : linkMeta?.url;
            return (
              <a
                key={item.id}
                className="task-row__media-item"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.type === 'link' ? '🔖' : '📎'} {label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TaskRow({
  entity,
  onToggle,
  onDelete,
  onTogglePin,
  onOpen,
  onPromote,
  onDemote,
  isSubtask = false,
}: {
  entity: Entity;
  onToggle: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onOpen: (entity: Entity) => void;
  onPromote?: (entity: Entity) => void;
  onDemote?: (entity: Entity) => void;
  isSubtask?: boolean;
}) {
  const isDone = entity.status === 'done';
  const isPinned = entity.pinned === 1;
  const subtasks = entity.subtasks ?? [];
  const media = entity.media ?? [];
  const doneSubtasks = subtasks.filter((s) => s.status === 'done').length;

  return (
    <div>
      <div
        className={`task-row${isPinned ? ' is-pinned' : ''}${isSubtask ? ' task-row--subtask' : ''}`}
        onClick={() => onOpen(entity)}
      >
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => onToggle(entity)}
          onClick={(e) => e.stopPropagation()}
          className="task-row__checkbox"
        />
        <span className={`task-row__title${isDone ? ' is-done' : ''}${!entity.title ? ' is-placeholder' : ''}`}>
          {entity.title || 'Untitled Task'}
        </span>
        {subtasks.length > 0 && (
          <span className="task-row__subtask-count">
            {doneSubtasks}/{subtasks.length}
          </span>
        )}
        {media.length > 0 && <TaskMediaIndicator media={media} />}
        {isPinned && <span className="task-row__pin" title="Pinned">📌</span>}
        <KebabMenu
          className="task-row__kebab"
          items={[
            { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
            ...(onPromote ? [{ label: 'Promote', onClick: () => onPromote(entity) }] : []),
            ...(onDemote ? [{ label: 'Demote', onClick: () => onDemote(entity) }] : []),
            { label: 'Delete', onClick: () => onDelete(entity), danger: true },
          ]}
        />
      </div>
      {subtasks.length > 0 && (
        <div className="task-row__subtasks">
          {subtasks.map((st) => (
            <TaskRow
              key={st.id}
              entity={st}
              isSubtask
              onToggle={onToggle}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
