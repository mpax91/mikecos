import { useState } from 'react';
import { useReportTabMeta } from '../contexts/TabsContext';
import { RecurringTasksPanel } from './settings/RecurringTasksPanel';
import { CalendarsPanel } from './settings/CalendarsPanel';

interface Category {
  id: string;
  label: string;
  icon: string;
}

// A left-hand category list rather than one long scrolling page — Settings
// is expected to grow a lot more sections over time (more integrations,
// general preferences, etc.), and this scales the way the sidebar itself
// does: add a row here and a case in the switch below, nothing else moves.
const CATEGORIES: Category[] = [
  { id: 'recurring', label: 'Recurring Tasks', icon: '🔁' },
  { id: 'calendars', label: 'Calendar Integrations', icon: '📅' },
];

export function SettingsPage() {
  useReportTabMeta('Settings', 'settings');
  const [active, setActive] = useState<string>(CATEGORIES[0].id);

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
          {active === 'recurring' && <RecurringTasksPanel />}
          {active === 'calendars' && <CalendarsPanel />}
        </div>
      </div>
    </div>
  );
}
