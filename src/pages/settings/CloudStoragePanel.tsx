import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { CloudAccount, CloudProviderInfo } from '../../api/types';
import { ConfirmModal } from '../../components/ConfirmModal';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

/** One provider's row — its connected account(s), each with a quota bar,
 * plus the label-then-connect flow for adding another. A provider whose
 * OAuth app hasn't been registered yet (no client id/secret Worker secrets
 * set) shows as "Not set up yet" instead of a Connect button — see
 * cloudProviders/registry.ts's isConfigured. */
function ProviderRow({
  provider,
  accounts,
  onDisconnect,
}: {
  provider: CloudProviderInfo;
  accounts: CloudAccount[];
  onDisconnect: (account: CloudAccount) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [label, setLabel] = useState('');

  function handleConnect() {
    const trimmed = label.trim() || provider.label;
    api.startCloudConnect(provider.id, trimmed);
  }

  return (
    <div className="cloud-settings__provider">
      <div className="cloud-settings__provider-header">
        <span className="cloud-settings__provider-name">{provider.label}</span>
        {!provider.configured && <span className="cloud-settings__not-configured">Not set up yet</span>}
      </div>

      {accounts.map((acct) => (
        <div key={acct.id} className="cloud-settings__account">
          <div className="cloud-settings__account-main">
            <span className="cloud-settings__account-label">{acct.label}</span>
            {acct.accountEmail && <span className="cloud-settings__account-email">{acct.accountEmail}</span>}
            {acct.status === 'error' && <span className="cloud-settings__account-error">⚠ {acct.lastError || 'Connection error'}</span>}
          </div>
          {acct.quota && (
            <div className="cloud-settings__quota">
              <div className="cloud-settings__quota-bar">
                <div
                  className="cloud-settings__quota-fill"
                  style={{ width: acct.quota.totalBytes ? `${Math.min(100, (acct.quota.usedBytes / acct.quota.totalBytes) * 100)}%` : '0%' }}
                />
              </div>
              <span className="cloud-settings__quota-label">
                {formatBytes(acct.quota.usedBytes)} {acct.quota.totalBytes ? `/ ${formatBytes(acct.quota.totalBytes)}` : 'used'}
              </span>
            </div>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDisconnect(acct)}>
            Disconnect
          </button>
        </div>
      ))}

      {provider.configured &&
        (connecting ? (
          <div className="cloud-settings__connect-form">
            <input
              type="text"
              placeholder={`Label (e.g. "Personal", "Origin Work")`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
            <button type="button" className="btn btn--sm" onClick={handleConnect}>
              Connect
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConnecting(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--sm" onClick={() => setConnecting(true)}>
            {accounts.length > 0 ? `+ Connect another ${provider.label} account` : `Connect ${provider.label}`}
          </button>
        ))}
    </div>
  );
}

export function CloudStoragePanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [providers, setProviders] = useState<CloudProviderInfo[] | null>(null);
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<CloudAccount | null>(null);

  function load() {
    Promise.all([api.listCloudProviders(), api.listCloudAccounts()])
      .then(([p, a]) => {
        setProviders(p);
        setAccounts(a);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  // The OAuth callback redirects back here with ?cloudConnected=1 or
  // ?cloudError=... — surface it once, then strip it so a refresh doesn't
  // keep re-showing a stale banner.
  const connected = searchParams.get('cloudConnected');
  const oauthError = searchParams.get('cloudError');
  useEffect(() => {
    if (!connected && !oauthError) return;
    const next = new URLSearchParams(searchParams);
    next.delete('cloudConnected');
    next.delete('cloudError');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, oauthError]);

  async function handleDisconnect() {
    if (!disconnecting) return;
    await api.disconnectCloudAccount(disconnecting.id);
    setDisconnecting(null);
    load();
  }

  return (
    <div className="settings-page__section">
      <h2 className="settings-page__section-title">Cloud Storage</h2>
      <p className="settings-page__section-hint">
        Connects your real Google Drive, OneDrive, Dropbox, and Box accounts so they show up as one browsable "Cloud"
        section in the sidebar. Read-only for now — MikeOS can browse, open, and download, but never edits or deletes
        anything in your actual cloud storage.
      </p>

      {connected && <div className="bookmarks-import__success">Account connected.</div>}
      {oauthError && <div className="settings-page__rrule-error">{oauthError}</div>}
      {error && <div className="empty-state">Couldn't load Cloud Storage: {error}</div>}

      {providers === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="cloud-settings__providers">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              accounts={accounts.filter((a) => a.provider === provider.id)}
              onDisconnect={setDisconnecting}
            />
          ))}
        </div>
      )}

      {disconnecting && (
        <ConfirmModal
          title={`Disconnect "${disconnecting.label}"?`}
          body={`This removes ${disconnecting.providerLabel} account "${disconnecting.label}" from MikeOS. Nothing in your actual ${disconnecting.providerLabel} is touched — you can always reconnect it.`}
          onConfirm={handleDisconnect}
          onCancel={() => setDisconnecting(null)}
        />
      )}
    </div>
  );
}
