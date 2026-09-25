import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { WalletMyCardsPanel } from '../components/WalletMyCardsPanel';
import { RewardsPanel } from '../components/RewardsPanel';
import { PaymentCardsPanel } from '../components/PaymentCardsPanel';

type WalletTab = 'cards' | 'rewards' | 'payment';

/** Wallet — the Reference-section home for all three parts of this
 * feature: "My Cards" (Phase 1 — loyalty/membership/pass/gift cards),
 * "Rewards" (Phase 2 — the credit-card rewards optimizer), and "Payment
 * Cards" (Phase 3 — a secure credit/debit vault). One nav item, one page,
 * a tab switcher between them — Mike was explicit that later parts should
 * live inside the same Wallet area rather than get their own sidebar
 * entries. The tab is reflected in the URL (?tab=rewards / ?tab=payment)
 * so a global-search match, or a bookmark/shared link, lands on the right
 * tab. */
export function WalletPage() {
  useReportTabMeta('Wallet', 'wallet-list');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<WalletTab>(initialTab === 'rewards' ? 'rewards' : initialTab === 'payment' ? 'payment' : 'cards');

  function switchTab(next: WalletTab) {
    setTab(next);
    setSearchParams(next === 'cards' ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="wallet-page">
      <div className="wallet-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Wallet
        </h1>
        <div className="wallet-page__tabs">
          <button type="button" className={`wallet-page__tab${tab === 'cards' ? ' is-active' : ''}`} onClick={() => switchTab('cards')}>
            My Cards
          </button>
          <button type="button" className={`wallet-page__tab${tab === 'rewards' ? ' is-active' : ''}`} onClick={() => switchTab('rewards')}>
            Rewards
          </button>
          <button type="button" className={`wallet-page__tab${tab === 'payment' ? ' is-active' : ''}`} onClick={() => switchTab('payment')}>
            Payment Cards
          </button>
        </div>
      </div>

      {tab === 'cards' ? <WalletMyCardsPanel /> : tab === 'rewards' ? <RewardsPanel /> : <PaymentCardsPanel />}
    </div>
  );
}
