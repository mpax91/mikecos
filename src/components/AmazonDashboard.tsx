import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AmazonDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

// Same validated pair as the other Finance dashboards (dataviz validator:
// CVD ΔE 20): spending blue, points orange.
const SPEND_COLOR = '#2A6FB0';
const POINTS_COLOR = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const pts = (n: number) => n.toLocaleString('en-US');
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

type Range = '1Y' | '3Y' | 'All';
const RANGE_MONTHS: Record<Range, number | null> = { '1Y': 12, '3Y': 36, All: null };

const KIND_LABEL: Record<string, string> = {
  purchase: 'Purchase',
  refund: 'Refund',
  payment: 'Payment',
  reward: 'Points Credit',
  adjustment: 'Statement Credit',
  fee: 'Fee',
  interest: 'Interest',
  cash_advance: 'Cash Advance',
};
type KindFilter = 'all' | 'purchase' | 'refund' | 'payment' | 'other';

/** Amazon Prime Visa — what's owed and when, the rewards it has earned,
 * where the money goes, and every statement with its math. */
export function AmazonDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const [range, setRange] = useState<Range>('3Y');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [txnLimit, setTxnLimit] = useState(40);
  const [showAllStmts, setShowAllStmts] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const year = Number((s.asOf ?? new Date().toISOString()).slice(0, 4));
  const latest = s.latest;

  const cut = <T,>(rows: T[]) => {
    const months = RANGE_MONTHS[range];
    return months ? rows.slice(-months) : rows;
  };
  const spendSeries = useMemo<LineSeries[]>(
    () => [{ name: 'Net Spending', color: SPEND_COLOR, points: cut(s.months).map((m) => ({ x: toMs(m.closingDate), y: m.net })) }],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.months, range]
  );
  const pointsSeries = useMemo<LineSeries[]>(
    () => [{ name: 'Points Available', color: POINTS_COLOR, points: cut(s.points).map((p) => ({ x: toMs(p.closingDate), y: p.total })) }],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.points, range]
  );

  const maxYear = Math.max(1, ...s.years.map((y) => y.net));
  const cats = s.categories.filter((c) => c.last12 > 0);
  const maxCat = Math.max(1, ...cats.map((c) => c.last12));
  const maxMerchant = Math.max(1, ...s.topMerchants.map((m) => m.amount));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const rowsDesc = [...s.statements].reverse();
  const rowsShown = showAllStmts ? rowsDesc : rowsDesc.slice(0, 12);
  const checksOf = (closing: string) => statements.find((st) => st.periodEnd === closing)?.checks ?? [];

  const q = query.trim().toLowerCase();
  const txns = [...data.transactions]
    .reverse()
    .filter(
      (t) =>
        (kind === 'all' || (kind === 'other' ? !['purchase', 'refund', 'payment'].includes(t.kind) : t.kind === kind)) &&
        (!q || t.description.toLowerCase().includes(q) || money(t.amount).includes(q))
    );

  const dueSub =
    s.status === 'paid'
      ? 'Nothing due'
      : s.status === 'credit'
        ? 'Credit balance'
        : latest?.dueDate
          ? `Due ${fmtDate(latest.dueDate)} · min ${money(latest.minimumPayment, false)}`
          : undefined;

  return (
    <div className="fin-dash amazon">
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
        <Stat label="Statement Balance" value={money(s.balance)} sub={[dueSub, s.asOf ? `Closed ${fmtDate(s.asOf)}` : null].filter(Boolean).join(' · ')} />
        <Stat
          label="Points Available"
          value={s.pointsBalance !== null ? pts(s.pointsBalance) : '—'}
          sub={s.pointsValue !== null ? `Worth ${money(s.pointsValue)} · ${pts(s.ytdPointsEarned)} earned in ${year}` : undefined}
          swatch={POINTS_COLOR}
        />
        <Stat label={`Spent ${year}`} value={money(s.ytdNet, false)} sub={s.avgMonthlyNet !== null ? [`${money(s.avgMonthlyNet, false)}/mo avg (12 mo)`, s.rewardRate !== null ? `${s.rewardRate.toFixed(1)}% back` : null].filter(Boolean).join(' · ') : undefined} swatch={SPEND_COLOR} />
        <Stat
          label="Credit Used"
          value={s.utilization !== null ? `${s.utilization.toFixed(1)}%` : '—'}
          sub={s.creditLine !== null ? `of ${money(s.creditLine, false)} · ${s.paidInFullStreak} statement${s.paidInFullStreak === 1 ? '' : 's'} paid in full` : undefined}
        />
      </div>

      {data.payTask && data.payTask.status !== 'done' && (
        <p className="amazon__task">
          📅 Task: <strong>{data.payTask.title}</strong>
          {data.payTask.due ? ` — on your Calendar for ${fmtDate(data.payTask.due)}` : ''}
        </p>
      )}

      <div className="ally__range" role="tablist" aria-label="Chart range">
        {(Object.keys(RANGE_MONTHS) as Range[]).map((r) => (
          <button key={r} type="button" role="tab" aria-selected={range === r} className={`btn btn--sm${range === r ? ' is-active' : ' btn--ghost'}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Spending by Statement</h3>
          <FinanceLineChart series={spendSeries} yFromZero formatY={(v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`)} formatX={fmtShort} ariaLabel="Net spending (purchases minus refunds) on each monthly statement" />
          <p className="fin-dash__note">Purchases minus refunds on each monthly statement (closing on the 17th). Paid in full every month, so this is also roughly each statement’s balance.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Spend by Year</h3>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <div
                key={y.year}
                className="fin-dash__year"
                title={`${y.year}: ${money(y.purchases)} purchases − ${money(y.refunds)} refunds = ${money(y.net)} · ${money(y.amazon)} at Amazon · ${pts(y.pointsEarned)} points${y.fees ? ` · ${money(y.fees)} fees` : ''}${y.interest ? ` · ${money(y.interest)} interest` : ''}`}
              >
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.net / maxYear) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.net, false)}</span>
                <span className="fin-dash__year-bills">{y.year === year && y.statements < 12 ? 'YTD' : y.statements < 12 && y === s.years[0] ? 'Part' : ''}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__note">
            Net spending by statement year. {money(s.lifetimeNet, false)} since {s.firstStatement ? s.firstStatement.slice(0, 4) : '—'}; {s.last12Net > 0 ? `${Math.round((s.last12Amazon / s.last12Net) * 100)}% at Amazon in the last 12 months` : ''}. Hover a year for details.
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Rewards Points</h3>
          <FinanceLineChart series={pointsSeries} yFromZero formatY={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`)} formatX={fmtShort} ariaLabel="Rewards points available after each statement" />
          <p className="fin-dash__note">
            Points available after each statement (100 points = $1). {pts(s.lifetimePointsEarned)} earned all-time ({money(s.lifetimePointsEarned / 100, false)}); redeemed {pts(s.lifetimePointsRedeemed)}
            {s.rewardCredits > 0 ? ` — ${money(s.rewardCredits, false)} as statement credits` : ''}
            {s.shopWithPoints > 0 ? `, ${money(s.shopWithPoints, false)} at Amazon checkout` : ''}.
          </p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Points by Category</h3>
          {cats.length ? (
            <div className="fin-dash__years">
              {cats.map((c) => (
                <div key={c.category} className="fin-dash__year amazon__cat" title={`${c.category}: ${pts(c.last12)} points (${money(c.last12 / 100)}) in the last 12 statements · ${pts(c.points)} all-time`}>
                  <span className="fin-dash__year-label">{c.category}</span>
                  <span className="fin-dash__year-track">
                    <span className="fin-dash__year-bar amazon__cat-bar" style={{ width: `${(c.last12 / maxCat) * 100}%` }} />
                  </span>
                  <span className="fin-dash__year-value">{money(c.last12 / 100, false)}</span>
                  <span className="fin-dash__year-bills" />
                </div>
              ))}
            </div>
          ) : (
            <p className="fin-dash__muted">No points earned in the last 12 statements.</p>
          )}
          <p className="fin-dash__note">Cash value of points earned in the last 12 statements{s.rewardRate !== null ? ` — ${s.rewardRate.toFixed(2)}% back on ${money(s.last12Net, false)} of spending` : ''}.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Top Merchants (12 Mo)</h3>
          <div className="fin-dash__years">
            {s.topMerchants.map((m) => (
              <div key={m.merchant} className="fin-dash__year amazon__cat" title={`${m.merchant}: ${money(m.amount)} net · ${m.count} purchase${m.count === 1 ? '' : 's'}`}>
                <span className="fin-dash__year-label">{m.merchant}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${(m.amount / maxMerchant) * 100}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(m.amount, false)}</span>
                <span className="fin-dash__year-bills" />
              </div>
            ))}
          </div>
          <p className="fin-dash__note">Net of refunds. Amazon includes Marketplace and Whole Foods is listed on its own.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Fees &amp; Interest</h3>
          {s.charges.length ? (
            <ul className="ally__recurring">
              {[...s.charges].reverse().map((c, i) => (
                <li key={`${c.date}-${i}`}>
                  <span className="ally__recurring-day amazon__date">{fmtDate(c.date)}</span>
                  <span className="ally__recurring-name">{c.kind === 'credit' ? 'Statement Credit' : titleCase(c.description)}</span>
                  <span className={`ally__recurring-amt${c.amount < 0 ? ' fin-dash__neg' : ''}`}>{money(c.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">Never charged a fee or interest.</p>
          )}
          <p className="fin-dash__note">
            All-time {money(s.totalFees, false)} in fees and {money(s.totalInterest)} in interest
            {s.purchaseApr !== null ? ` · purchase APR ${s.purchaseApr}% (variable)` : ''}.
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Transactions</h3>
            <div className="ally__txn-tools">
              <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="Type">
                <option value="all">All Types</option>
                <option value="purchase">Purchases</option>
                <option value="refund">Refunds</option>
                <option value="payment">Payments</option>
                <option value="other">Credits, Fees &amp; Interest</option>
              </select>
              <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search transactions" />
            </div>
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.slice(0, txnLimit).map((t, i) => (
                  <tr key={`${t.date}-${i}`}>
                    <td>{fmtDate(t.date)}</td>
                    <td>{KIND_LABEL[t.kind] ?? t.kind}</td>
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
            {rowsDesc.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAllStmts((v) => !v)}>
                {showAllStmts ? 'Show Recent' : `Show All ${rowsDesc.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Closing</th>
                  <th>Balance</th>
                  <th>Paid</th>
                  <th>Purchases</th>
                  <th>Credits</th>
                  <th>Points</th>
                  <th>Due</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rowsShown.map((r) => {
                  const checks = checksOf(r.closingDate);
                  const failed = checks.filter((c) => !c.ok);
                  const url = fileUrl(r.fileId);
                  return (
                    <tr key={r.closingDate}>
                      <td>{fmtDate(r.closingDate)}</td>
                      <td>{money(r.newBalance)}</td>
                      <td title={r.carried > 0 ? `${money(r.carried)} of the previous balance carried over` : 'Previous balance paid in full'} className={r.carried > 0 ? 'fin-dash__neg' : undefined}>
                        {money(r.paid)}
                      </td>
                      <td>{money(r.purchases)}</td>
                      <td>{r.credits ? money(-r.credits) : '—'}</td>
                      <td>{r.pointsEarned !== null ? `${r.pointsEarned < 0 ? '−' : '+'}${pts(Math.abs(r.pointsEarned))}` : '—'}</td>
                      <td>{r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                      <td title={checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')} className={failed.length ? 'fin-dash__neg' : undefined}>
                        {failed.length ? `✕ ${failed.length} failed` : `✓ ${checks.length}/${checks.length}`}
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
            {s.nextStatementExpected && ` · next statement closes around ${fmtDate(s.nextStatementExpected)}`}
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
                  chase.com ↗
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
