import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import type { CloudAccount } from '../api/types';

/** Option C from the "Cloud Storage Meters" design canvas: a stat strip
 * (Total Used / Total Capacity / Free / Needs Attention) over one meter row
 * per account, fullest first. Rows are the way into browsing an account
 * (they replace the old tiles). Quota comes from GET /api/cloud/accounts,
 * which refreshes stale figures at most hourly. */

const ALMOST_FULL = 0.9;

/** Each provider's real product icon, loaded from the provider's own CDN
 * (Google's Drive icon, Microsoft's Fluent OneDrive icon) or, for the rest,
 * their favicon via Google's favicon service — nothing bundled. Falls back
 * to a letter badge if the image fails to load. Drive and OneDrive need the
 * direct URLs: their domains' favicons are the generic Google "G" and the
 * Microsoft logo. */
const PROVIDER_ICON_URL: Record<string, string> = {
  google_drive: 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
  onedrive: 'https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/onedrive_48x1.svg',
  dropbox: 'https://www.google.com/s2/favicons?domain=dropbox.com&sz=64',
  box: 'https://www.google.com/s2/favicons?domain=box.com&sz=64',
};

function ProviderIcon({ acct }: { acct: CloudAccount }) {
  const [failed, setFailed] = useState(false);
  const src = PROVIDER_ICON_URL[acct.provider];
  if (!src || failed) return <span className="cloud-meters__badge">{acct.providerLabel.charAt(0)}</span>;
  return (
    <span className="cloud-meters__badge cloud-meters__badge--icon">
      <img src={src} alt={acct.providerLabel} width={22} height={22} style={{ objectFit: 'contain' }} onError={() => setFailed(true)} />
    </span>
  );
}

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

function fractionOf(acct: CloudAccount): number | null {
  if (!acct.quota || !acct.quota.totalBytes) return null;
  return Math.min(1, acct.quota.usedBytes / acct.quota.totalBytes);
}

function percentLabel(frac: number): string {
  const pct = frac * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

export function CloudStorageMeters({ accounts, onOpen }: { accounts: CloudAccount[]; onOpen: (acct: CloudAccount) => void }) {
  let used = 0;
  let capacity = 0;
  let capacityUsed = 0; // used bytes on accounts that report a ceiling, so Free isn't skewed by unlimited plans
  let unlimited = false;
  for (const a of accounts) {
    if (!a.quota) continue;
    used += a.quota.usedBytes;
    if (a.quota.totalBytes) {
      capacity += a.quota.totalBytes;
      capacityUsed += a.quota.usedBytes;
    } else {
      unlimited = true;
    }
  }
  const needsAttention = accounts.filter((a) => a.status === 'error' || (fractionOf(a) ?? 0) >= ALMOST_FULL).length;

  // Broken connections first (they need action), then fullest first.
  const rows = [...accounts].sort((a, b) => {
    if ((a.status === 'error') !== (b.status === 'error')) return a.status === 'error' ? -1 : 1;
    return (fractionOf(b) ?? -1) - (fractionOf(a) ?? -1);
  });

  return (
    <section className="cloud-meters">
      <div className="cloud-meters__stats">
        <div className="cloud-meters__stat">
          <span className="cloud-meters__stat-label">Total Used</span>
          <span className="cloud-meters__stat-value heading-serif">{formatBytes(used)}</span>
        </div>
        <div className="cloud-meters__stat">
          <span className="cloud-meters__stat-label">Total Capacity</span>
          <span className="cloud-meters__stat-value heading-serif">
            {capacity ? formatBytes(capacity) : '—'}
            {unlimited && capacity ? '+' : ''}
          </span>
        </div>
        <div className="cloud-meters__stat">
          <span className="cloud-meters__stat-label">Free</span>
          <span className="cloud-meters__stat-value heading-serif">{capacity ? formatBytes(Math.max(0, capacity - capacityUsed)) : '—'}</span>
        </div>
        <div className="cloud-meters__stat">
          <span className="cloud-meters__stat-label">Needs Attention</span>
          <span className={`cloud-meters__stat-value heading-serif${needsAttention ? ' cloud-meters__warn' : ''}`}>
            {needsAttention === 0 ? 'None' : `${needsAttention} ${needsAttention === 1 ? 'Account' : 'Accounts'}`}
          </span>
        </div>
      </div>

      <div className="cloud-meters__rows">
        {rows.map((acct) => {
          const frac = fractionOf(acct);
          const full = frac !== null && frac >= ALMOST_FULL;
          const style = { '--cloud-tile-color': full ? '#b45309' : acct.color } as React.CSSProperties;
          const badge = <ProviderIcon acct={acct} />;
          const name = (
            <span className="cloud-meters__name">
              <span className="cloud-meters__label">{acct.label}</span>
              <span className="cloud-meters__provider">
                {acct.providerLabel}
                {acct.accountEmail ? ` · ${acct.accountEmail}` : ''}
              </span>
            </span>
          );
          if (acct.status === 'error') {
            // A broken connection can't be browsed — the whole row goes to Settings to reconnect.
            return (
              <Link key={acct.id} to="/settings?cat=cloud" className="cloud-meters__row cloud-meters__row--warn" style={style}>
                {badge}
                {name}
                <span className="cloud-meters__error">⚠ Connection lost — reconnect in Settings</span>
              </Link>
            );
          }
          return (
            <button
              type="button"
              key={acct.id}
              className={`cloud-meters__row${full ? ' cloud-meters__row--warn' : ''}`}
              style={style}
              onClick={() => onOpen(acct)}
              title={`Browse ${acct.providerLabel} · ${acct.label}`}
            >
              {badge}
              {name}
              <span className="cloud-meters__bar">
                {frac !== null && <span className="cloud-meters__fill" style={{ width: `${Math.max(frac * 100, 0.6)}%` }} />}
              </span>
              <span className="cloud-meters__amount">
                {acct.quota ? `${formatBytes(acct.quota.usedBytes)}${acct.quota.totalBytes ? ` of ${formatBytes(acct.quota.totalBytes)}` : ' used'}` : '—'}
              </span>
              <span className={`cloud-meters__pct${full ? ' cloud-meters__warn' : ''}`}>{frac !== null ? percentLabel(frac) : ''}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
