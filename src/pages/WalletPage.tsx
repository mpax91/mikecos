import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { WalletMyCardsPanel } from '../components/WalletMyCardsPanel';
import { RewardsPanel } from '../components/RewardsPanel';

type WalletTab = 'cards' | 'rewards';

/** Wallet — the Reference-section home for both parts of this feature: "My
 * Cards" (Phase 1 — loyalty/membership/pass/gift cards) and "Rewards"
 * (Phase 2 — the credit-card rewards optimizer). One nav item, one page,
 * a tab switcher between them — Mike was explicit that Part 2 should live
 * inside the same Wallet area rather than get its own sidebar entry. The
 * tab is reflected in the URL (?tab=rewards) so a global-search match on a
 * rewards card, or a bookmark/shared link, lands on the right tab. */
export function WalletPage() {
  useReportTabMeta('Wallet', 'wallet-list');
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<WalletTab>(searchParams.get('tab') === 'rewards' ? 'rewards' : 'cards');

  function switchTab(next: WalletTab) {
    setTab(next);
    setSearchParams(next === 'rewards' ? { tab: 'rewards' } : {}, { replace: true });
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
        </div>
      </div>

      {tab === 'cards' ? <WalletMyCardsPanel /> : <RewardsPanel />}
    </div>
  );
}
