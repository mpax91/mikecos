import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { InboxSplitView } from '../components/InboxSplitView';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Inbox's own full page (Now → Inbox in the sidebar) — a real reading
 * experience (InboxSplitView: message list + reading pane), distinct from
 * the compact status-board version Today shows (InboxWidget, an inline-
 * expanding list — right for a glance, too cramped for actually reading
 * mail). Its own page mainly exists so Inbox shows up as a first-class
 * destination the way News/Bets do rather than being buried inside Today,
 * and so there's room for a manual "Sync Now" — useful right after adding
 * a new account, without waiting for the next cron tick. A full reload
 * (rather than re-fetching in place) is the simplest correct way to pick
 * up the sync's results, since InboxSplitView owns its own data fetch
 * internally with no refresh handle exposed. */
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
          <Link to="/settings?cat=email-accounts" className="settings-gear-link" title="Manage Email Accounts" aria-label="Manage Email Accounts">
            ⚙️
          </Link>
          <button type="button" className="btn btn--sm" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>
      <InboxSplitView />
    </div>
  );
}
