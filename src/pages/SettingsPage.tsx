import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { RecurringTasksPanel } from './settings/RecurringTasksPanel';
import { CalendarsPanel } from './settings/CalendarsPanel';
import { ContactImportPanel } from './settings/ContactImportPanel';
import { UploadPanel } from './settings/UploadPanel';
import { QuickLinksPanel } from './settings/QuickLinksPanel';
import { WalletCategoriesPanel } from './settings/WalletCategoriesPanel';
import { SecurityPanel } from './settings/SecurityPanel';
import { NewsFeedsPanel } from './settings/NewsFeedsPanel';

interface Category {
  id: string;
  label: string;
  icon: string;
}

// A left-hand category list rather than one long scrolling page — Settings
// is expected to grow a lot more sections over time (more integrations,
// general preferences, etc.), and this scales the way the sidebar itself
// does: add a row here and a case in the switch below, nothing else moves.
//
// Upload is first (and so the default screen) on purpose — it's meant to
// become the one place any document gets dropped (Google Health reports,
// bank/investment statements, a car's export, whatever comes next), so it's
// the thing Mike should land on rather than something he has to go find.
const CATEGORIES: Category[] = [
  { id: 'upload', label: 'Upload', icon: '📤' },
  { id: 'recurring', label: 'Recurring Tasks', icon: '🔁' },
  { id: 'calendars', label: 'Calendar Integrations', icon: '📅' },
  { id: 'links', label: 'Links', icon: '🔗' },
  { id: 'wallet', label: 'Wallet Categories', icon: '🎫' },
  { id: 'news-feeds', label: 'News Feeds', icon: '📰' },
  { id: 'contact-import', label: 'Contact Import', icon: '👤' },
  { id: 'security', label: 'Security', icon: '🔒' },
];

export function SettingsPage() {
  useReportTabMeta('Settings', 'settings');
  // Supports deep-linking straight to a category — e.g. News' gear icon
  // links to `/settings?cat=news-feeds` rather than making Mike hunt for
  // it in the sidebar. Falls back to the default first category for a
  // missing/unknown id, same as landing on Settings normally.
  const [searchParams] = useSearchParams();
  const requestedCat = searchParams.get('cat');
  const initialCat = CATEGORIES.some((c) => c.id === requestedCat) ? requestedCat! : CATEGORIES[0].id;
  const [active, setActive] = useState<string>(initialCat);

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Settings
        </h1>
      </div>

      <div className="settings-page__layout">
        <nav className="settings-page__categories">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`settings-page__category${active === cat.id ? ' is-active' : ''}`}
              onClick={() => setActive(cat.id)}
            >
              <span className="settings-page__category-icon">{cat.icon}</span>
              {cat.label}
            </button>
          ))}
        </nav>

        <div className="settings-page__panel">
          {active === 'upload' && <UploadPanel />}
          {active === 'recurring' && <RecurringTasksPanel />}
          {active === 'calendars' && <CalendarsPanel />}
          {active === 'links' && <QuickLinksPanel />}
          {active === 'wallet' && <WalletCategoriesPanel />}
          {active === 'news-feeds' && <NewsFeedsPanel />}
          {active === 'contact-import' && <ContactImportPanel />}
          {active === 'security' && <SecurityPanel />}
        </div>
      </div>
    </div>
  );
}
