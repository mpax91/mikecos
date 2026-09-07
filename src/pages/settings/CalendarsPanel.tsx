import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { CalendarStatus } from '../../api/types';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function StatusBadge({ cal }: { cal: CalendarStatus }) {
  if (!cal.configured) return <span className="settings-page__calendar-badge is-off">Not connected</span>;
  if (!cal.ok) return <span className="settings-page__calendar-badge is-error">Error</span>;
  return <span className="settings-page__calendar-badge is-ok">Connected</span>;
}

/** Calendar Integrations — a read-only health check for the two Google
 * Calendar feeds Day view pulls "Today's Meetings" from (see the worker's
 * GET /api/meetings and /api/calendars/status). Adding, removing, or
 * rotating a calendar isn't self-service from here yet — the feed URL is a
 * Cloudflare Worker secret, set from a GitHub Actions repository secret on
 * deploy, specifically so the "secret address" URL (equivalent to a
 * password — anyone with it can read the whole calendar) never has to sit
 * in the app's own database or pass through this UI. This panel exists so
 * that when something breaks, Mike can see which calendar and why without
 * digging through Cloudflare/GitHub first. */
export function CalendarsPanel() {
  const [data, setData] = useState<{ today: string; calendars: CalendarStatus[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  function load() {
    setChecking(true);
    api
      .getCalendarStatus(todayLocalISO())
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setChecking(false));
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Calendar Integrations</h2>
        <button className="btn btn--ghost" onClick={load} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p className="settings-page__section-hint">
        These feed "Today's Meetings" on the Day view. Each is a Google Calendar "secret address" (iCal) URL, stored as a
        Cloudflare Worker secret rather than in MikeOS itself — to add, remove, or replace one, update the
        <code> GOOGLE_ICS_URL_PERSONAL</code>/<code>GOOGLE_ICS_URL_SHARED</code> repository secrets on GitHub and redeploy.
      </p>

      {error && <div className="empty-state">Couldn't check calendar status: {error}</div>}

      {data && (
        <div className="settings-page__calendar-list card">
          {data.calendars.map((cal) => (
            <div key={cal.id} className="settings-page__calendar-row">
              <div className="settings-page__calendar-main">
                <div className="settings-page__calendar-label">{cal.label}</div>
                {cal.configured && cal.ok && (
                  <div className="settings-page__calendar-meta">
                    {cal.eventCountToday} event{cal.eventCountToday === 1 ? '' : 's'} today
                  </div>
                )}
                {cal.configured && !cal.ok && cal.error && <div className="settings-page__calendar-meta is-error">{cal.error}</div>}
                {!cal.configured && <div className="settings-page__calendar-meta">No secret URL set for this calendar yet</div>}
              </div>
              <StatusBadge cal={cal} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
