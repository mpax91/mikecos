import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { AccountOwner, FinanceAccount } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Finance — every Live statements account, split by owner. Household is
 * the default view and excludes Chase's accounts; Chase has his own view. */
export function FinancePage() {
  useReportTabMeta('Finance', 'finance');
  const [accounts, setAccounts] = useState<FinanceAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<AccountOwner | null>(null);

  useEffect(() => {
    api
      .listFinanceAccounts()
      .then((a) => {
        setAccounts(a);
        setOwner((cur) => cur ?? (a.some((x) => x.owner === 'household') ? 'household' : a.length ? 'chase' : 'household'));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = (accounts ?? []).filter((a) => a.owner === owner);
  const total = shown.reduce((s, a) => s + (a.headline?.value ?? 0), 0);

  return (
    <div className="finance-page">
      <div className="links-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Finance
        </h1>
        <Link to="/settings?cat=statements" className="settings-gear-link" title="Statements Settings" aria-label="Statements Settings">
          ⚙️
        </Link>
      </div>
      <p className="links-page__subhead">Accounts read from your statement PDFs in Google Drive, refreshed nightly.</p>

      <div className="finance-page__owners" role="tablist">
        {(['household', 'chase'] as AccountOwner[]).map((o) => (
          <button key={o} type="button" role="tab" aria-selected={owner === o} className={`btn btn--sm${owner === o ? ' is-active' : ''}`} onClick={() => setOwner(o)}>
            {o === 'household' ? 'Household' : 'Chase'}
            <span className="finance-page__count">{(accounts ?? []).filter((a) => a.owner === o).length}</span>
          </button>
        ))}
      </div>

      {error && <div className="empty-state">Couldn’t load Finance: {error}</div>}
      {!accounts && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {accounts && shown.length === 0 && (
        <div className="empty-state">
          No {owner === 'chase' ? 'Chase' : 'Household'} accounts are live yet — folders go live one at a time in{' '}
          <Link to="/settings?cat=statements">Settings → Statements</Link>.
        </div>
      )}
      {shown.length > 0 && (
        <div className="cloud-meters">
          <div className="finance-page__total">
            <span className="cloud-meters__stat-label">{owner === 'chase' ? 'Chase’s Accounts' : 'Household Accounts'}</span>
            <span className="cloud-meters__stat-value">{money(total)}</span>
          </div>
          <div className="cloud-meters__rows">
            {shown.map((a) => (
              <Link key={a.id} to={`/finance/${a.id}`} className="finance-page__row">
                <span className="finance-page__row-name">
                  <span className="cloud-meters__label">{a.nickname}</span>
                  <span className="cloud-meters__provider">
                    {a.templateName}
                    {a.headline?.asOf ? ` · As of ${fmtDate(a.headline.asOf)}` : ''}
                  </span>
                </span>
                {a.openFlags > 0 && <span className="finance-page__flags">⚠ {a.openFlags}</span>}
                <span className="finance-page__row-value">{a.headline ? money(a.headline.value) : '—'}</span>
                <span className="finance-page__chev">›</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
