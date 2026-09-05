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

// A plain page-outline shape shared by every non-image file badge — only
// the accent color and the corner tag text change per type, so PDF/Word/
// generic files all read as "a document" at a glance while still being
// tellable apart.
function PageShape({ color, tag }: { color: string; tag?: string }) {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V3.5A1.5 1.5 0 016.5 2z"
        fill="#fff"
        stroke={color}
        strokeWidth="1.3"
      />
      <path d="M14 2v4.5A1.5 1.5 0 0015.5 8H19" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      {tag && (
        <>
          <rect x="3.6" y="13" width="11.5" height="6" rx="1.2" fill={color} />
          <text x="9.35" y="17.6" fontSize="4.7" fontWeight="700" fill="#fff" textAnchor="middle">
            {tag}
          </text>
        </>
      )}
      {!tag && <path d="M8 12.5h8M8 15.5h8M8 18.5h5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />}
    </svg>
  );
}

function LinkBadgeIcon() {
  // A simple globe/chain glyph — the earlier interlocking-rings version
  // read as a dollar sign at this size, which was confusing next to file
  // icons that are actually about money-adjacent topics.
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9.5" stroke="#2E6DA4" strokeWidth="1.4" />
      <path d="M2.7 12h18.6M12 2.5c2.5 2.6 3.8 6 3.8 9.5s-1.3 6.9-3.8 9.5c-2.5-2.6-3.8-6-3.8-9.5S9.5 5.1 12 2.5z" stroke="#2E6DA4" strokeWidth="1.2" />
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

  const isImage = fileMeta?.mime_type.startsWith('image/') ?? false;
  const isPdf = fileMeta?.mime_type === 'application/pdf';
  const isDoc =
    fileMeta?.mime_type === 'application/msword' ||
    fileMeta?.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const mediaKind = isImage ? 'image' : isPdf ? 'pdf' : isDoc ? 'doc' : isLink ? 'link' : isFile ? 'generic' : null;

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
      className={`entity-card entity-card--${entity.type}${mediaKind ? ` entity-card--media-${mediaKind}` : ''}${
        isPinned ? ' is-pinned' : ''
      }`}
      onClick={handleClick}
    >
      <div className="entity-card__top">
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      {isImage && fileMeta ? (
        <img className="entity-card__thumb" src={api.fileUrl(fileMeta.r2_key)} alt={entity.title} />
      ) : isPdf ? (
        <div className="entity-card__badge">
          <PageShape color="var(--color-accent-secondary)" tag="PDF" />
        </div>
      ) : isDoc ? (
        <div className="entity-card__badge">
          <PageShape color="#2E6DA4" tag="DOC" />
        </div>
      ) : isLink ? (
        <div className="entity-card__badge">
          <LinkBadgeIcon />
        </div>
      ) : isFile ? (
        <div className="entity-card__badge">
          <PageShape color="var(--color-muted)" />
        </div>
      ) : null}

      <div className={`entity-card__title${isNote ? ' entity-card__title--note' : ''}`}>
        {entity.title || (isFile ? fileMeta?.filename : isLink ? linkMeta?.url : 'Untitled Note')}
      </div>
    </div>
  );
}
