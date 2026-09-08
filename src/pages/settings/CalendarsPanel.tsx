import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { CalendarFeedStatus } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface FormState {
  id: string | null; // null while creating
  label: string;
  url: string; // blank when editing until Mike types a replacement — see hint text in the modal
}

function blankForm(): FormState {
  return { id: null, label: '', url: '' };
}

function StatusBadge({ cal }: { cal: CalendarFeedStatus }) {
  if (!cal.active) return <span className="settings-page__calendar-badge is-off">Paused</span>;
  if (!cal.ok) return <span className="settings-page__calendar-badge is-error">Error</span>;
  return <span className="settings-page__calendar-badge is-ok">Connected</span>;
}

/** Calendar Integrations — self-service management of the Google Calendar
 * "secret address" (iCal) feeds that populate Today's Meetings. These used
 * to live only as GitHub Actions / Cloudflare Worker secrets (edit a repo
 * secret, redeploy, hope for the best); Mike chose to move them into
 * MikeOS's own database instead so a broken or new calendar can be fixed
 * right here. The real URL is only ever sent up (create/edit), never back
 * down — the list always shows a masked `urlPreview` — so editing a feed
 * means pasting the URL again, not seeing the old one. */
export function CalendarsPanel() {
  const [calendars, setCalendars] = useState<CalendarFeedStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [form, setForm] = useState<FormState | null>(null); // non-null = modal open
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<CalendarFeedStatus | null>(null);

  function load() {
    setChecking(true);
    api
      .listCalendarFeeds(todayLocalISO())
      .then((res) => {
        setCalendars(res.calendars);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setChecking(false));
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setForm(blankForm());
    setSaveError(null);
  }

  function openEdit(cal: CalendarFeedStatus) {
    setForm({ id: cal.id, label: cal.label, url: '' });
    setSaveError(null);
  }

  async function handleSave() {
    if (!form) return;
    const label = form.label.trim();
    const url = form.url.trim();
    if (!label) return;
    if (!form.id && !url) return; // creating requires a URL; editing may leave it blank to keep the existing one
    setSaving(true);
    setSaveError(null);
    try {
      if (form.id) {
        const patch: Partial<{ label: string; url: string }> = { label };
        if (url) patch.url = url;
        await api.updateCalendarFeed(form.id, patch);
      } else {
        await api.createCalendarFeed({ label, url });
      }
      setForm(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(cal: CalendarFeedStatus) {
    setCalendars((prev) => (prev ? prev.map((c) => (c.id === cal.id ? { ...c, active: !c.active } : c)) : prev));
    await api.updateCalendarFeed(cal.id, { active: !cal.active });
    load();
  }

  async function handleDelete(cal: CalendarFeedStatus) {
    setCalendars((prev) => (prev ? prev.filter((c) => c.id !== cal.id) : prev));
    await api.deleteCalendarFeed(cal.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load calendars: {error}</div>;
  if (!calendars) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Calendar Integrations</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost" onClick={load} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <button className="btn" onClick={openCreate}>
            + Add Calendar
          </button>
        </div>
      </div>
      <p className="settings-page__section-hint">
        These feed "Today's Meetings" on the Day view. Each is a Google Calendar "secret address" (iCal) URL — from
        Google Calendar, go to Settings for that calendar → "Integrate calendar" → Secret address in iCal format.
        Click the dot next to one to pause or resume it.
      </p>

      {calendars.length === 0 ? (
        <div className="empty-state">No calendars connected yet — add your first one.</div>
      ) : (
        <div className="settings-page__calendar-list card">
          {calendars.map((cal) => (
            <div key={cal.id} className={`settings-page__calendar-row${cal.active ? '' : ' is-inactive'}`}>
              <button
                type="button"
                className="settings-page__recurring-toggle"
                title={cal.active ? 'Active — click to pause' : 'Paused — click to resume'}
                onClick={() => handleToggleActive(cal)}
              >
                {cal.active ? '●' : '○'}
              </button>
              <div className="settings-page__calendar-main" onClick={() => openEdit(cal)}>
                <div className="settings-page__calendar-label">{cal.label}</div>
                {cal.active && cal.ok && (
                  <div className="settings-page__calendar-meta">
                    {cal.eventCountToday} event{cal.eventCountToday === 1 ? '' : 's'} today · {cal.urlPreview}
                  </div>
                )}
                {cal.active && !cal.ok && (
                  <div className="settings-page__calendar-meta is-error">{cal.error ?? 'Something went wrong'}</div>
                )}
                {!cal.active && <div className="settings-page__calendar-meta">{cal.urlPreview}</div>}
              </div>
              <StatusBadge cal={cal} />
              <button type="button" className="settings-page__recurring-delete" title="Delete" onClick={() => setDeleting(cal)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Modal title={form.id ? 'Edit Calendar' : 'Add Calendar'} onClose={() => setForm(null)}>
          <input
            autoFocus
            placeholder="Label (e.g. Michael's Calendar)"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />

          <label className="settings-page__field-label">Secret address (iCal URL)</label>
          <input
            placeholder={form.id ? 'Leave blank to keep the current URL' : 'https://calendar.google.com/calendar/ical/.../basic.ics'}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            style={{ fontFamily: 'monospace' }}
          />

          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}

          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleSave} disabled={!form.label.trim() || (!form.id && !form.url.trim()) || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this calendar?"
          body={`"${deleting.label}" will stop showing up on Today's Meetings.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
