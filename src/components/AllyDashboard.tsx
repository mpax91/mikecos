import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AllyDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { CashPlacementDetail } from './CashPlacementCard';
import type { LineSeries } from './FinanceLineChart';

// Same validated pair as the 529 / ADT dashboards (dataviz validator: CVD ΔE 20).
// Color follows the account: Savings blue, Checking orange.
const SAVINGS_COLOR = '#2A6FB0';
const CHECKING_COLOR = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso.length === 7 ? `${iso}-15` : iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`);
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

type Range = '1Y' | '3Y' | 'All';
const RANGE_MONTHS: Record<Range, number | null> = { '1Y': 12, '3Y': 36, All: null };

/** Ally Bank — checking + savings on one combined monthly statement: what's
 * there now, how balances moved, what the savings rate earned, where money
 * goes each month, and every statement with its math. */
export function AllyDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const [range, setRange] = useState<Range>('3Y');
  const [acctFilter, setAcctFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [txnLimit, setTxnLimit] = useState(40);
  const [showAllStmts, setShowAllStmts] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const year = Number((s.asOf ?? new Date().toISOString()).slice(0, 4));
  const accounts = s.accounts;
  const label = (last4: string | null) => {
    const a = accounts.find((x) => x.last4 === last4);
    return a ? `${a.label} ••${a.last4}` : last4 ? `••${last4}` : '—';
  };
  const colorOf = (last4: string) => (accounts.find((a) => a.last4 === last4)?.kind === 'checking' ? CHECKING_COLOR : SAVINGS_COLOR);

  const balanceSeries = useMemo<LineSeries[]>(() => {
    const months = RANGE_MONTHS[range];
    const pts = months ? s.series.slice(-months - 1) : s.series;
    return accounts.map((a) => ({
      name: `${a.label} ••${a.last4}`,
      color: colorOf(a.last4),
      points: pts.filter((p) => p.balances[a.last4] !== undefined).map((p) => ({ x: toMs(p.date), y: p.balances[a.last4] })),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.series, accounts, range]);

  const apySeries = useMemo<LineSeries[]>(() => {
    const months = RANGE_MONTHS[range];
    const cutoff = months && s.series.length > months ? s.series[s.series.length - months - 1].date : '';
    const ids = [...new Set(s.apy.map((p) => p.last4))];
    return ids.map((id) => ({ name: `APY Earned · ${label(id)}`, color: SAVINGS_COLOR, points: s.apy.filter((p) => p.last4 === id && p.date >= cutoff).map((p) => ({ x: toMs(p.date), y: p.apy })) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.apy, s.series, range]);

  const maxInterest = Math.max(1, ...s.interestYears.map((y) => y.total));
  const maxFlow = Math.max(1, ...s.flows.map((f) => Math.max(f.moneyIn, f.moneyOut)));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const stmtsDesc = [...statements].reverse();
  const stmtsShown = showAllStmts ? stmtsDesc : stmtsDesc.slice(0, 12);
  const ytdInterest = accounts.reduce((t, a) => t + a.interestYtd, 0);

  const q = query.trim().toLowerCase();
  const txns = [...data.transactions]
    .reverse()
    .filter((t) => (acctFilter === 'all' || t.account === acctFilter) && (!q || t.description.toLowerCase().includes(q) || money(t.amount).includes(q)));

  return (
    <div className="fin-dash ally">
      {data.flags.length > 0 && (
        <div className="fin-dash__flags">
          {data.flags.map((f) => (
            <div key={f.id} className={`fin-dash__flag fin-dash__flag--${f.severity}`}>
              <span className="fin-dash__flag-icon">{f.severity === 'warn' ? '⚠' : 'ℹ'}</span>
              <span className="fin-dash__flag-msg">{f.message}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDismissFlag(f.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="fin-dash__stats">
        <Stat label="Total Balance" value={money(s.total)} sub={s.asOf ? `As of ${fmtDate(s.asOf)}` : undefined} />
        {accounts
          .filter((a) => a.open)
          .slice(0, 2)
          .map((a) => (
            <Stat key={a.last4} label={`${a.label} ••${a.last4}`} value={money(a.balance)} sub={`${pct(a.apy)} APY earned${a.product ? ` · ${a.product}` : ''}`} swatch={colorOf(a.last4)} />
          ))}
        <Stat label={`Interest ${year}`} value={money(ytdInterest)} sub={`${money(s.interestLifetime, false)} since ${s.firstStatement ? s.firstStatement.slice(0, 4) : '—'}`} />
      </div>

      <div className="ally__range" role="tablist" aria-label="Chart range">
        {(Object.keys(RANGE_MONTHS) as Range[]).map((r) => (
          <button key={r} type="button" role="tab" aria-selected={range === r} className={`btn btn--sm${range === r ? ' is-active' : ' btn--ghost'}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Balances Over Time</h3>
          <FinanceLineChart series={balanceSeries} formatY={(v) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`)} formatX={fmtShort} ariaLabel="Ally checking and savings ending balance on each statement" />
          <p className="fin-dash__note">Ending balance on each monthly statement (the 25th).</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Interest by Year</h3>
          <div className="fin-dash__years">
            {[...s.interestYears].reverse().map((y) => (
              <div
                key={y.year}
                className="fin-dash__year"
                title={`${y.year}: ${money(y.total)} — ${Object.entries(y.byAccount)
                  .map(([k, v]) => `${label(k)} ${money(v)}`)
                  .join(', ')}${y.statements < 12 ? ` (${y.statements} statements)` : ''}`}
              >
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.total / maxInterest) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.total, false)}</span>
                <span className="fin-dash__year-bills">{y.statements < 12 ? 'YTD' : ''}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__note">Interest paid by statement year — what Ally reports on the 1099-INT. Hover a year for the split by account.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Savings APY Earned</h3>
          <FinanceLineChart series={apySeries} formatY={(v) => `${v.toFixed(2)}%`} formatX={fmtShort} ariaLabel="Ally savings annual percentage yield earned on each statement" />
          <p className="fin-dash__note">Annual Percentage Yield Earned as printed on each statement (a mid-month rate change shows as an in-between value). Checking’s rate depends on balance tier, so it isn’t charted.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Recurring Payments</h3>
          {s.recurring.length ? (
            <ul className="ally__recurring">
              {s.recurring.map((r) => (
                <li key={`${r.account}|${r.payee}`}>
                  <span className="ally__recurring-day">{ordinal(r.typicalDay)}</span>
                  <span className="ally__recurring-name">
                    {r.payee}
                    <span className="fin-dash__muted"> · {label(r.account)}</span>
                  </span>
                  <span className="ally__recurring-amt" title={`Last paid ${fmtDate(r.lastDate)} · in ${r.months} of the last 6 statements`}>
                    {money(r.lastAmount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">None detected in the last 6 statements.</p>
          )}
          <p className="fin-dash__note">Payees seen in at least 3 of the last 6 statements; amount is the latest payment.</p>
        </section>

        {data.cashPlacement && <CashPlacementDetail bank={data.cashPlacement.bank} suggestions={data.cashPlacement.suggestions} rules={data.cashPlacement.rules} />}

        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Money In &amp; Out</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table ally__flows">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>In</th>
                  <th />
                  <th>Out</th>
                  <th />
                  <th>Interest</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {[...s.flows].reverse().map((f) => (
                  <tr key={f.statementDate}>
                    <td>{fmtMonth(f.statementDate)}</td>
                    <td>{money(f.moneyIn, false)}</td>
                    <td className="ally__flow-cell">
                      <span className="ally__flow-bar ally__flow-bar--in" style={{ width: `${(f.moneyIn / maxFlow) * 100}%` }} />
                    </td>
                    <td>{money(f.moneyOut, false)}</td>
                    <td className="ally__flow-cell">
                      <span className="ally__flow-bar ally__flow-bar--out" style={{ width: `${(f.moneyOut / maxFlow) * 100}%` }} />
                    </td>
                    <td>{money(f.interest)}</td>
                    <td className={f.net < 0 ? 'fin-dash__neg' : undefined}>{`${f.net >= 0 ? '+' : ''}${money(f.net, false)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">Both accounts together, per statement period. Transfers between Checking and Savings (and overdraft protection) are left out; transfers to or from other banks count.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Transactions</h3>
            <div className="ally__txn-tools">
              <select value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)} aria-label="Account">
                <option value="all">All Accounts</option>
                {accounts.map((a) => (
                  <option key={a.last4} value={a.last4}>
                    {a.label} ••{a.last4}
                  </option>
                ))}
              </select>
              <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search transactions" />
            </div>
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Description</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.slice(0, txnLimit).map((t, i) => (
                  <tr key={`${t.date}-${i}`}>
                    <td>{fmtDate(t.date)}</td>
                    <td>{label(t.account)}</td>
                    <td className="ally__desc">{t.description}</td>
                    <td className={`ally__amt${t.amount < 0 ? ' fin-dash__neg' : ''}`}>{money(t.amount)}</td>
                  </tr>
                ))}
                {txns.length === 0 && (
                  <tr>
                    <td colSpan={4} className="fin-dash__muted">
                      No matching transactions.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">
            {txns.length} transaction{txns.length === 1 ? '' : 's'}
            {data.transactionsSince ? ` since ${fmtDate(data.transactionsSince)}` : ''} (older ones are in each statement PDF)
            {txns.length > txnLimit && (
              <>
                {' · '}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTxnLimit((n) => n + 100)}>
                  Show More
                </button>
              </>
            )}
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Statements</h3>
            {stmtsDesc.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAllStmts((v) => !v)}>
                {showAllStmts ? 'Show Recent' : `Show All ${stmtsDesc.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Statement</th>
                  {accounts.map((a) => (
                    <th key={a.last4}>
                      {a.label} ••{a.last4}
                    </th>
                  ))}
                  <th>Total</th>
                  <th>Interest</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stmtsShown.map((st) => {
                  const failed = st.checks.filter((c) => !c.ok);
                  const url = fileUrl(st.fileId);
                  return (
                    <tr key={st.id}>
                      <td>{fmtDate(st.periodEnd)}</td>
                      {accounts.map((a) => {
                        const v = st.accounts.find((x) => x.last4 === a.last4);
                        return <td key={a.last4}>{v ? money(v.ending) : '—'}</td>;
                      })}
                      <td>{money(st.accounts.reduce((t, a) => t + a.ending, 0))}</td>
                      <td>{money(st.accounts.reduce((t, a) => t + a.interest, 0))}</td>
                      <td title={st.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')} className={failed.length ? 'fin-dash__neg' : undefined}>
                        {failed.length ? `✕ ${failed.length} failed` : `✓ ${st.checks.length}/${st.checks.length}`}
                      </td>
                      <td>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer">
                            PDF ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">
            {statements.length} statement{statements.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
            {s.gaps.length > 0 && ` · ${s.gaps.length} month${s.gaps.length === 1 ? '' : 's'} missing`}
            {s.nextExpected && ` · next statement around ${fmtDate(s.nextExpected)}`}
            {data.folder.folderUrl && (
              <>
                {' · '}
                <a href={data.folder.folderUrl} target="_blank" rel="noreferrer">
                  Drive Folder ↗
                </a>
              </>
            )}
            {data.folder.vaultEntryId && (
              <>
                {' · '}
                <Link to={`/vault/${data.folder.vaultEntryId}`}>Vault Note</Link>
              </>
            )}
            {data.template?.site && (
              <>
                {' · '}
                <a href={data.template.site} target="_blank" rel="noreferrer">
                  ally.com ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, swatch }: { label: string; value: string; sub?: string; swatch?: string }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">
        {swatch && <span className="ally__swatch" style={{ background: swatch }} aria-hidden="true" />}
        {label}
      </span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className="fin-dash__stat-sub">{sub}</span>}
    </div>
  );
}
