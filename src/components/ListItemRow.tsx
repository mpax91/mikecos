import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { TaskMediaIndicator, formatDueDate, formatDueTime } from './TaskRow';
import { useIsMobile } from '../hooks/useIsMobile';

/** A List item's row — deliberately its own component rather than a reuse of
 * TaskRow. Visually it needs to read as a plain checklist (small checkbox,
 * no drag handle, no "3h ago" badge, a light dotted rule instead of a solid
 * border), not as a project task row — see the sidebar/lists layout
 * discussion this came out of. Checking an item off doesn't flip a "done"
 * status the way a project task does; it removes the item (with a brief
 * fade + an Undo toast, handled by the caller) since a list you check off
 * items from — a grocery run, a download queue — has no use for completed
 * items sticking around. Due date / attachments / subtask-count badges are
 * kept as-is (shared with TaskRow) since those still matter for the
 * "deeper context on click" part of what a List item can hold. */
export function ListItemRow({
  entity,
  onCheckOff,
  onDelete,
  onTogglePin,
  onOpen,
  onPromote,
  onDemote,
  isRemoving = false,
}: {
  entity: Entity;
  onCheckOff: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onOpen: (entity: Entity) => void;
  onPromote?: (entity: Entity) => void;
  onDemote?: (entity: Entity) => void;
  isRemoving?: boolean;
}) {
  const isMobile = useIsMobile();
  const isPinned = entity.pinned === 1;
  const subtasks = entity.subtasks ?? [];
  const media = entity.media ?? [];
  const openSubtaskCount = subtasks.filter((s) => s.status !== 'done').length;
  const dueDate = entity.due_date;
  const due = dueDate ? formatDueDate(dueDate) : null;

  return (
    <div
      className={`list-row${isPinned ? ' is-pinned' : ''}${isRemoving ? ' is-removing' : ''}`}
      onClick={() => onOpen(entity)}
    >
      <input
        type="checkbox"
        checked={isRemoving}
        onChange={() => onCheckOff(entity)}
        onClick={(e) => e.stopPropagation()}
        className="list-row__checkbox"
      />
      <span className={`list-row__title${!entity.title ? ' is-placeholder' : ''}`}>
        {entity.title || 'Untitled Item'}
      </span>
      {due && (
        <span className={`task-row__due task-row__due--${due.kind}`} title={dueDate ?? undefined}>
          {!isMobile && '📅 '}
          {due.label}
          {entity.due_time && ` · ${formatDueTime(entity.due_time)}`}
        </span>
      )}
      {openSubtaskCount > 0 && (
        <span className="task-row__subtask-count" title={`${openSubtaskCount} subtask${openSubtaskCount === 1 ? '' : 's'} left`}>
          {openSubtaskCount}
        </span>
      )}
      {media.length > 0 && <TaskMediaIndicator media={media} />}
      {isPinned && <span className="task-row__pin" title="Pinned">📌</span>}
      <KebabMenu
        className="task-row__kebab"
        items={[
          { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
          ...(onPromote ? [{ label: 'Move up', onClick: () => onPromote(entity) }] : []),
          ...(onDemote ? [{ label: 'Move down', onClick: () => onDemote(entity) }] : []),
          { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}
