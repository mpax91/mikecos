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

function PdfBadgeIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V3.5A1.5 1.5 0 016.5 2z"
        fill="#fff"
        stroke="var(--color-accent-secondary)"
        strokeWidth="1.3"
      />
      <path d="M14 2v4.5A1.5 1.5 0 0015.5 8H19" stroke="var(--color-accent-secondary)" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="4.2" y="13" width="10.5" height="6" rx="1.2" fill="var(--color-accent-secondary)" />
      <text x="9.4" y="17.6" fontSize="5.2" fontWeight="700" fill="#fff" textAnchor="middle">PDF</text>
    </svg>
  );
}

function GenericFileIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V3.5A1.5 1.5 0 016.5 2z"
        fill="#fff"
        stroke="var(--color-muted)"
        strokeWidth="1.3"
      />
      <path d="M14 2v4.5A1.5 1.5 0 0015.5 8H19" stroke="var(--color-muted)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 12.5h8M8 15.5h8M8 18.5h5" stroke="var(--color-muted)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function LinkBadgeIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="var(--color-accent)" />
      <path
        d="M9.8 13.2a2.6 2.6 0 000 3.7l0 0a2.6 2.6 0 003.7 0l1.6-1.6a2.6 2.6 0 00-3.7-3.7"
        stroke="var(--color-accent-text)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M14.2 10.8a2.6 2.6 0 000-3.7l0 0a2.6 2.6 0 00-3.7 0L8.9 8.7a2.6 2.6 0 003.7 3.7"
        stroke="var(--color-accent-text)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Tile card for notes, files, and links. Folders render via FolderTile instead. */
export function EntityCard({
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
  const isFile = entity.type === 'file';
  const isLink = entity.type === 'link';
  const isNote = entity.type === 'note';
  const fileMeta = isFile ? parseFileMeta(entity) : null;
  const linkMeta = isLink ? parseLinkMeta(entity) : null;

  const menuItems = [
    { label: 'Rename', onClick: () => onRename(entity) },
    ...(isFile && fileMeta
      ? [{ label: 'Download', onClick: () => window.open(api.fileUrl(fileMeta.r2_key, true), '_blank') }]
      : []),
    { label: 'Promote', onClick: () => onPromote(entity) },
    { label: 'Demote', onClick: () => onDemote(entity) },
    { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
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
      className={`entity-card entity-card--${entity.type}${isPinned ? ' is-pinned' : ''}`}
      onClick={handleClick}
    >
      <div className="entity-card__top">
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      {isFile && fileMeta ? (
        fileMeta.mime_type.startsWith('image/') ? (
          <img className="entity-card__thumb" src={api.fileUrl(fileMeta.r2_key)} alt={entity.title} />
        ) : (
          <div className="entity-card__badge">
            {fileMeta.mime_type === 'application/pdf' ? <PdfBadgeIcon /> : <GenericFileIcon />}
          </div>
        )
      ) : isLink ? (
        <div className="entity-card__badge">
          <LinkBadgeIcon />
        </div>
      ) : null}

      <div className={`entity-card__title${isNote ? ' entity-card__title--note' : ''}`}>
        {entity.title || (isFile ? fileMeta?.filename : isLink ? linkMeta?.url : 'Untitled Note')}
      </div>
    </div>
  );
}
