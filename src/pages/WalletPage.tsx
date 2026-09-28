import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { RewardsPanel } from '../components/RewardsPanel';
import { CardDatabasePanel } from '../components/CardDatabasePanel';

type WalletTab = 'home' | 'database';

/** Wallet — redesigned per Mike's own explicit ask (the old 3-tab My
 * Cards/Rewards/Payment Cards split was "clunky", left him guessing which
 * tab to be in). Now two tabs: "Wallet" (the default landing view — Best
 * Cards along the top, every reward card ranked by its own current rate,
 * and Find, all on one screen — see RewardsPanel's mode="home") and "Card
 * Database" (loyalty/payment/rewards cards, one unified place, picked by
 * pill — see CardDatabasePanel). The tab is reflected in the URL
 * (?tab=database) so a global-search match, or a bookmark/shared link,
 * lands on the right one; a rewards_card deep-link needs the Card
 * Database → Rewards pill specifically, since that's the only place a
 * Rewards card's own edit view lives now. */
export function WalletPage() {
  useReportTabMeta('Wallet', 'wallet-list');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<WalletTab>(initialTab === 'database' || initialTab === 'rewards' || initialTab === 'payment' || initialTab === 'cards' ? 'database' : 'home');

  function switchTab(next: WalletTab) {
    setTab(next);
    setSearchParams(next === 'home' ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="wallet-page">
      <div className="wallet-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Wallet
        </h1>
        <div className="wallet-page__tabs">
          <button type="button" className={`wallet-page__tab${tab === 'home' ? ' is-active' : ''}`} onClick={() => switchTab('home')}>
            Wallet
          </button>
          <button type="button" className={`wallet-page__tab${tab === 'database' ? ' is-active' : ''}`} onClick={() => switchTab('database')}>
            Card Database
          </button>
        </div>
      </div>

      {tab === 'home' ? <RewardsPanel mode="home" /> : <CardDatabasePanel />}
    </div>
  );
}
