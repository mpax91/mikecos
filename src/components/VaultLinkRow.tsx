import type { Entity, LinkMeta } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { normalizeUrl } from '../api/client';
import { linkFamily } from '../utils/linkStyle';

function parseLinkMeta(entity: Entity): LinkMeta | null {
  if (!entity.content) return null;
  try {
    return JSON.parse(entity.content) as LinkMeta;
  } catch {
    return null;
  }
}

// Host + a trimmed path, matching the LinksPage/EntityCard convention —
// enough to recognize the destination without a raw-URL wall of text.
function hostAndPath(url: string): string {
  try {
    const u = new URL(normalizeUrl(url));
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

// Google's own four-color mark, simplified to a wedge so it reads at a
// glance without needing to be a pixel-exact logo reproduction.
function DriveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M8.1 2.6L2 13.4l3.1 5.4h6.1L17.3 8 14.2 2.6H8.1z" fill="#FFC107" />
      <path d="M5.1 18.8l3.1-5.4H20l-3 5.4H5.1z" fill="#1967D2" />
      <path d="M2 13.4L8.1 2.6l3.1 5.4-6 10.8L2 13.4z" fill="#188038" />
    </svg>
  );
}

function AiSparkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="#fff" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.6" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 6 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-6-3.8-9s1.3-6.3 3.8-9z" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

/** Link row for the Vault Links section — same hostname+path text
 * convention as everywhere else, but with an icon keyed off the domain
 * family (Drive, an AI project, or a plain globe) so a link that opens
 * Google Drive reads as "this opens Drive" at a glance, standing in for
 * the "Folder" that lived here in v1 (Drive is the real file repository;
 * a Vault "folder" is just a link to it now). */
export function VaultLinkRow({
  entity,
  onDelete,
  onTogglePin,
}: {
  entity: Entity;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
}) {
  const meta = parseLinkMeta(entity);
  const url = meta?.url ?? '';
  const family = url ? linkFamily(url) : 'generic';
  const isPinned = entity.pinned === 1;

  return (
    <div
      className={`vault-link-row${isPinned ? ' is-pinned' : ''}`}
      onClick={() => url && window.open(normalizeUrl(url), '_blank', 'noopener,noreferrer')}
    >
      <div className={`vault-link-row__icon vault-link-row__icon--${family}`}>
        {family === 'drive' ? <DriveIcon /> : family === 'ai' ? <AiSparkIcon /> : <GlobeIcon />}
      </div>
      <div className="vault-link-row__body">
        <div className="vault-link-row__title">
          {isPinned && <span title="Pinned">📌 </span>}
          {entity.title || url}
        </div>
        <div className="vault-link-row__url">{url ? hostAndPath(url) : ''}</div>
      </div>
      <span className="vault-link-row__open">↗</span>
      <KebabMenu
        items={[
          { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
          { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}
