import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AmexBankDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { CashPlacementDetail } from './CashPlacementCard';
import type { LineSeries } from './FinanceLineChart';

// Same validated blue as the other savings dashboards (dataviz validator).
const SAVINGS_COLOR = '#2A6FB0';

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

type Range = '1Y' | '3Y' | 'All';
const RANGE_MONTHS: Record<Range, number | null> = { '1Y': 12, '3Y': 36, All: null };
type TypeFilter = 'all' | 'in' | 'out' | 'interest';

/** American Express High Yield Savings — one account: balance and rate
 * now, how both moved, interest by tax year, where money came from and
 * went, and every statement with its math. */
export function AmexBankDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const [range, setRange] = useState<Range>('3Y');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');
  const [txnLimit, setTxnLimit] = useState(40);
  const [showAllStmts, setShowAllStmts] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const year = Number((s.asOf ?? new Date().toISOString()).slice(0, 4));
  const cutoff = (dates: string[]) => {
    const months = RANGE_MONTHS[range];
    return months && dates.length > months ? dates[dates.length - months - 1] : '';
  };

  const balanceSeries = useMemo<LineSeries[]>(() => {
    const from = cutoff(s.series.map((p) => p.date));
    return [{ name: s.label, color: SAVINGS_COLOR, points: s.series.filter((p) => p.date >= from).map((p) => ({ x: toMs(p.date), y: p.balance })) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.series, range]);

  const apySeries = useMemo<LineSeries[]>(() => {
    const from = cutoff(s.series.map((p) => p.date));
    return [{ name: 'APY', color: SAVINGS_COLOR, points: s.apyPoints.filter((p) => p.date >= from).map((p) => ({ x: toMs(p.date), y: p.apy })) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.apyPoints, s.series, range]);

  const lastChange = s.rateChanges[s.rateChanges.length - 1] ?? null;
  const maxInterest = Math.max(1, ...s.interestYears.map((y) => y.total));
  const maxFlow = Math.max(1, ...s.flows.map((f) => Math.max(f.moneyIn, f.moneyOut)));
  const maxCp = Math.max(1, ...s.counterparties.map((c) => Math.max(c.moneyIn, c.moneyOut)));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const stmtsDesc = [...statements].reverse();
  const stmtsShown = showAllStmts ? stmtsDesc : stmtsDesc.slice(0, 12);

  const q = query.trim().toLowerCase();
  const txns = [...data.transactions]
    .reverse()
    .filter(
      (t) =>
        (typeFilter === 'all' || (typeFilter === 'interest' ? t.kind === 'interest' : typeFilter === 'in' ? t.amount >= 0 && t.kind !== 'interest' : t.amount < 0)) &&
        (!q || t.description.toLowerCase().includes(q) || money(t.amount).includes(q))
    );

  return (
    <div className="fin-dash ally amex-bank">
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
        <Stat label={s.label} value={money(s.balance)} sub={s.asOf ? `As of ${fmtDate(s.asOf)}` : undefined} swatch={SAVINGS_COLOR} />
        <Stat label="APY" value={pct(s.apy)} sub={s.rate !== null ? `Interest rate ${s.rate.toFixed(3)}%` : 'APY earned this period'} />
        <Stat label={`Interest ${year}`} value={money(s.interestYtd)} sub={`${money(s.interestLifetime, false)} since ${s.firstStatement ? s.firstStatement.slice(0, 4) : '—'}`} />
        <Stat label="Last Rate Change" value={lastChange ? `${lastChange.to >= lastChange.from ? '+' : '−'}${Math.abs(lastChange.to - lastChange.from).toFixed(2)} pts` : '—'} sub={lastChange ? `${pct(lastChange.from)} → ${pct(lastChange.to)} · ${fmtMonth(lastChange.date)}` : undefined} />
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
          <h3 className="fin-dash__card-title">Balance Over Time</h3>
          <FinanceLineChart series={balanceSeries} formatY={(v) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`)} formatX={fmtShort} ariaLabel="American Express savings ending balance on each statement" />
          <p className="fin-dash__note">Ending balance on each monthly statement (the 10th).</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Interest by Year</h3>
          <div className="fin-dash__years">
            {[...s.interestYears].reverse().map((y) => (
              <div key={y.year} className="fin-dash__year" title={`${y.year}: ${money(y.total)} over ${y.statements} statement${y.statements === 1 ? '' : 's'}`}>
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.total / maxInterest) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.total, false)}</span>
                <span className="fin-dash__year-bills">{y.december ? '' : y.year === year ? 'YTD' : 'Partial'}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__note">Interest is credited on the statement date, so this is what the 1099-INT reports. 2011–2012 statements are image-only scans and aren’t counted.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">APY Over Time</h3>
          <FinanceLineChart series={apySeries} formatY={(v) => `${v.toFixed(2)}%`} formatX={fmtShort} ariaLabel="American Express savings APY on each statement" />
          <p className="fin-dash__note">The APY in effect on each statement date (before 2016, the APY earned for the period).</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Rate Changes</h3>
          {s.rateChanges.length ? (
            <ul className="ally__recurring">
              {[...s.rateChanges]
                .reverse()
                .slice(0, 8)
                .map((c) => (
                  <li key={c.date}>
                    <span className="ally__recurring-day amazon__date">{fmtMonth(c.date)}</span>
                    <span className="ally__recurring-name">
                      {pct(c.from)} → {pct(c.to)}
                    </span>
                    <span className={`ally__recurring-amt${c.to < c.from ? ' fin-dash__neg' : ''}`}>{`${c.to >= c.from ? '+' : ''}${(c.to - c.from).toFixed(2)}`}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No rate changes yet.</p>
          )}
          <p className="fin-dash__note">Most recent first; change in percentage points.</p>
        </section>

        {data.cashPlacement && <CashPlacementDetail bank={data.cashPlacement.bank} suggestions={data.cashPlacement.suggestions} rules={data.cashPlacement.rules} savingsOnly={{ label: s.label, apy: s.apy }} />}

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
          <p className="fin-dash__note">Per statement period, last 13 statements. Interest is shown on its own.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Where Money Comes From &amp; Goes</h3>
          {s.counterparties.length ? (
            <div className="fin-dash__table-wrap">
              <table className="fin-dash__table ally__flows">
                <thead>
                  <tr>
                    <th>Counterparty</th>
                    <th>In</th>
                    <th />
                    <th>Out</th>
                    <th />
                    <th>Items</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {s.counterparties.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td>{c.moneyIn ? money(c.moneyIn, false) : '—'}</td>
                      <td className="ally__flow-cell">
                        <span className="ally__flow-bar ally__flow-bar--in" style={{ width: `${(c.moneyIn / maxCp) * 100}%` }} />
                      </td>
                      <td>{c.moneyOut ? money(c.moneyOut, false) : '—'}</td>
                      <td className="ally__flow-cell">
                        <span className="ally__flow-bar ally__flow-bar--out" style={{ width: `${(c.moneyOut / maxCp) * 100}%` }} />
                      </td>
                      <td>{c.count}</td>
                      <td>{fmtDate(c.lastDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="fin-dash__muted">No deposits or withdrawals in the last 24 statements.</p>
          )}
          <p className="fin-dash__note">Last 24 statements, grouped by the name on the ACH line; top 12 by money moved.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Transactions</h3>
            <div className="ally__txn-tools">
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} aria-label="Type">
                <option value="all">All Types</option>
                <option value="in">Deposits</option>
                <option value="out">Withdrawals</option>
                <option value="interest">Interest</option>
              </select>
              <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search transactions" />
            </div>
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.slice(0, txnLimit).map((t, i) => (
                  <tr key={`${t.date}-${i}`}>
                    <td>{fmtDate(t.date)}</td>
                    <td className="ally__desc">{t.description}</td>
                    <td className={`ally__amt${t.amount < 0 ? ' fin-dash__neg' : ''}`}>{money(t.amount)}</td>
                  </tr>
                ))}
                {txns.length === 0 && (
                  <tr>
                    <td colSpan={3} className="fin-dash__muted">
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
                  <th>In</th>
                  <th>Out</th>
                  <th>Interest</th>
                  <th>Balance</th>
                  <th>APY</th>
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
                      <td>{money(st.credits - st.interest)}</td>
                      <td>{money(st.debits)}</td>
                      <td>{money(st.interest)}</td>
                      <td>{money(st.ending)}</td>
                      <td>{pct(st.apy)}</td>
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
                  American Express ↗
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
