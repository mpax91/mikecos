import type { PaymentCard } from '../api/types';
import { KebabMenu } from './KebabMenu';

const TILE_COLORS = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

function tileColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

/** One tile in the Payment Cards grid — same card-shaped visual language
 * as My Cards and Rewards, since all three live under the same Wallet nav
 * item. Shows only what's already non-sensitive (network, last4, expiry);
 * the full number/CVV never appear here, only in the detail view's
 * explicit reveal. */
export function PaymentCardTile({
  card,
  onOpen,
  onEdit,
  onDelete,
}: {
  card: PaymentCard;
  onOpen: (card: PaymentCard) => void;
  onEdit: (card: PaymentCard) => void;
  onDelete: (card: PaymentCard) => void;
}) {
  const bg = card.color || tileColor(card.id);
  const expiry = card.expiryMonth && card.expiryYear ? `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}` : null;

  return (
    <div className="wallet-tile" onClick={() => onOpen(card)}>
      <div className="wallet-tile__top">
        {card.rewardWorthy && <span className="wallet-tile__badge" title="Reward-worthy — linked in Rewards">★</span>}
        <div className="wallet-tile__spacer" />
        <KebabMenu
          items={[
            { label: 'Edit', onClick: () => onEdit(card) },
            { label: 'Delete', onClick: () => onDelete(card), danger: true, separatorBefore: true },
          ]}
        />
      </div>
      <div className="wallet-tile__art" style={{ background: card.coverArtUrl ? undefined : bg }}>
        {card.coverArtUrl ? <img src={card.coverArtUrl} alt="" className="wallet-tile__art-img" /> : <span className="wallet-tile__art-icon">{card.cardType === 'debit' ? '🏦' : '💳'}</span>}
      </div>
      <div className="wallet-tile__name">{card.nickname}</div>
      <div className="wallet-tile__category">
        {card.cardType === 'debit' ? 'Debit' : 'Credit'}
        {card.last4 ? ` ····${card.last4}` : ''}
        {expiry ? ` · ${expiry}` : ''}
      </div>
    </div>
  );
}
