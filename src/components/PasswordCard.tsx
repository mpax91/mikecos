import type { Entity } from '../api/types';
import { KebabMenu } from './KebabMenu';

// A small fixed palette, picked deterministically from the entry's id, so a
// grid of many logins reads with the same kind of at-a-glance color variety
// a real password manager's favicon/initial tiles have — without needing a
// per-domain brand-color lookup.
const TILE_COLORS = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E'];

function tileColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M7.5 10.5V8a4.5 4.5 0 019 0v2.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <rect x="5" y="10.5" width="14" height="10" rx="2.3" fill="#fff" />
    </svg>
  );
}

/** A LastPass/Bitwarden-style credential card in the Vault entry's
 * "Passwords" section — lock-icon tile + name + username, click to open
 * the detail view. Deliberately its own component rather than a mode of
 * EntityCard: the click behavior (always opens the detail modal, never
 * navigates or downloads) and menu (just Delete — no rename/promote/pin)
 * are both simpler and different enough to not share much with it. */
export function PasswordCard({ entity, onOpen, onDelete }: { entity: Entity; onOpen: (entity: Entity) => void; onDelete: (entity: Entity) => void }) {
  return (
    <div className="entity-card entity-card--compact password-card" onClick={() => onOpen(entity)}>
      <div className="entity-card__top">
        <div className="entity-card__spacer" />
        <KebabMenu items={[{ label: 'Delete', onClick: () => onDelete(entity), danger: true }]} />
      </div>
      <div className="password-card__badge" style={{ background: tileColor(entity.id) }}>
        <LockIcon />
      </div>
      <div className="entity-card__title password-card__title">{entity.title || 'Untitled Password'}</div>
      {entity.username && <div className="password-card__username">{entity.username}</div>}
    </div>
  );
}
