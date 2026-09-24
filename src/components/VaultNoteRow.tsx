import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { extractNoteText } from '../utils/noteText';

// A simple lined-page glyph — deliberately plain (no post-it color/border
// identity the way the old card grid had) since a Vault note is meant to
// read as "a real note", same family as the standalone Notes page, not a
// sticky-note overlay.
function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M3.5 12h17M3.5 6h17M3.5 18h11" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Row for the Vault Notes section — same list convention as
 * VaultLinkRow/VaultFactsTable (a compact row, not a card), so a handful of
 * notes read as an index you can scan rather than a grid of tiles that all
 * look the same size regardless of content. Clicking opens the note in
 * VaultNoteModal, same as before. */
export function VaultNoteRow({
  entity,
  onOpen,
  onDelete,
  onTogglePin,
}: {
  entity: Entity;
  onOpen: (entity: Entity) => void;
  onDelete: (entity: Entity) => void;
  onTogglePin: (entity: Entity) => void;
}) {
  const isPinned = entity.pinned === 1;
  const preview = extractNoteText(entity.content, 140);

  return (
    <div className={`vault-note-row${isPinned ? ' is-pinned' : ''}`} onClick={() => onOpen(entity)}>
      <div className="vault-note-row__icon">
        <NoteIcon />
      </div>
      <div className="vault-note-row__body">
        <div className="vault-note-row__title">
          {isPinned && <span title="Pinned">📌 </span>}
          {entity.title || 'Untitled Note'}
        </div>
        {preview && <div className="vault-note-row__preview">{preview}</div>}
      </div>
      <span className="last-modified-badge vault-note-row__meta" title={new Date(entity.updated_at).toLocaleString()}>
        {formatRelativeTime(entity.updated_at)}
      </span>
      <KebabMenu
        items={[
          { label: isPinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(entity) },
          { label: 'Delete', onClick: () => onDelete(entity), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}
