import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { EditableText } from './EditableText';
import { extractSnippet } from '../lib/snippet';

const TYPE_ICON: Record<Entity['type'], string> = {
  project: '📁',
  folder: '📁',
  note: '📝',
  task: '',
};

export function EntityCard({
  entity,
  onToggleTask,
  onDelete,
  onTogglePin,
  onRename,
  onRenameTask,
}: {
  entity: Entity;
  onToggleTask?: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity) => void;
  onRenameTask?: (entity: Entity, title: string) => void;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entity.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isPinned = entity.pinned === 1;
  const isTask = entity.type === 'task';
  const isDone = entity.status === 'done';
  const isNote = entity.type === 'note';
  const isFolder = entity.type === 'folder';

  const menuItems = [
    ...(isTask ? [] : [{ label: 'Rename', onClick: () => onRename(entity) }]),
    { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(entity) },
    { label: 'Delete', onClick: () => onDelete(entity), danger: true },
  ];

  function openOrToggle() {
    if (isTask) return;
    navigate(`/projects/${entity.id}`);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`entity-card entity-card--${entity.type}${isPinned ? ' is-pinned' : ''}${isDragging ? ' is-dragging' : ''}`}
      onClick={openOrToggle}
    >
      <div className="entity-card__top">
        <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
          ⠿
        </span>
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      {isTask ? (
        <div className="entity-card__task" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isDone}
            onChange={() => onToggleTask?.(entity)}
            className="entity-card__checkbox"
          />
          <EditableText
            value={entity.title}
            placeholder="Untitled task"
            onSave={(v) => onRenameTask?.(entity, v)}
            className="entity-card__task-input"
            displayClassName={`entity-card__task-title${isDone ? ' is-done' : ''}`}
          />
        </div>
      ) : (
        <>
          <div className="entity-card__icon">{TYPE_ICON[entity.type]}</div>
          <div className="entity-card__title">{entity.title || (isNote ? 'Untitled note' : 'New folder')}</div>
          {isNote && entity.content && (
            <div className="entity-card__snippet">{extractSnippet(entity.content)}</div>
          )}
          {isFolder && <div className="entity-card__meta">Folder</div>}
        </>
      )}
    </div>
  );
}
