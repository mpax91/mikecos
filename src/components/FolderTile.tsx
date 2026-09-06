import { useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';

/** Plain icon + label, no card chrome — folders read as folders, not tiles. */
export function FolderTile({
  entity,
  onDelete,
  onTogglePin,
  onRename,
  onPromote,
  onDemote,
}: {
  entity: Entity;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity) => void;
  onPromote: (entity: Entity) => void;
  onDemote: (entity: Entity) => void;
}) {
  const navigate = useNavigate();
  const isPinned = entity.pinned === 1;

  return (
    <div
      className={`folder-tile${isPinned ? ' is-pinned' : ''}`}
      onClick={() => navigate(`/projects/${entity.id}`)}
    >
      <div className="folder-tile__top">
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu
          items={[
            { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
            { label: 'Rename', onClick: () => onRename(entity) },
            { label: 'Promote', onClick: () => onPromote(entity) },
            { label: 'Demote', onClick: () => onDemote(entity) },
            { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
          ]}
        />
      </div>
      <div className="folder-tile__icon">📁</div>
      <div className="folder-tile__title">{entity.title || 'New Folder'}</div>
      <span className="last-modified-badge folder-tile__meta" title={new Date(entity.updated_at).toLocaleString()}>
        {formatRelativeTime(entity.updated_at)}
      </span>
    </div>
  );
}
