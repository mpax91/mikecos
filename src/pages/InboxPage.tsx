import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { InboxWidget } from '../components/InboxWidget';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Inbox's own full page (Now → Inbox in the sidebar) — the same feed
 * Today shows a lighter copy of (see TodayPage's own Inbox section, which
 * wraps this identical InboxWidget). Its own page mainly exists so Inbox
 * shows up as a first-class destination the way News/Bets do rather than
 * being buried inside Today, and so there's room for a manual "Sync Now"
 * — useful right after adding a new account, without waiting for the next
 * cron tick. A full reload (rather than re-fetching in place) is the
 * simplest correct way to pick up the sync's results, since InboxWidget
 * owns its own data fetch internally with no refresh handle exposed. */
export function InboxPage() {
  useReportTabMeta('Inbox', 'inbox');
  const [syncing, setSyncing] = useState(false);

  async function syncNow() {
    setSyncing(true);
    try {
      await api.syncEmailNow();
      window.location.reload();
    } catch {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Inbox
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link to="/settings?cat=email-accounts" className="btn btn--ghost btn--sm">
            Manage Accounts
          </Link>
          <button type="button" className="btn btn--sm" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>
      <InboxWidget />
    </div>
  );
}
