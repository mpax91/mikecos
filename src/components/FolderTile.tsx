import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';

/** Plain icon + label, no card chrome — folders read as folders, not tiles. */
export function FolderTile({
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`folder-tile${isPinned ? ' is-pinned' : ''}${isDragging ? ' is-dragging' : ''}`}
      onClick={() => navigate(`/projects/${entity.id}`)}
    >
      <div className="folder-tile__top">
        <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
          ⠿
        </span>
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu
          items={[
            { label: 'Rename', onClick: () => onRename(entity) },
            { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(entity) },
            { label: 'Delete', onClick: () => onDelete(entity), danger: true },
          ]}
        />
      </div>
      <div className="folder-tile__icon">📁</div>
      <div className="folder-tile__title">{entity.title || 'New folder'}</div>
    </div>
  );
}
