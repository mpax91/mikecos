import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BofaCardDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { CardRewardsPanel } from './CardRewardsPanel';
import type { LineSeries } from './FinanceLineChart';

// Same validated pair as the other Finance dashboards (dataviz validator:
// CVD ΔE 20): spending blue, cash back orange.
const SPEND_COLOR = '#2A6FB0';
const REWARD_COLOR = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
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
  reward: 'Cash Back Credit',
  adjustment: 'Statement Credit',
  fee: 'Fee',
  interest: 'Interest',
  cash_advance: 'Cash Advance',
};
type KindFilter = 'all' | 'purchase' | 'refund' | 'payment' | 'other';

/** Bank of America Customized Cash Rewards — what's owed and when, the
 * cash back it has earned (exact, from each statement's reward summary),
 * where the money goes, and every statement with its math. */
export function BofaCardDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
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
  const rewardSeries = useMemo<LineSeries[]>(
    () => [{ name: 'Cash Back Earned', color: REWARD_COLOR, points: cut(s.cashBack).map((p) => ({ x: toMs(p.asOf), y: p.earned })) }],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.cashBack, range]
  );

  const maxYear = Math.max(1, ...s.years.map((y) => y.net));
  const maxMerchant = Math.max(1, ...s.topMerchants.map((m) => m.amount));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const skipped = files.filter((f) => f.status === 'skipped').length;
  const rowsDesc = [...s.statements].reverse();
  const rowsShown = showAllStmts ? rowsDesc : rowsDesc.slice(0, 12);
  const checksOf = (closing: string) => statements.find((st) => st.periodEnd === closing)?.checks ?? [];
  const hiddenFees = s.years.reduce((n, y) => n + (y.hiddenFees ?? 0), 0);
  const hidden = s.years.filter((y) => y.hiddenFees || y.hiddenInterest);
  const monthLabel = (ym: string) => new Date(toMs(`${ym}-15`)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const nextYm = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  /** ["2025-06", …, "2026-04"] → "Jun 2025 – Apr 2026". */
  const monthRuns = (months: string[]) => {
    const runs: string[][] = [];
    for (const m of months) {
      const last = runs[runs.length - 1];
      if (last && nextYm(last[last.length - 1]) === m) last.push(m);
      else runs.push([m]);
    }
    return runs.map((r) => (r.length === 1 ? monthLabel(r[0]) : `${monthLabel(r[0])} – ${monthLabel(r[r.length - 1])}`)).join(', ');
  };

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
          label="Cash Back"
          value={s.cashBackAvailable !== null ? money(s.cashBackAvailable) : '—'}
          sub={[s.cashBackAsOf ? `Available ${fmtDate(s.cashBackAsOf)}` : null, `${money(s.ytdCashBackEarned)} earned in ${year}`].filter(Boolean).join(' · ')}
          swatch={REWARD_COLOR}
        />
        <Stat
          label={`Spent ${year}`}
          value={money(s.ytdNet, false)}
          sub={s.avgMonthlyNet !== null ? [`${money(s.avgMonthlyNet, false)}/mo avg (12 mo)`, s.rewardRate !== null ? `${s.rewardRate.toFixed(1)}% back` : null].filter(Boolean).join(' · ') : undefined}
          swatch={SPEND_COLOR}
        />
        <Stat
          label="Credit Used"
          value={s.utilization !== null ? `${s.utilization.toFixed(1)}%` : '—'}
          sub={s.creditLine !== null ? `of ${money(s.creditLine, false)} · ${s.paidInFullStreak} statement${s.paidInFullStreak === 1 ? '' : 's'} paid in full` : undefined}
        />
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
          <h3 className="fin-dash__card-title">Spending by Statement</h3>
          <FinanceLineChart series={spendSeries} yFromZero formatY={(v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`)} formatX={fmtShort} ariaLabel="Net spending (new charges minus refunds) on each monthly statement" />
          <p className="fin-dash__note">Purchases minus refunds on each monthly statement (closing on the 26th). Months with no activity have no statement.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Spend by Year</h3>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <div
                key={y.year}
                className="fin-dash__year"
                title={`${y.year} (${y.statements} statement${y.statements === 1 ? '' : 's'}): ${money(y.purchases)} charges − ${money(y.refunds)} refunds = ${money(y.net)} · ${money(y.cashBackEarned)} cash back${y.estimated ? ' (part estimated)' : ''}${y.fees ? ` · ${money(y.fees)} fees` : ''}${y.interest ? ` · ${money(y.interest)} interest` : ''}`}
              >
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.net / maxYear) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.net, false)}</span>
                <span className="fin-dash__year-bills">{y.year === year ? 'YTD' : y.estimated || y.year === s.years[0]?.year ? 'Part' : ''}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__note">Net spending by statement year — {money(s.lifetimeNet, false)} since {s.firstStatement ? s.firstStatement.slice(0, 4) : '—'}. Hover a year for details.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Cash Back by Statement</h3>
          <FinanceLineChart series={rewardSeries} yFromZero formatY={(v) => `$${Math.round(v)}`} formatX={fmtShort} ariaLabel="Cash back earned on each statement" />
          <p className="fin-dash__note">
            Cash back earned on each statement (base + category bonus + Preferred Rewards bonus). {s.lifetimeBridged > 0.005 ? 'About ' : ''}
            {money(s.lifetimeCashBackEarned, false)} earned since {s.firstStatement ? s.firstStatement.slice(0, 4) : '—'}; {money(s.lifetimeCashBackRedeemed, false)} redeemed.
          </p>
        </section>

        {data.rewards && (
          <CardRewardsPanel rewards={data.rewards} redeemAt={data.redeemAt} redeemTask={data.redeemTask} redeemQuietUntil={data.redeemQuietUntil} color={REWARD_COLOR} />
        )}

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
          <p className="fin-dash__note">Net of refunds{s.rewardRate !== null ? ` · ${s.rewardRate.toFixed(2)}% back on ${money(s.last12Net, false)} of spending in the last 12 statements` : ''}.</p>
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
            {hidden.length > 0 && ` (incl. ${hidden.map((y) => `${y.year}: ${[y.hiddenFees ? `${money(y.hiddenFees)} fees` : null, y.hiddenInterest ? `${money(y.hiddenInterest)} interest` : null].filter(Boolean).join(' + ')}`).join(', ')} from statements missing from Drive — the year-to-date totals show it)`}
            {s.purchaseApr !== null ? ` · purchase APR ${s.purchaseApr}% (variable)${s.onPenaltyApr ? ' — the penalty rate' : ''}` : ''}.
          </p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Where the Cash Back Comes From</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>Base</th>
                  <th>Category</th>
                  <th>Relationship</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {[...s.years].reverse().map((y) => (
                  <tr key={y.year}>
                    <td>{y.year}</td>
                    <td>{money(y.base)}</td>
                    <td>{money(y.bonus)}</td>
                    <td>{money(y.relationship)}</td>
                    <td title={y.estimated ? 'Includes an estimate for statements missing from Drive' : undefined}>
                      {money(y.cashBackEarned)}
                      {y.estimated ? '*' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">Base cash back on everything, the category / grocery bonus, and the Preferred Rewards relationship bonus, by statement year.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Payments</h3>
          <table className="fin-dash__table bofa__kv">
            <tbody>
              <tr>
                <td>Latest Payment</td>
                <td>{s.latestPaymentAutopay === null ? '—' : s.latestPaymentAutopay ? 'AutoPay' : 'Manual'}</td>
              </tr>
              <tr>
                <td>Paid by AutoPay (Last 12)</td>
                <td>{s.autopayShare !== null ? `${s.autopayShare}%` : '—'}</td>
              </tr>
              <tr>
                <td>Paid in Full</td>
                <td>
                  {s.paidInFullStreak} statement{s.paidInFullStreak === 1 ? '' : 's'} in a row
                </td>
              </tr>
              <tr>
                <td>Late Fees (All-Time)</td>
                <td className={hiddenFees + s.lateFees.length ? 'fin-dash__neg' : undefined} title={hiddenFees ? `Includes ${money(hiddenFees)} only seen in the year-to-date fee total (a statement missing from Drive)` : undefined}>
                  {s.lateFees.length || hiddenFees ? money(s.lateFees.reduce((n, f) => n + f.amount, 0) + hiddenFees) : 'None'}
                </td>
              </tr>
            </tbody>
          </table>
          {(data.gaps.missing.length > 0 || data.gaps.quiet.length > 0) && (
            <p className="fin-dash__note">
              {data.gaps.quiet.length > 0 && <>No statement (no activity, $0 balance): {monthRuns(data.gaps.quiet)}. </>}
              {data.gaps.missing.length > 0 && <>Missing from Drive: {monthRuns(data.gaps.missing)}.</>}
            </p>
          )}
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
                  <th>Charges</th>
                  <th>Credits</th>
                  <th>Cash Back</th>
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
                        {r.autopay ? ' · Auto' : ''}
                      </td>
                      <td>{money(r.purchases)}</td>
                      <td>{r.credits ? money(-r.credits) : '—'}</td>
                      <td title={r.cashBackBridged > 0.005 ? `+${money(r.cashBackBridged)} estimated for statements missing from Drive` : undefined}>
                        {r.cashBackEarned !== null ? `+${money(r.cashBackEarned + r.cashBackBridged)}${r.cashBackBridged > 0.005 ? '*' : ''}` : '—'}
                      </td>
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
            {skipped > 0 && ` · ${skipped} skipped (year-end summaries)`}
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
                  bankofamerica.com ↗
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
