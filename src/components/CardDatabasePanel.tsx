import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { WalletCard, PaymentCard, RewardsCard } from '../api/types';
import { WalletMyCardsPanel } from './WalletMyCardsPanel';
import { PaymentCardsPanel } from './PaymentCardsPanel';
import { RewardsPanel } from './RewardsPanel';
import { LostWalletModal } from './LostWalletModal';

type DatabaseType = 'loyalty' | 'payment' | 'rewards';

function isDatabaseType(v: string | null): v is DatabaseType {
  return v === 'loyalty' || v === 'payment' || v === 'rewards';
}

interface SearchHit {
  type: DatabaseType;
  id: string;
  title: string;
  typeLabel: string;
  detail: string;
}

const TYPE_LABEL: Record<DatabaseType, string> = { loyalty: 'Loyalty', payment: 'Payment', rewards: 'Rewards' };

function matchesLoyalty(c: WalletCard, q: string): string | null {
  const hay = [c.name, c.category, c.notes, c.displayNumber].filter(Boolean).join(' ').toLowerCase();
  if (!hay.includes(q)) return null;
  return [c.category, c.displayNumber ? `····${c.displayNumber}` : null].filter(Boolean).join(' · ');
}

function matchesPayment(c: PaymentCard, q: string): string | null {
  // last4 is the field Mike actually hit the gap on — searching "0632"
  // (a payment card's last 4) found nothing because this tab never
  // searched Payment Cards at all. The real card number is never sent to
  // the client (see PaymentCard.hasNumber) so it can't be searched here —
  // last4, nickname, network, issuer, cardholder name, and billing zip
  // cover everything that's actually on hand to match against.
  const hay = [c.nickname, c.network, c.issuer, c.last4, c.nameOnCard, c.billingZip, c.notes].filter(Boolean).join(' ').toLowerCase();
  if (!hay.includes(q)) return null;
  return [c.network, c.last4 ? `····${c.last4}` : null].filter(Boolean).join(' · ');
}

function matchesRewards(c: RewardsCard, q: string): string | null {
  const bonusText = c.bonuses.map((b) => b.category).join(' ');
  const perkText = c.perks.map((p) => p.label).join(' ');
  const hay = [c.nickname, c.network, c.last4, c.notes, bonusText, perkText].filter(Boolean).join(' ').toLowerCase();
  if (!hay.includes(q)) return null;
  return [c.network, c.last4 ? `····${c.last4}` : null].filter(Boolean).join(' · ');
}

/** Card Database — the second half of Mike's Wallet redesign: "a Card
 * database and I then show loyalty cards, payment cards, etc." A single
 * top-level pill row picks the card type; WalletMyCardsPanel already has
 * its own category chips underneath (car, grocery, parks & recreation,
 * military, travel, ID, etc. — see wallet_categories) so selecting
 * "Loyalty" here gets that second-row drill-down for free, unmodified.
 * "Rewards" is the credit-card rewards optimizer's own card list (bonuses,
 * perks, import) — a different concept from the secure Payment Cards
 * vault, so it's its own pill rather than folded into "Payment."
 *
 * The search box lives here, one level above the pills, rather than
 * inside each tab's own panel — Mike's own ask was that "Search your
 * wallet" search everything (loyalty, payment, rewards) in one go rather
 * than only whichever pill happens to be selected. Typing a query hides
 * the normal pill content and shows matches across all three card
 * families at once; clicking one switches to its pill and opens it, using
 * the same openId deep-link each panel already supports for global
 * search results. */
