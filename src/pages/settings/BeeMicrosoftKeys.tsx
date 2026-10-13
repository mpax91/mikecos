import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { BeeBing, BeeClarity } from '../../api/types';
import { apiError } from '../../components/BeeMicrosoftSections';

/** Settings → Bedford Bee: paste-a-key connections for Bing Webmaster
 * Tools and Microsoft Clarity (stored encrypted; never shown again). */
export function MicrosoftKeys() {
  const [bing, setBing] = useState<BeeBing['connection'] | null>(null);
  const [clarity, setClarity] = useState<BeeClarity['connection'] | null>(null);
  const [bingKey, setBingKey] = useState('');
  const [clarityToken, setClarityToken] = useState('');
  const [busy, setBusy] = useState<'bing' | 'clarity' | null>(null);
  const [msg, setMsg] = useState<{ bing?: string; clarity?: string }>({});

  const load = () => {
    api.getBeeBing().then((r) => setBing(r.connection)).catch(() => {});
    api.getBeeClarity().then((r) => setClarity(r.connection)).catch(() => {});
  };
  useEffect(load, []);

  async function saveBing(key: string | null) {
    setBusy('bing');
    try {
      const r = await api.setBeeBingKey(key);
      setMsg((m) => ({
        ...m,
        bing: !key
          ? 'Disconnected — history is kept.'
          : r.pending
            ? 'Key saved. Bing is rate-limiting the shared network MikeOS runs on right now, so MikeOS will finish connecting on its own (it retries every couple of hours).'
            : `Connected to ${r.site} — pulling Bing history in the background (refresh the Google Search tab in a minute).`,
      }));
      setBingKey('');
      load();
    } catch (e) {
      setMsg((m) => ({ ...m, bing: apiError(e) }));
    } finally {
      setBusy(null);
    }
  }
  async function saveClarity(token: string | null) {
    setBusy('clarity');
    try {
      await api.setBeeClarityToken(token);
      setMsg((m) => ({ ...m, clarity: token ? 'Connected — today’s snapshot is saved; one more arrives each night.' : 'Disconnected — history is kept.' }));
      setClarityToken('');
      load();
    } catch (e) {
      setMsg((m) => ({ ...m, clarity: apiError(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h3 className="settings-page__field-label">Bing Webmaster Tools</h3>
      {bing?.connected ? (
        <p>
          {bing.site ?? 'Key saved — waiting for Bing to stop throttling'}
          {bing.lastOkAt && <span className="settings-page__section-hint"> · last synced {new Date(bing.lastOkAt).toLocaleString()}</span>}
          {bing.lastError && bing.lastSyncAt && <span className="settings-page__section-hint"> · last try {new Date(bing.lastSyncAt).toLocaleString()} failed</span>}{' '}
          <button className="btn btn--ghost btn--sm" onClick={() => saveBing(null)} disabled={busy === 'bing'}>
            Disconnect
          </button>
        </p>
      ) : (
        <p className="settings-page__section-hint">
          Bing Webmaster → gear (Settings) → API access → API Key → Generate, then paste it here. Add the site first with “Import from Google Search Console” if it isn’t there yet.
        </p>
      )}
      <div className="toolbar-row bee-key-row">
        <input type="password" autoComplete="off" placeholder={bing?.connected ? 'Paste a new key to replace' : 'Bing API key'} value={bingKey} onChange={(e) => setBingKey(e.target.value)} />
        <button className="btn btn--sm" onClick={() => saveBing(bingKey)} disabled={!bingKey.trim() || busy === 'bing'}>
          {busy === 'bing' ? 'Checking…' : 'Save Key'}
        </button>
      </div>
      {(msg.bing || bing?.lastError) && <p className="settings-page__section-hint">{msg.bing ?? bing?.lastError}</p>}

      <h3 className="settings-page__field-label">Microsoft Clarity</h3>
      {clarity?.connected ? (
        <p>
          Connected
          {clarity.lastSyncAt && <span className="settings-page__section-hint"> · last snapshot {new Date(clarity.lastSyncAt).toLocaleString()}</span>}{' '}
          <button className="btn btn--ghost btn--sm" onClick={() => saveClarity(null)} disabled={busy === 'clarity'}>
            Disconnect
          </button>
        </p>
      ) : (
        <p className="settings-page__section-hint">
          Clarity → your thebedfordbee.com project → Settings → Data Export → Generate new API token (needs project admin), then paste it here. Clarity’s API only covers the last day, so MikeOS saves a snapshot
          nightly.
        </p>
      )}
      <div className="toolbar-row bee-key-row">
        <input type="password" autoComplete="off" placeholder={clarity?.connected ? 'Paste a new token to replace' : 'Clarity API token'} value={clarityToken} onChange={(e) => setClarityToken(e.target.value)} />
        <button className="btn btn--sm" onClick={() => saveClarity(clarityToken)} disabled={!clarityToken.trim() || busy === 'clarity'}>
          {busy === 'clarity' ? 'Checking…' : 'Save Token'}
        </button>
      </div>
      {(msg.clarity || clarity?.lastError) && <p className="settings-page__section-hint">{msg.clarity ?? clarity?.lastError}</p>}
    </>
  );
}
