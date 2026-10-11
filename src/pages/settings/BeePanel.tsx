import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { MicrosoftKeys } from './BeeMicrosoftKeys';
import type { BeeFolderCandidate, BeeGaConnection, BeeGscConnection, BeeSettings } from '../../api/types';

/** Settings → Bedford Bee: which Drive folder holds the Substack / Stripe
 * exports (found automatically by the name "Bedford Bee"), Scan Now, and
 * where the monthly export reminder lives. */
export function BeePanel() {
  const [settings, setSettings] = useState<BeeSettings | null>(null);
  const [folders, setFolders] = useState<BeeFolderCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [gsc, setGsc] = useState<BeeGscConnection | null>(null);
  const [ga, setGa] = useState<BeeGaConnection | null>(null);
  const [gscBusy, setGscBusy] = useState(false);
  const [gscMsg, setGscMsg] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  const load = () => {
    api.getBeeSettings().then(setSettings).catch(() => {});
    api.getBeeSearch().then((r) => setGsc(r.connection)).catch(() => {});
    api.getBeeAnalytics().then((r) => setGa(r.connection)).catch(() => {});
    api.getBeeFolders().then(setFolders).catch(() => setFolders([]));
  };
  useEffect(load, []);

  // Back from Google consent: first connect pulls the 16 months right away.
  useEffect(() => {
    const err = params.get('gscError');
    if (err) setGscMsg(err);
    if (params.get('gscConnected')) {
      setGscMsg('Connected — pulling Search Console and Analytics history…');
      syncGsc();
    }
    if (err || params.get('gscConnected')) {
      params.delete('gscError');
      params.delete('gscConnected');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Syncs Search Console and Analytics (whichever the connection covers). */
  async function syncGsc() {
    setGscBusy(true);
    const parts: string[] = [];
    try {
      const r = await api.syncBeeGsc();
      parts.push(`Search Console through ${r.to ?? '—'} (${r.rows.toLocaleString()} search rows${r.indexChecked ? `, ${r.indexChecked} pages checked for indexing` : ''})`);
    } catch (e) {
      parts.push(`Search Console: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const r = await api.syncBeeGa();
      parts.push(`Analytics through ${r.to ?? '—'}`);
    } catch (e) {
      parts.push(`Analytics: ${e instanceof Error ? e.message : String(e)}`);
    }
    setGscMsg(parts.join(' · '));
    load();
    setGscBusy(false);
  }
  async function disconnectGsc() {
    await api.disconnectBeeGsc();
    load();
  }

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

      <h3 className="settings-page__field-label">Google (Search Console + Analytics)</h3>
      {gsc?.connected ? (
        <>
          <p>
            Connected as {gsc.email}
            <br />
            Search Console: {gsc.site ?? 'no thebedfordbee.com property'}
            {gsc.lastDate && <span className="settings-page__section-hint"> · data {gsc.firstDate} → {gsc.lastDate}</span>}
            <br />
            Analytics:{' '}
            {ga?.property ? (
              <>
                {ga.propertyName ?? ga.property}
                {ga.lastDate && <span className="settings-page__section-hint"> · data {ga.firstDate} → {ga.lastDate}</span>}
              </>
            ) : ga && !ga.hasScope ? (
              <strong>not granted yet — click Reconnect and allow Analytics</strong>
            ) : (
              'no property found for thebedfordbee.com'
            )}
          </p>
          <div className="toolbar-row" style={{ justifyContent: 'flex-start', gap: 8 }}>
            <button className="btn btn--sm" onClick={syncGsc} disabled={gscBusy}>
              {gscBusy ? 'Syncing…' : 'Sync Now'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => api.connectBeeGsc()}>
              Reconnect
            </button>
            <button className="btn btn--ghost btn--sm" onClick={disconnectGsc}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-page__section-hint">
            Read-only access to thebedfordbee.com’s Search Console and Google Analytics. Sign in with the account that owns them (thebedfordbee@gmail.com) and tick both boxes. Google will say the app isn’t verified — choose Advanced → Go to MikeOS.
            {gsc?.status === 'disconnected' ? ' Disconnected — the history already pulled is kept.' : ''}
          </p>
          <button className="btn btn--sm" onClick={() => api.connectBeeGsc()}>
            Connect Google
          </button>
        </>
      )}
      {(gscMsg || gsc?.lastError) && <p className="settings-page__section-hint">{gscMsg ?? gsc?.lastError}</p>}

      <MicrosoftKeys />

      <h3 className="settings-page__field-label">Monthly Export Reminder</h3>
      <p className="settings-page__section-hint">
        “Export Bedford Bee Stats (Posts, Subscribers, Stripe)” appears on the 1st of each month and checks itself off once all three new exports are in the folder. Change the day or turn it off in{' '}
        <Link to="/settings?cat=recurring">Recurring Tasks</Link>.
      </p>
    </div>
  );
}
