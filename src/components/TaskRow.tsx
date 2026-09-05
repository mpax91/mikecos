import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';

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
