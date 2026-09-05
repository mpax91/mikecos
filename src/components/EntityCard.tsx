import { useNavigate } from 'react-router-dom';
import type { Entity, FileMeta, LinkMeta } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { api, normalizeUrl } from '../api/client';

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

// Notes store their body as a stringified Tiptap/ProseMirror doc, not
// HTML — walk its node tree collecting text so the card can show a plain
// preview snippet instead of looking blank under the title.
function extractNoteText(content: string | null, maxLength = 160): string {
  if (!content) return '';
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return '';
  }
  const parts: string[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && n.text) parts.push(n.text);
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      if (n.type && n.type !== 'text' && parts.length && parts[parts.length - 1] !== ' ') parts.push(' ');
    }
  }
  walk(doc);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

// Standard, familiar file-type icons (a page with a folded corner, a bold
// colored label banner) — modeled on the classic Windows/Adobe/Office
// icon shapes so PDF/DOC/image/link are recognizable at a glance, the
// same way they'd look in any file browser.
function FilePdfIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V3.5A1.5 1.5 0 016.5 2z"
        fill="var(--color-pdf)"
      />
      <path d="M14 2v4.5A1.5 1.5 0 0015.5 8H19L14 2z" fill="#fff" opacity="0.32" />
      <rect x="3.4" y="13.1" width="13.6" height="6.3" rx="1.1" fill="var(--color-pdf-dark)" />
      <text x="10.2" y="17.9" fontSize="5.6" fontWeight="700" fill="#fff" textAnchor="middle" fontFamily="Arial, sans-serif">
        PDF
      </text>
    </svg>
  );
}

function FileDocIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V3.5A1.5 1.5 0 016.5 2z"
        fill="var(--color-doc)"
      />
      <path d="M14 2v4.5A1.5 1.5 0 0015.5 8H19L14 2z" fill="#fff" opacity="0.32" />
      <rect x="3.4" y="13.1" width="13.6" height="6.3" rx="1.1" fill="var(--color-doc-dark)" />
      <text x="10.2" y="17.9" fontSize="5.6" fontWeight="700" fill="#fff" textAnchor="middle" fontFamily="Arial, sans-serif">
        DOC
      </text>
    </svg>
  );
}

// A generic document icon for files that are neither PDF nor Word —
// same page-with-folded-corner shape, no colored label since there's no
// single type to name.
function GenericFileIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
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

// A standard "picture" icon (frame + mountain + sun), the same glyph used
// across Windows/macOS for image files, rather than an actual thumbnail —
// keeps every media type reading as a consistent icon set.
function ImageFileIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.2" fill="#fff" stroke="var(--color-image-accent)" strokeWidth="1.4" />
      <circle cx="8.4" cy="9" r="2.1" fill="#E3B23C" />
      <path
        d="M3.3 17.4l5.5-6 4 4.2 2.6-2.8 5.3 5.5v0.6a1.3 1.3 0 01-1.3 1.3H4.6a1.3 1.3 0 01-1.3-1.3z"
        fill="var(--color-image-accent)"
      />
    </svg>
  );
}

// A simple bookmark ribbon — the standard glyph for a saved link.
function BookmarkIcon() {
  return (
    <svg width="24" height="28" viewBox="0 0 20 24" fill="none">
      <path d="M4 1.5h12a1 1 0 011 1V22l-7-4.3-7 4.3V2.5a1 1 0 011-1z" fill="var(--color-link-accent)" />
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
  compact = false,
}: {
  entity: Entity;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
  onRename: (entity: Entity) => void;
  onPromote: (entity: Entity) => void;
  onDemote: (entity: Entity) => void;
  /** Pinned mixes notes with files/links/folders/tasks in one row — a note's
   * usual big square would force every shorter card in that row to stretch
   * to match it. `compact` renders the note at the same rectangle size as a
   * media card instead, keeping only its post-it color/border identity. */
  compact?: boolean;
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
  const notePreview = isNote ? extractNoteText(entity.content) : '';

  const menuItems = [
    ...(isFile && fileMeta
      ? [{ label: 'Download', onClick: () => window.open(api.fileUrl(fileMeta.r2_key, true), '_blank'), positive: true }]
      : []),
    { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity), separatorBefore: isFile && !!fileMeta },
    { label: 'Rename', onClick: () => onRename(entity) },
    { label: 'Promote', onClick: () => onPromote(entity) },
    { label: 'Demote', onClick: () => onDemote(entity) },
    { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
  ];

  function handleClick() {
    if (isFile && fileMeta) {
      if (isDoc) {
        // Browsers have no built-in viewer for Word docs, so a direct link
        // just downloads the file instead of opening it — route through
        // Office's web viewer instead so "open" previews like the PDF
        // case does, leaving the dedicated Download button as the only
        // way to actually save a copy.
        const officeViewer = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(
          api.fileUrl(fileMeta.r2_key)
        )}`;
        window.open(officeViewer, '_blank');
      } else {
        window.open(api.fileUrl(fileMeta.r2_key), '_blank');
      }
    } else if (isLink && linkMeta) {
      window.open(normalizeUrl(linkMeta.url), '_blank', 'noopener,noreferrer');
    } else {
      navigate(`/projects/${entity.id}`);
    }
  }

  return (
    <div
      className={`entity-card entity-card--${entity.type}${mediaKind ? ` entity-card--media-${mediaKind}` : ''}${
        isPinned ? ' is-pinned' : ''
      }${compact ? ' entity-card--compact' : ''}`}
      onClick={handleClick}
    >
      <div className="entity-card__top">
        {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
        <div className="entity-card__spacer" />
        <KebabMenu items={menuItems} />
      </div>

      {isImage ? (
        <div className="entity-card__badge">
          <ImageFileIcon />
        </div>
      ) : isPdf ? (
        <div className="entity-card__badge">
          <FilePdfIcon />
        </div>
      ) : isDoc ? (
        <div className="entity-card__badge">
          <FileDocIcon />
        </div>
      ) : isLink ? (
        <div className="entity-card__badge">
          <BookmarkIcon />
        </div>
      ) : isFile ? (
        <div className="entity-card__badge">
          <GenericFileIcon />
        </div>
      ) : null}

      <div className={`entity-card__title${isNote ? ' entity-card__title--note' : ''}`}>
        {entity.title || (isFile ? fileMeta?.filename : isLink ? linkMeta?.url : 'Untitled Note')}
      </div>

      {isNote && notePreview && !compact && (
        <div className="entity-card__snippet entity-card__snippet--note">{notePreview}</div>
      )}
    </div>
  );
}
