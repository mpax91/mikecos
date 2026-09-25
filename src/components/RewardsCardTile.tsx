import type { RewardsCard } from '../api/types';
import { KebabMenu } from './KebabMenu';

const TILE_COLORS = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

function tileColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

/** One tile in the Rewards grid — same card-shaped visual language as
 * Wallet's tiles, since this lives in the same feature area and should
 * feel like a sibling, not a bolted-on second app. */
export function RewardsCardTile({
  card,
  onOpen,
  onEdit,
  onToggleAlwaysCarry,
  onDelete,
}: {
  card: RewardsCard;
  onOpen: (card: RewardsCard) => void;
  onEdit: (card: RewardsCard) => void;
  onToggleAlwaysCarry: (card: RewardsCard) => void;
  onDelete: (card: RewardsCard) => void;
}) {
  const bg = card.color || tileColor(card.id);

  return (
    <div className="wallet-tile" onClick={() => onOpen(card)}>
      <div className="wallet-tile__top">
        {card.alwaysCarry && <span className="wallet-tile__badge" title="Always carry">★</span>}
        <div className="wallet-tile__spacer" />
        <KebabMenu
          items={[
            { label: card.alwaysCarry ? 'Remove from Always Carry' : 'Always Carry', onClick: () => onToggleAlwaysCarry(card) },
            { label: 'Edit', onClick: () => onEdit(card) },
            { label: 'Delete', onClick: () => onDelete(card), danger: true, separatorBefore: true },
          ]}
        />
      </div>
      <div className="wallet-tile__art" style={{ background: card.coverArtUrl ? undefined : bg }}>
        {card.coverArtUrl ? <img src={card.coverArtUrl} alt="" className="wallet-tile__art-img" /> : <span className="wallet-tile__art-icon">💳</span>}
      </div>
      <div className="wallet-tile__name">{card.nickname}</div>
      <div className="wallet-tile__category">
        {card.baseRate}% base{card.network ? ` · ${card.network}` : ''}
        {card.last4 ? ` ····${card.last4}` : ''}
      </div>
    </div>
  );
}
