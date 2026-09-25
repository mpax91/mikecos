import type { WalletCard } from '../api/types';
import { KebabMenu } from './KebabMenu';

// Same "deterministic hash → fixed palette" trick as PasswordCard's
// tileColor — gives every card visual variety at a glance (the whole point
// of scanning a grid for the right one in a hurry) without Mike having to
// hand-pick a color for all fifteen-plus cards up front. A card with its
// own `color` set always wins over the hash.
const TILE_COLORS = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

function tileColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

// Small fallback glyph per category, shown on a plain color tile when
// there's no cover art — enough to tell a gym card from a gift card from
// across the room without reading the name.
const CATEGORY_ICON: Record<string, string> = {
  Retail: '🛍️',
  Grocery: '🛒',
  Pharmacy: '💊',
  'Gym & Fitness': '🏋️',
  'Parks & Recreation': '🏞️',
  Membership: '🪪',
  'Gift Card': '🎁',
  'Local Shop': '🏪',
};

function categoryIcon(category: string): string {
  return CATEGORY_ICON[category] ?? '🎫';
}

/** One tile in the Wallet grid. Tapping it opens the card straight to its
 * full-screen barcode — no detail page in between — because the entire
 * point of this feature is getting from "open the app" to "barcode on
 * screen" in as few taps as possible while a cashier waits. Edit/delete/
 * favorite live behind the kebab instead of a click. */
export function WalletCardTile({
  card,
  onOpen,
  onEdit,
  onTogglePinned,
  onDelete,
}: {
  card: WalletCard;
  onOpen: (card: WalletCard) => void;
  onEdit: (card: WalletCard) => void;
  onTogglePinned: (card: WalletCard) => void;
  onDelete: (card: WalletCard) => void;
}) {
  const bg = card.color || tileColor(card.id);

  return (
    <div className="wallet-tile" onClick={() => onOpen(card)}>
      <div className="wallet-tile__top">
        <div className="wallet-tile__spacer" />
        <KebabMenu
          items={[
            { label: card.pinned ? 'Remove from Favorites' : 'Add to Favorites', onClick: () => onTogglePinned(card) },
            { label: 'Edit', onClick: () => onEdit(card) },
            { label: 'Delete', onClick: () => onDelete(card), danger: true, separatorBefore: true },
          ]}
        />
      </div>
      <div className="wallet-tile__art" style={{ background: card.coverArtUrl ? undefined : bg }}>
        {card.coverArtUrl ? (
          <img src={card.coverArtUrl} alt="" className="wallet-tile__art-img" />
        ) : (
          <span className="wallet-tile__art-icon">{categoryIcon(card.category)}</span>
        )}
      </div>
      <div className="wallet-tile__name">{card.name}</div>
      <div className="wallet-tile__category">{card.category}</div>
    </div>
  );
}
