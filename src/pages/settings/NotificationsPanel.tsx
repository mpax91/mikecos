import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { PushDevicesResponse } from '../../api/types';
import { currentEndpoint, disablePushHere, enablePushHere, pushSupported } from '../../utils/push';

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Settings → Notifications: task reminders pushed to each device that
 * turns them on here (worker/src/push.ts, migration 0128). */
export function NotificationsPanel() {
  const [data, setData] = useState<PushDevicesResponse | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = pushSupported();
  const blocked = supported && Notification.permission === 'denied';

  function load() {
    api
      .listPushDevices()
      .then(setData)
      .catch((e) => setError(String(e)));
    currentEndpoint().then(setHere);
  }
  useEffect(load, []);

  const hereOn = !!here && !!data?.devices.some((d) => d.endpoint === here);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  async function test() {
    await run(async () => {
      const r = await api.pushTest();
      if (!r.sent) throw new Error(r.failed ? 'The push service refused it — see the device list for the error.' : 'No devices are turned on yet.');
    }, 'Sent — it should pop up within a few seconds.');
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Notifications</h2>
      </div>
      <p className="settings-page__section-hint">
        A task with a due date and a time pings every device turned on here when its time comes (within about 2 minutes). On a computer it shows as a Windows notification while Chrome is running; on
        Android, install MikeOS to the home screen first and turn it on from the app. Until its time, a timed task sits folded under “Later Today” on Today.
      </p>

      <div className="card" style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ marginRight: 'auto' }}>This Device: {!supported ? 'Not Supported' : blocked ? 'Blocked' : hereOn ? 'On' : 'Off'}</strong>
        {supported && !hereOn && (
          <button type="button" className="btn" disabled={busy || blocked} onClick={() => run(enablePushHere, 'Turned on for this device.')}>
            Turn On Here
          </button>
        )}
        {hereOn && (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => run(disablePushHere, 'Turned off for this device.')}>
            Turn Off Here
          </button>
        )}
        <button type="button" className="btn btn--ghost" disabled={busy || !data?.devices.length} onClick={test}>
          Send Test
        </button>
      </div>
      {blocked && <p className="settings-page__section-hint">Notifications are blocked for this site. Click the icon left of the address bar → Site settings → Notifications → Allow, then reload.</p>}
      {msg && <p className="settings-page__section-hint">{msg}</p>}
      {error && (
        <p className="settings-page__section-hint" style={{ color: 'var(--danger, #b3261e)' }}>
          {error}
        </p>
      )}

      <h3 className="settings-page__section-title" style={{ fontSize: 15, marginTop: 18 }}>
        Devices
      </h3>
      {!data ? (
        <p className="settings-page__section-hint">Loading…</p>
      ) : data.devices.length === 0 ? (
        <p className="settings-page__section-hint">None yet — open MikeOS on each computer and phone and press Turn On Here.</p>
      ) : (
        <div className="card task-list">
          {data.devices.map((d) => (
            <div key={d.id} className="task-row" style={{ gap: 10, padding: '10px 14px' }}>
              <span className="task-row__title">
                {d.label || 'Device'}
                {d.endpoint === here ? ' · This Device' : ''}
                <span style={{ display: 'block', fontSize: 12, opacity: 0.7 }}>
                  Added {when(d.created_at)} · Last delivered {when(d.last_ok_at)}
                  {d.last_error ? ` · ⚠ ${d.last_error}` : ''}
                </span>
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => run(() => api.pushUnsubscribe({ id: d.id }), 'Removed.')}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {!!data?.recent.length && (
        <>
          <h3 className="settings-page__section-title" style={{ fontSize: 15, marginTop: 18 }}>
            Recent Reminders
          </h3>
          <div className="card task-list">
            {data.recent.map((r) => (
              <div key={r.entity_id + r.fire_key} className="task-row" style={{ padding: '10px 14px' }}>
                <span className="task-row__title">
                  {r.title || 'Task'}
                  <span style={{ display: 'block', fontSize: 12, opacity: 0.7 }}>
                    Due {r.fire_key} · {r.devices ? `sent to ${r.devices} device${r.devices === 1 ? '' : 's'} ${when(r.sent_at)}` : 'not sent (too late or no device)'}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
