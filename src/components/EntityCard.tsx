import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { extractSnippet } from '../lib/snippet';

const TYPE_ICON: Record<Entity['type'], string> = {
  project: '📁',
  folder: '📁',
  note: '📝',
  task: '',
};

/** Tile card for folders and notes. Tasks render via TaskRow instead. */
export function EntityCard({
  entity,
  onDelete,
  onTogglePin,
  onRename,
}: {
  entity: Entity;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity) => void;
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
  const isNote = entity.type === 'note';
  const isFolder = entity.type === 'folder';

  const menuItems = [
    { label: 'Rename', onClick: () => onRename(entity) },
    { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(entity) },
    { label: 'Delete', onClick: () => onDelete(entity), danger: true },
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`entity-card entity-card--${entity.type}${isPinned ? ' is-pinned' : ''}${isDragging ? ' is-dragging' : ''}`}
      onClick={() => navigate(`/projects/${entity.id}`)}
    >
      <div className="entity-card__top">
        <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
          ⠿
        </span>
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      <div className="entity-card__icon">{TYPE_ICON[entity.type]}</div>
      <div className="entity-card__title">{entity.title || (isNote ? 'Untitled note' : 'New folder')}</div>
      {isNote && entity.content && <div className="entity-card__snippet">{extractSnippet(entity.content)}</div>}
      {isFolder && <div className="entity-card__meta">Folder</div>}
    </div>
  );
}
