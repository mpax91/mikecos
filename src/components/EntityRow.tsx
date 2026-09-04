import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import type { Entity } from '../api/types';

const TYPE_ICON: Record<Entity['type'], string> = {
  project: '📁',
  folder: '📁',
  note: '📝',
  task: '',
};

export function EntityRow({
  entity,
  onToggleTask,
}: {
  entity: Entity;
  onToggleTask?: (entity: Entity) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entity.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isTask = entity.type === 'task';
  const isDone = entity.status === 'done';

  const inner = isTask ? (
    <div className="entity-row entity-row--task">
      <span className="entity-row__drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggleTask?.(entity)}
        className="entity-row__checkbox"
      />
      <span className={`entity-row__title${isDone ? ' is-done' : ''}`}>{entity.title || 'Untitled task'}</span>
    </div>
  ) : (
    <Link to={`/projects/${entity.id}`} className="entity-row">
      <span className="entity-row__drag" {...attributes} {...listeners} onClick={(e) => e.preventDefault()}>
        ⠿
      </span>
      <span className="entity-row__icon">{TYPE_ICON[entity.type]}</span>
      <span className="entity-row__title">{entity.title || 'Untitled'}</span>
    </Link>
  );

  return (
    <div ref={setNodeRef} style={style} className="entity-row-wrap">
      {inner}
    </div>
  );
}
