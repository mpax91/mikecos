import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { WalletMyCardsPanel } from './WalletMyCardsPanel';
import { PaymentCardsPanel } from './PaymentCardsPanel';
import { RewardsPanel } from './RewardsPanel';
import { LostWalletModal } from './LostWalletModal';

type DatabaseType = 'loyalty' | 'payment' | 'rewards';

function isDatabaseType(v: string | null): v is DatabaseType {
  return v === 'loyalty' || v === 'payment' || v === 'rewards';
}

/** Card Database — the second half of Mike's Wallet redesign: "a Card
 * database and I then show loyalty cards, payment cards, etc." A single
 * top-level pill row picks the card type; WalletMyCardsPanel already has
 * its own category chips underneath (car, grocery, parks & recreation,
 * military, travel, ID, etc. — see wallet_categories) so selecting
 * "Loyalty" here gets that second-row drill-down for free, unmodified.
 * "Rewards" is the credit-card rewards optimizer's own card list (bonuses,
 * perks, import) — a different concept from the secure Payment Cards
 * vault, so it's its own pill rather than folded into "Payment." */
export function CardDatabasePanel() {
  // Synced to ?type= so a global-search deep-link (a rewards_card or
  // payment_card match — see worker's runSearch, which routes those to
  // /wallet?tab=database&type=rewards / &type=payment) lands on the right
  // pill instead of always defaulting to Loyalty.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialType = searchParams.get('type');
  const [type, setTypeState] = useState<DatabaseType>(isDatabaseType(initialType) ? initialType : 'loyalty');
  const [lostWalletOpen, setLostWalletOpen] = useState(false);

  function setType(next: DatabaseType) {
    setTypeState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'loyalty') params.delete('type');
    else params.set('type', next);
    params.set('tab', 'database');
    setSearchParams(params, { replace: true });
  }

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-page__chips" style={{ margin: 0 }}>
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
        <button type="button" className="btn btn--ghost" onClick={() => setLostWalletOpen(true)}>
          Lost my wallet?
        </button>
      </div>

      {type === 'loyalty' && <WalletMyCardsPanel />}
      {type === 'payment' && <PaymentCardsPanel />}
      {type === 'rewards' && <RewardsPanel mode="manage" />}

      {lostWalletOpen && <LostWalletModal onClose={() => setLostWalletOpen(false)} />}
    </div>
  );
}
