import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { BeeMerch } from '../../api/types';
import { apiError } from '../../components/BeeMicrosoftSections';

/** Settings → Bedford Bee → Merch Store: the Fourthwall Open API user
 * (stored encrypted; never shown again). Saving checks it against the shop
 * and pulls every order right away; after that MikeOS checks hourly. */
export function FourthwallSettings() {
  const [conn, setConn] = useState<BeeMerch['connection'] | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    api
      .getBeeMerch()
      .then((r) => setConn(r.connection))
      .catch(() => {});
  };
  useEffect(load, []);

  async function save(creds: { username: string; password: string } | null) {
    setBusy(true);
    try {
      const r = await api.setBeeFourthwall(creds);
      setMsg(creds ? `Connected to ${r.shop ?? 'the shop'} — every order has been pulled. See Bee → Merch.` : 'Disconnected — orders already pulled are kept.');
      setUsername('');
      setPassword('');
      load();
    } catch (e) {
      setMsg(apiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setBusy(true);
    try {
      const r = await api.syncBeeMerch(true);
      setMsg(`Synced — ${r.orders} order${r.orders === 1 ? '' : 's'} read.`);
      load();
    } catch (e) {
      setMsg(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 className="settings-page__field-label">Merch Store (Fourthwall)</h3>
      {conn?.connected ? (
        <p>
          {conn.shop ?? 'Connected'}
          {conn.lastSyncAt && <span className="settings-page__section-hint"> · last synced {new Date(conn.lastSyncAt).toLocaleString()}</span>}{' '}
          <button className="btn btn--ghost btn--sm" onClick={sync} disabled={busy}>
            Sync Now
          </button>{' '}
          <button className="btn btn--ghost btn--sm" onClick={() => save(null)} disabled={busy}>
            Disconnect
          </button>
        </p>
      ) : (
        <p className="settings-page__section-hint">
          Fourthwall → Settings → For Developers → Open API → Create API User (needs the Super Admin role), then paste the username and password here. MikeOS reads orders only — new ones every hour,
          with items, costs and buyers. Buyers land in Contacts with a “Merch” label. An orders export (CSV) dropped in the Drive folder works too, without products or costs.{' '}
          <Link to="/bee?tab=merch">Merch dashboard</Link>
        </p>
      )}
      <div className="toolbar-row bee-key-row">
        <input autoComplete="off" placeholder={conn?.connected ? 'New API username' : 'API username'} value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" autoComplete="new-password" placeholder="API password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn--sm" onClick={() => save({ username: username.trim(), password: password.trim() })} disabled={!username.trim() || !password.trim() || busy}>
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      {(msg || conn?.lastError) && <p className="settings-page__section-hint">{msg ?? conn?.lastError}</p>}
    </>
  );
}
