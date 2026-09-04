import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { EditableText } from './EditableText';

export function TaskRow({
  entity,
  onToggle,
  onDelete,
  onTogglePin,
  onRename,
}: {
  entity: Entity;
  onToggle: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity, title: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entity.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isDone = entity.status === 'done';
  const isPinned = entity.pinned === 1;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-row${isDragging ? ' is-dragging' : ''}${isPinned ? ' is-pinned' : ''}`}
    >
      <span className="task-row__drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(entity)}
        className="task-row__checkbox"
      />
      <EditableText
        value={entity.title}
        placeholder="Untitled task"
        onSave={(v) => onRename(entity, v)}
        className="task-row__input"
        displayClassName={`task-row__title${isDone ? ' is-done' : ''}`}
      />
      {isPinned && <span className="task-row__pin" title="Pinned">📌</span>}
      <KebabMenu
        className="task-row__kebab"
        items={[
          { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(entity) },
          { label: 'Delete', onClick: () => onDelete(entity), danger: true },
        ]}
      />
    </div>
  );
}
