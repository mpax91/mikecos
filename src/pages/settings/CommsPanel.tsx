import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { CommsSettings } from '../../api/types';

/** Settings → Calls & Texts: the phone backup folder (SMS Backup & Restore
 * → Drive "SMS", found by name), how far each stream has been read, and
 * Scan Now. Counts and dates only — message text is never read or stored. */
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export function CommsPanel() {
  const [s, setS] = useState<CommsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.getCommsSettings().then(setS).catch((e) => setMsg(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function scan() {
    setBusy(true);
    setMsg('Reading the newest backup…');
    try {
      const r = await api.scanComms();
      setMsg(
        r.errors.length
          ? r.errors.join(' · ')
          : `Calls +${r.calls.added.toLocaleString()} · texts +${r.texts.added.toLocaleString()} · chats +${r.chats.added.toLocaleString()} (${Math.round(r.chats.bytes / 1e6)} MB read${r.chats.done ? ', caught up' : ' — more next run'})`
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
    load();
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Calls &amp; Texts</h2>
        <button type="button" className="btn" disabled={busy} onClick={scan}>
          {busy ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>
      <p className="settings-page__section-hint">
        MikeOS reads your phone’s nightly backup from SMS Backup &amp; Restore (the Google Drive folder named <strong>SMS</strong>) and keeps, for each phone
        number, how many calls and texts went each way per month and when you last talked. It never reads or stores message text or attachments, and
        numbers are stored only as a one-way code — they show up on a <Link to="/contacts">contact</Link> card when the number matches.
      </p>
      {s?.backupStale && (
        <div className="fin-dash__flag fin-dash__flag--warn comms-stale">
          <span className="fin-dash__flag-icon">⚠</span>
          <span className="fin-dash__flag-msg">
            No new phone backup since {fmt(s.latestBackupAt)}. Open SMS Backup &amp; Restore on your phone and check that the nightly backup to Google Drive is
            still on (and signed in) — contact cards stop updating until it is.
          </span>
        </div>
      )}
      {!s ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <dl className="adt__kv comms-settings__kv">
          <dt>Folder</dt>
          <dd>
            {s.folder ? (
              s.folder.url ? (
                <a href={s.folder.url} target="_blank" rel="noreferrer">
                  {s.folder.name} ↗
                </a>
              ) : (
                s.folder.name
              )
            ) : (
              'Not found yet — Scan Now looks for “SMS” at the top of your connected Google Drives'
            )}
          </dd>
          <dt>Newest Backup</dt>
          <dd className={s.backupStale ? 'fin-dash__neg' : undefined}>{fmt(s.latestBackupAt)}</dd>
          <dt>Calls Read Through</dt>
          <dd>{fmtDay(s.callsThrough)}</dd>
          <dt>Texts Read Through</dt>
          <dd>{fmtDay(s.textsThrough)}</dd>
          <dt>Chats Read Through</dt>
          <dd>
            {fmtDay(s.chatsThrough)}
            {s.folder && !s.chatsCaughtUp ? ' (still catching up — continues hourly)' : ''}
          </dd>
          <dt>History Starts</dt>
          <dd>{fmtDay(s.firstAt)}</dd>
          <dt>Counted</dt>
          <dd>
            {s.counts
              ? `${s.counts.calls.toLocaleString()} calls · ${s.counts.texts.toLocaleString()} 1:1 texts · ${s.counts.group_msgs.toLocaleString()} group messages · ${s.counts.numbers.toLocaleString()} numbers · ${s.counts.groups.toLocaleString()} group chats`
              : '—'}
          </dd>
          <dt>Last Scan</dt>
          <dd>{fmt(s.lastScanAt)}</dd>
          {s.lastError && (
            <>
              <dt>Last Error</dt>
              <dd className="fin-dash__neg">{s.lastError}</dd>
            </>
          )}
        </dl>
      )}
      {msg && <p className="settings-page__section-hint">{msg}</p>}
      <p className="fin-dash__note">
        Runs on its own every hour a newer backup has landed (the first pass through the big texts file takes a few hours). Keep SMS Backup &amp; Restore
        backing up calls and messages to this folder; keeping attachments is fine — they’re skipped. If no new backup arrives for 2 days, a warning shows here and on Contacts.
      </p>
    </div>
  );
}
