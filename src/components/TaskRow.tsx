import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Entity, FileMeta, LinkMeta } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { api, normalizeUrl } from '../api/client';
import { formatRelativeTime } from '../utils/formatRelativeTime';

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

/** 'YYYY-MM-DD' -> a short, relative-when-useful label plus a `kind` the
 * caller uses to color it (overdue tasks should stand out, today's tasks
 * a little, anything further out just reads as plain info). */
function formatDueDate(dueDate: string): { label: string; kind: 'overdue' | 'today' | 'upcoming' } {
  const due = new Date(`${dueDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);

  if (diffDays === 0) return { label: 'Today', kind: 'today' };
  if (diffDays === 1) return { label: 'Tomorrow', kind: 'upcoming' };
  if (diffDays === -1) return { label: 'Yesterday', kind: 'overdue' };

  const label = due.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: due.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
  return { label, kind: diffDays < 0 ? 'overdue' : 'upcoming' };
}

/** 'HH:MM' 24h -> a short 12-hour clock label ("2:30 PM") for the due badge. */
function formatDueTime(dueTime: string): string {
  const [h, m] = dueTime.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
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
            const href = fileMeta ? api.fileUrl(fileMeta.r2_key) : linkMeta ? normalizeUrl(linkMeta.url) : undefined;
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
  projectTag,
}: {
  entity: Entity;
  onToggle: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onOpen: (entity: Entity) => void;
  onPromote?: (entity: Entity) => void;
  onDemote?: (entity: Entity) => void;
  isSubtask?: boolean;
  /** Shown as a small pill after the title, linking to the project — used
   * on the Today page, where a task is displayed away from its project and
   * needs a visual reminder of where it actually lives. Omitted everywhere
   * a task is already shown inside its own project (redundant there). */
  projectTag?: { id: string; title: string } | null;
}) {
  const isDone = entity.status === 'done';
  const isPinned = entity.pinned === 1;
  const subtasks = entity.subtasks ?? [];
  const media = entity.media ?? [];
  // Only count what's left to do — a finished subtask shouldn't keep
  // padding out this badge once it's no longer actionable.
  const openSubtaskCount = subtasks.filter((s) => s.status !== 'done').length;
  const dueDate = entity.due_date;
  const due = dueDate ? formatDueDate(dueDate) : null;

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
        {projectTag && (
          <Link
            to={`/projects/${projectTag.id}`}
            className="task-row__project-tag"
            onClick={(e) => e.stopPropagation()}
            title={`In project: ${projectTag.title}`}
          >
            📁 {projectTag.title}
          </Link>
        )}
        {due && (
          <span
            className={`task-row__due task-row__due--${isDone ? 'done' : due.kind}`}
            title={dueDate ?? undefined}
          >
            📅 {due.label}
            {entity.due_time && ` · ${formatDueTime(entity.due_time)}`}
          </span>
        )}
        {openSubtaskCount > 0 && (
          <span className="task-row__subtask-count" title={`${openSubtaskCount} subtask${openSubtaskCount === 1 ? '' : 's'} left`}>
            {openSubtaskCount}
          </span>
        )}
        {media.length > 0 && <TaskMediaIndicator media={media} />}
        {/* Subtask rows skip this (and Promote/Demote) to stay lean — same
            "less chrome when nested" pattern already used for them. A
            recurring task swaps the usual last-modified text for a plain
            "Recurring" marker instead — "3h ago" would be misleading noise
            for something that isn't really a one-off edit history, and this
            is the one visual cue that distinguishes it from a manually
            entered task at a glance. */}
        {!isSubtask &&
          (entity.is_recurring ? (
            <span className="last-modified-badge task-row__recurring-badge" title="Generated by a recurring task definition">
              Recurring
            </span>
          ) : (
            <span className="last-modified-badge" title={new Date(entity.updated_at).toLocaleString()}>
              {formatRelativeTime(entity.updated_at)}
            </span>
          ))}
        {isPinned && <span className="task-row__pin" title="Pinned">📌</span>}
        <KebabMenu
          className="task-row__kebab"
          items={[
            { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
            ...(onPromote ? [{ label: 'Promote', onClick: () => onPromote(entity) }] : []),
            ...(onDemote ? [{ label: 'Demote', onClick: () => onDemote(entity) }] : []),
            { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
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
