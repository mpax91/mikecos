import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AccountOwner, CashPlacement, FinanceAccount, FinanceAttentionItem, RewardsOverview } from '../api/types';
import { CashPlacementCard } from '../components/CashPlacementCard';
import { FinanceRewardsCard } from '../components/CardRewardsPanel';
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
  const [attention, setAttention] = useState<FinanceAttentionItem[]>([]);
  const [cash, setCash] = useState<CashPlacement | null>(null);
  const [rewards, setRewards] = useState<RewardsOverview | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () =>
      api
        .getFinanceAttention()
        .then((a) => setAttention(a.items))
        .catch(() => {});
    load();
    window.addEventListener('mikeos:attention-changed', load);
    return () => window.removeEventListener('mikeos:attention-changed', load);
  }, []);
  const dismissIssue = (id: string) => {
    setAttention((xs) => xs.filter((x) => x.id !== id));
    api.dismissStatementFlag(id).catch(() => {});
  };

  useEffect(() => {
    api
      .getCashPlacement()
      .then(setCash)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!owner) return;
    setRewards(null);
    api
      .getRewards(owner)
      .then(setRewards)
      .catch(() => {});
  }, [owner]);

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
  // Balances (529, savings) add up; bills (ADT, utilities) don't — they get
  // their own monthly total instead. Credit card balances are owed, so they
  // stay out of the accounts total and get their own "Card Balances" sum.
  const balances = shown.filter((a) => a.headline?.kind !== 'bill' && a.headline?.kind !== 'card');
  const bills = shown.filter((a) => a.headline?.kind === 'bill');
  const cards = shown.filter((a) => a.headline?.kind === 'card');
  const total = balances.reduce((s, a) => s + (a.headline?.value ?? 0), 0);
  const monthlyBills = bills.reduce((s, a) => s + (a.headline?.kind === 'bill' ? (a.headline.monthly ?? 0) : 0), 0);
  const cardTotal = cards.reduce((s, a) => s + Math.max(0, a.headline?.value ?? 0), 0);

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

      {attention.length > 0 && (
        <section className="finance-attention" aria-label="Accounts Need Attention">
          <h2 className="finance-attention__title">
            <span aria-hidden="true">⚠</span> Accounts Need Attention <span className="finance-attention__count">{attention.length}</span>
          </h2>
          <ul className="finance-attention__list">
            {attention.map((a) => (
              <li key={a.id} className="finance-attention__item">
                <button type="button" className="finance-attention__open" onClick={() => navigate(`/finance/${a.folderId}`)}>
                  <span className="finance-attention__account">{a.account}</span>
                  <span className="finance-attention__msg">{a.message}</span>
                  <span className="finance-attention__age">{fmtDate(a.createdAt.slice(0, 10))}</span>
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => dismissIssue(a.id)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
          <div className="finance-page__totals">
            {balances.length > 0 && (
              <div className="finance-page__total">
                <span className="cloud-meters__stat-label">{owner === 'chase' ? 'Chase’s Accounts' : 'Household Accounts'}</span>
                <span className="cloud-meters__stat-value">{money(total)}</span>
              </div>
            )}
            {bills.length > 0 && (
              <div className="finance-page__total">
                <span className="cloud-meters__stat-label">Monthly Bills</span>
                <span className="cloud-meters__stat-value">{money(monthlyBills)}</span>
              </div>
            )}
            {cards.length > 0 && (
              <div className="finance-page__total">
                <span className="cloud-meters__stat-label">Card Balances</span>
                <span className="cloud-meters__stat-value">{money(cardTotal)}</span>
              </div>
            )}
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
                <span className="finance-page__row-value">
                  {a.headline ? money(a.headline.value) : '—'}
                  {a.headline?.kind === 'bill' && (
                    <span className="finance-page__row-sub">
                      {a.headline.status === 'past_due' ? 'Past Due' : a.headline.status === 'autopay' ? 'Autopay' : a.headline.status === 'credit' ? 'Credit' : a.headline.status === 'due' ? 'Due' : 'Latest Bill'}
                      {a.headline.monthly !== null ? ` · ${money(a.headline.monthly)}/mo` : ''}
                    </span>
                  )}
                  {a.headline?.kind === 'card' && (
                    <span className="finance-page__row-sub">
                      {a.headline.status === 'past_due'
                        ? 'Past Due'
                        : a.headline.status === 'paid'
                          ? 'Nothing Due'
                          : a.headline.status === 'credit'
                            ? 'Credit'
                            : a.headline.dueDate
                              ? `Due ${fmtDate(a.headline.dueDate)}`
                              : 'Statement Balance'}
                      {a.headline.pointsValue !== null ? ` · ${money(a.headline.pointsValue)} in rewards` : ''}
                    </span>
                  )}
                  {a.headline?.kind === 'balance' &&
                    a.headline.parts &&
                    a.headline.parts.length > 1 &&
                    a.headline.parts.map((p) => (
                      <span key={p.label} className="finance-page__row-parts">
                        {p.label} {money(p.value)}
                      </span>
                    ))}
                </span>
                <span className="finance-page__chev">›</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <FinanceRewardsCard data={rewards} />
      <CashPlacementCard data={cash} owner={owner} />
    </div>
  );
}
