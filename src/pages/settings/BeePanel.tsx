import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { BeeFolderCandidate, BeeSettings } from '../../api/types';

/** Settings → Bedford Bee: which Drive folder holds the Substack / Stripe
 * exports (found automatically by the name "Bedford Bee"), Scan Now, and
 * where the monthly export reminder lives. */
export function BeePanel() {
  const [settings, setSettings] = useState<BeeSettings | null>(null);
  const [folders, setFolders] = useState<BeeFolderCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    api.getBeeSettings().then(setSettings).catch(() => {});
    api.getBeeFolders().then(setFolders).catch(() => setFolders([]));
  };
  useEffect(load, []);

  async function choose(f: BeeFolderCandidate) {
    await api.setBeeFolder({ cloudAccountId: f.accountId, folderId: f.folderId, folderName: f.folderName, folderUrl: f.folderUrl });
    load();
  }
  async function scan() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.scanBee();
      setMsg(r.errors.length ? r.errors.join(' · ') : `Checked ${r.listed} file${r.listed === 1 ? '' : 's'}, read ${r.read} new.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Bedford Bee</h2>
        <button className="btn" onClick={scan} disabled={busy}>
          {busy ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>
      <p className="settings-page__section-hint">
        Substack has no API, so the <Link to="/bee">Bedford Bee dashboard</Link> reads exports you drop in a Google Drive folder named “Bedford Bee”: Substack’s posts export, its subscriber export and Stripe’s
        balance history (CSV, all time). It checks nightly. Each month add fresh copies named “YYYY.MM.DD - Bedford Bee - Posts / Subscribers / Stripe.csv” and keep the old subscriber files — comparing them shows
        who left. Subscribers are linked to Contacts automatically (the “Bee” label).
      </p>

      <h3 className="settings-page__field-label">Folder</h3>
      {settings?.folderId ? (
        <p>
          {settings.folderUrl ? (
            <a href={settings.folderUrl} target="_blank" rel="noopener noreferrer">
              {settings.folderName ?? 'Bedford Bee'}
            </a>
          ) : (
            settings.folderName
          )}
          {settings.lastScanAt && <span className="settings-page__section-hint"> · last checked {new Date(settings.lastScanAt).toLocaleString()}</span>}
        </p>
      ) : (
        <p className="settings-page__section-hint">Not set yet — Scan Now finds the “Bedford Bee” folder on your connected Google Drives.</p>
      )}
      {settings?.lastError && <p className="settings-page__section-hint fin-dash__neg">{settings.lastError}</p>}
      {folders && folders.length > 1 && (
        <>
          <p className="settings-page__section-hint">More than one “Bedford Bee” folder found — pick the one with the exports:</p>
          <ul>
            {folders.map((f) => (
              <li key={`${f.accountId}:${f.folderId}`}>
                {f.accountLabel} · {f.folderName}{' '}
                {f.folderId === settings?.folderId ? (
                  <strong>(in use)</strong>
                ) : (
                  <button className="btn btn--ghost btn--sm" onClick={() => choose(f)}>
                    Use This Folder
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {msg && <p className="settings-page__section-hint">{msg}</p>}

      <h3 className="settings-page__field-label">Monthly Export Reminder</h3>
      <p className="settings-page__section-hint">
        “Export Bedford Bee Stats (Posts, Subscribers, Stripe)” appears on the 1st of each month and checks itself off once all three new exports are in the folder. Change the day or turn it off in{' '}
        <Link to="/settings?cat=recurring">Recurring Tasks</Link>.
      </p>
    </div>
  );
}
