import { useState } from 'react';
import { api } from '../api/client';
import type { RewardsCard } from '../api/types';
import { isBonusActiveToday, describeRotatingWindow } from '../utils/rewards';

// Quarter-aligned bonuses get the short "(Q3)" form here rather than
// describeRotatingWindow's own "Q3 2026" — this view is glanceable, and
// the year is implied by "active now" sitting right next to it. A
// non-quarter-aligned window (the Amazon Prime Visa's own promo dates)
// still falls back to its real date range, since it won't match a quarter.
function shortRotatingLabel(startsOn: string | null, endsOn: string | null): string {
  const desc = describeRotatingWindow(startsOn, endsOn);
  if (!desc) return 'rotating';
  return desc.startsWith('Q') ? `(${desc.split(' ')[0]})` : desc;
}

/** Full-screen detail for a single Rewards card — the analogue of Wallet's
 * WalletBarcodeView, but there's nothing to scan here, so the emphasis is
 * different: what this card is good for, right now, at a glance. Active
 * rotating bonuses are called out above the rest of the rate table so "is
 * this card doing anything special this quarter" never requires reading
 * dates. */
export function RewardsCardDetail({
  card,
  onClose,
  onEdit,
  onChanged,
}: {
  card: RewardsCard;
  onClose: () => void;
  onEdit: () => void;
  /** Called after an offer is added/removed here, so the parent's card
   * list (and Find's "card offers you've noted" section) stays in sync
   * without needing a full reload. Optional since not every caller cares. */
  onChanged?: (card: RewardsCard) => void;
}) {
  const [offers, setOffers] = useState(card.offers);
  const [addingOffer, setAddingOffer] = useState(false);
  const [offerMerchant, setOfferMerchant] = useState('');
  const [offerDescription, setOfferDescription] = useState('');
  const [offerExpires, setOfferExpires] = useState('');
  const [offerSaving, setOfferSaving] = useState(false);

  const sortedBonuses = [...card.bonuses].sort((a, b) => {
    const aActive = isBonusActiveToday(a);
    const bActive = isBonusActiveToday(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.rate - a.rate;
  });

  async function addOffer() {
    const merchant = offerMerchant.trim();
    const description = offerDescription.trim();
    if (!merchant || !description) return;
    setOfferSaving(true);
    try {
      const offer = await api.createRewardsOffer(card.id, { merchant, description, expiresOn: offerExpires || null });
      const next = [...offers, offer];
      setOffers(next);
      onChanged?.({ ...card, offers: next });
      setOfferMerchant('');
      setOfferDescription('');
      setOfferExpires('');
      setAddingOffer(false);
    } finally {
      setOfferSaving(false);
    }
  }

  async function removeOffer(id: string) {
    const next = offers.filter((o) => o.id !== id);
    setOffers(next);
    onChanged?.({ ...card, offers: next });
    await api.deleteRewardsOffer(id);
  }

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
                    {shortRotatingLabel(b.startsOn, b.endsOn)}
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

        <div className="rewards-detail__perks">
          <div className="rewards-detail__perks-title">Card offers you've noted</div>
          {offers.length > 0 && (
            <ul className="rewards-detail__perks-list">
              {offers.map((o) => (
                <li key={o.id} className="rewards-detail__offer-row">
                  <span>
                    <strong>{o.merchant}</strong> — {o.description}
                    {o.expiresOn && ` (expires ${o.expiresOn})`}
                  </span>
                  <button type="button" className="wallet-editor__row-item-remove" onClick={() => removeOffer(o.id)} aria-label="Remove">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!addingOffer ? (
            <button type="button" className="rewards-detail__add-offer-trigger" onClick={() => setAddingOffer(true)}>
              + Note a portal offer (Chase Offers, Amex Offers, etc.)
            </button>
          ) : (
            <div className="rewards-detail__add-offer-form" onClick={(e) => e.stopPropagation()}>
              <input value={offerMerchant} onChange={(e) => setOfferMerchant(e.target.value)} placeholder="Merchant (e.g. Grubhub)" />
              <input value={offerDescription} onChange={(e) => setOfferDescription(e.target.value)} placeholder="Offer (e.g. $10 off $25)" />
              <input type="date" value={offerExpires} onChange={(e) => setOfferExpires(e.target.value)} />
              <div className="modal__actions">
                <button type="button" className="btn btn--ghost" onClick={() => setAddingOffer(false)}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={addOffer} disabled={offerSaving || !offerMerchant.trim() || !offerDescription.trim()}>
                  {offerSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>

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
