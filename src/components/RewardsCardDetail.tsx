import type { RewardsCard } from '../api/types';
import { isBonusActiveToday } from '../utils/rewards';

/** Full-screen detail for a single Rewards card — the analogue of Wallet's
 * WalletBarcodeView, but there's nothing to scan here, so the emphasis is
 * different: what this card is good for, right now, at a glance. Active
 * rotating bonuses are called out above the rest of the rate table so "is
 * this card doing anything special this quarter" never requires reading
 * dates. */
export function RewardsCardDetail({ card, onClose, onEdit }: { card: RewardsCard; onClose: () => void; onEdit: () => void }) {
  const sortedBonuses = [...card.bonuses].sort((a, b) => {
    const aActive = isBonusActiveToday(a);
    const bActive = isBonusActiveToday(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.rate - a.rate;
  });

  return (
    <div className="wallet-barcode-view" onClick={onClose}>
      <div className="wallet-barcode-view__card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wallet-barcode-view__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="wallet-barcode-view__header">
          {card.coverArtUrl && <img src={card.coverArtUrl} alt="" className="wallet-barcode-view__logo" />}
          <div className="wallet-barcode-view__name">{card.nickname}</div>
          <div className="wallet-barcode-view__category">
            {[card.network, card.last4 ? `····${card.last4}` : null].filter(Boolean).join(' · ') || 'Credit card'}
            {card.alwaysCarry ? ' · ★ Always carry' : ''}
          </div>
        </div>

        <div className="rewards-detail__rates">
          <div className="rewards-detail__rate-row rewards-detail__rate-row--base">
            <span>Base rate</span>
            <span>{card.baseRate}%</span>
          </div>
          {sortedBonuses.map((b) => (
            <div key={b.id} className={`rewards-detail__rate-row${isBonusActiveToday(b) ? ' is-active' : ''}`}>
              <span>
                {b.category}
                {b.kind === 'rotating' && (
                  <span className="rewards-detail__rate-dates">
                    {' '}
                    {b.startsOn && b.endsOn ? `${b.startsOn} – ${b.endsOn}` : 'rotating'}
                    {isBonusActiveToday(b) ? ' · active now' : ''}
                  </span>
                )}
              </span>
              <span>{b.rate}%</span>
            </div>
          ))}
        </div>

        {card.perks.length > 0 && (
          <div className="rewards-detail__perks">
            <div className="rewards-detail__perks-title">Perks & protections</div>
            <ul className="rewards-detail__perks-list">
              {card.perks.map((p) => (
                <li key={p.id}>
                  <strong>{p.label}</strong>
                  {p.description && <span> — {p.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {card.annualFee != null && (
          <div className="wallet-barcode-view__extra">
            <div className="wallet-barcode-view__extra-row">
              <span>Annual fee</span>
              <span>{card.annualFee === 0 ? 'None' : `$${card.annualFee}`}</span>
            </div>
          </div>
        )}

        {card.notes && (
          <div className="wallet-barcode-view__notes">
            <div className="wallet-barcode-view__notes-body" style={{ marginTop: 0 }}>
              {card.notes}
            </div>
          </div>
        )}

        <button type="button" className="wallet-barcode-view__edit" onClick={onEdit}>
          Edit card
        </button>
      </div>
    </div>
  );
}
