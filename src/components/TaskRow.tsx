import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { EditableText } from './EditableText';

export function TaskRow({
  entity,
  onToggle,
  onDelete,
  onTogglePin,
  onRename,
  onPromote,
  onDemote,
}: {
  entity: Entity;
  onToggle: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity, title: string) => void;
  onPromote: (entity: Entity) => void;
  onDemote: (entity: Entity) => void;
}) {
  const isDone = entity.status === 'done';
  const isPinned = entity.pinned === 1;

  return (
    <div className={`task-row${isPinned ? ' is-pinned' : ''}`}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(entity)}
        className="task-row__checkbox"
      />
      <EditableText
        value={entity.title}
        placeholder="Untitled Task"
        onSave={(v) => onRename(entity, v)}
        className="task-row__input"
        displayClassName={`task-row__title${isDone ? ' is-done' : ''}`}
      />
      {isPinned && <span className="task-row__pin" title="Pinned">📌</span>}
      <KebabMenu
        className="task-row__kebab"
        items={[
          { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
          { label: 'Promote', onClick: () => onPromote(entity) },
          { label: 'Demote', onClick: () => onDemote(entity) },
          { label: 'Delete', onClick: () => onDelete(entity), danger: true },
        ]}
      />
    </div>
  );
}