export function CardDatabasePanel() {
  // Synced to ?type= so a global-search deep-link (a rewards_card or
  // payment_card match — see worker's runSearch, which routes those to
  // /wallet?tab=database&type=rewards / &type=payment) lands on the right
  // pill instead of always defaulting to Loyalty.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialType = searchParams.get('type');
  const [type, setTypeState] = useState<DatabaseType>(isDatabaseType(initialType) ? initialType : 'loyalty');
  const [lostWalletOpen, setLostWalletOpen] = useState(false);

  const [query, setQuery] = useState('');
  const [loyaltyCards, setLoyaltyCards] = useState<WalletCard[] | null>(null);
  const [paymentCards, setPaymentCards] = useState<PaymentCard[] | null>(null);
  const [rewardsCards, setRewardsCards] = useState<RewardsCard[] | null>(null);

  // Loaded once up front (not only once a query is typed) so the first
  // keystroke already has something to search — these lists are small
  // (a few dozen cards at most across all three), so there's no real cost
  // to holding them alongside whatever the active pill's own panel fetches
  // for itself.
  useEffect(() => {
    api.listWalletCards().then(setLoyaltyCards).catch(() => setLoyaltyCards([]));
    api.listPaymentCards().then(setPaymentCards).catch(() => setPaymentCards([]));
    api.listRewardsCards().then(setRewardsCards).catch(() => setRewardsCards([]));
  }, []);

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchHit[] = [];
    for (const c of loyaltyCards ?? []) {
      const detail = matchesLoyalty(c, q);
      if (detail !== null) out.push({ type: 'loyalty', id: c.id, title: c.name, typeLabel: TYPE_LABEL.loyalty, detail });
    }
    for (const c of paymentCards ?? []) {
      const detail = matchesPayment(c, q);
      if (detail !== null) out.push({ type: 'payment', id: c.id, title: c.nickname, typeLabel: TYPE_LABEL.payment, detail });
    }
    for (const c of rewardsCards ?? []) {
      const detail = matchesRewards(c, q);
      if (detail !== null) out.push({ type: 'rewards', id: c.id, title: c.nickname, typeLabel: TYPE_LABEL.rewards, detail });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }, [query, loyaltyCards, paymentCards, rewardsCards]);

  const searching = query.trim().length > 0;

  function setType(next: DatabaseType) {
    setTypeState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'loyalty') params.delete('type');
    else params.set('type', next);
    params.set('tab', 'database');
    setSearchParams(params, { replace: true });
  }

  function openHit(hit: SearchHit) {
    setQuery('');
    setTypeState(hit.type);
    const params = new URLSearchParams(searchParams);
    if (hit.type === 'loyalty') params.delete('type');
    else params.set('type', hit.type);
    params.set('tab', 'database');
    setSearchParams(params, { replace: true, state: { openId: hit.id } });
  }

  return (
    <div>
      <div className="wallet-page__toolbar">
        <input
          type="search"
          className="wallet-page__search"
          placeholder="Search your wallet…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setLostWalletOpen(true)}>
          Lost my wallet?
        </button>
      </div>

      {searching ? (
        <div className="wallet-page__section">
          {hits.length === 0 ? (
            <div className="empty-state">Nothing in Loyalty, Payment, or Rewards matches "{query.trim()}".</div>
          ) : (
            <ul className="rewards-find__results">
              {hits.map((hit) => (
                <li key={`${hit.type}-${hit.id}`} className="rewards-find__result" onClick={() => openHit(hit)}>
                  <div className="card-database__result-type">{hit.typeLabel}</div>
                  <div className="rewards-find__result-body">
                    <div className="rewards-find__result-name">{hit.title}</div>
                    {hit.detail && <div className="rewards-find__result-reason">{hit.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="wallet-page__chips">
            <button type="button" className={`wallet-page__chip${type === 'loyalty' ? ' is-active' : ''}`} onClick={() => setType('loyalty')}>
              Loyalty
            </button>
            <button type="button" className={`wallet-page__chip${type === 'payment' ? ' is-active' : ''}`} onClick={() => setType('payment')}>
              Payment
            </button>
            <button type="button" className={`wallet-page__chip${type === 'rewards' ? ' is-active' : ''}`} onClick={() => setType('rewards')}>
              Rewards
            </button>
          </div>

          {type === 'loyalty' && <WalletMyCardsPanel />}
          {type === 'payment' && <PaymentCardsPanel />}
          {type === 'rewards' && <RewardsPanel mode="manage" />}
        </>
      )}

      {lostWalletOpen && <LostWalletModal onClose={() => setLostWalletOpen(false)} />}
    </div>
  );
}
