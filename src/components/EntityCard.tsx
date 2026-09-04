import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { Entity, FileMeta, LinkMeta } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { api } from '../api/client';

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

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  return '📎';
}

/** Tile card for notes, files, and links. Folders render via FolderTile instead. */
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
  const isFile = entity.type === 'file';
  const isLink = entity.type === 'link';
  const fileMeta = isFile ? parseFileMeta(entity) : null;
  const linkMeta = isLink ? parseLinkMeta(entity) : null;

  const menuItems = [
    { label: 'Rename', onClick: () => onRename(entity) },
    ...(isFile && fileMeta
      ? [{ label: 'Download', onClick: () => window.open(api.fileUrl(fileMeta.r2_key, true), '_blank') }]
      : []),
    { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(entity) },
    { label: 'Delete', onClick: () => onDelete(entity), danger: true },
  ];

  function handleClick() {
    if (isFile && fileMeta) {
      window.open(api.fileUrl(fileMeta.r2_key), '_blank');
    } else if (isLink && linkMeta) {
      window.open(linkMeta.url, '_blank', 'noopener,noreferrer');
    } else {
      navigate(`/projects/${entity.id}`);
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`entity-card entity-card--${entity.type}${isPinned ? ' is-pinned' : ''}${isDragging ? ' is-dragging' : ''}`}
      onClick={handleClick}
    >
      <div className="entity-card__top">
        <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
          ⠿
        </span>
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      {isFile && fileMeta ? (
        fileMeta.mime_type.startsWith('image/') ? (
          <img className="entity-card__thumb" src={api.fileUrl(fileMeta.r2_key)} alt={entity.title} />
        ) : (
          <div className="entity-card__icon">{fileIcon(fileMeta.mime_type)}</div>
        )
      ) : isLink ? (
        <div className="entity-card__icon">🔗</div>
      ) : null}

      <div className="entity-card__title">
        {entity.title || (isFile ? fileMeta?.filename : isLink ? linkMeta?.url : 'Untitled note')}
      </div>
    </div>
  );
}
