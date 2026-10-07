import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdtBill, AdtDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

// Same validated pair as the 529 dashboard (dataviz validator: CVD ΔE 20).
const RATE_COLOR = '#2A6FB0';
const BILLED_COLOR = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const period = (b: AdtBill) => (b.servicePeriodStart && b.servicePeriodEnd ? `${fmtDate(b.servicePeriodStart)} – ${fmtDate(b.servicePeriodEnd)}` : '—');

function paymentText(b: AdtBill): string {
  if (b.totalDue < -0.005) return 'Credit';
  if (b.dueNote === 'Past Due') return 'Past Due';
  if (b.totalDue <= 0.005) return 'Nothing Due';
  if (b.autopay) return b.dueDate ? `Autopay ${fmtDate(b.dueDate)}` : 'Autopay';
  if (b.dueDate) return `Due ${fmtDate(b.dueDate)}`;
  return b.dueNote ?? 'Due';
}
const carried = (b: AdtBill) => b.previousBalance > 0.005 && b.previousBalance + b.payments > 0.005;

/** ADT — a monthly bill, not a balance: what it costs now, how the rate has
 * moved, what it adds up to each year, and every bill with its math. */
export function AdtDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const [showAll, setShowAll] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const latest = s.latest;
  const year = Number((s.asOf ?? new Date().toISOString()).slice(0, 4));

  const series = useMemo<LineSeries[]>(() => {
    const rate = s.bills.filter((b) => b.monthlyRate !== null && b.monthlyRate > 0).map((b) => ({ x: toMs(b.invoiceDate), y: b.monthlyRate! }));
    const billed = s.bills.map((b) => ({ x: toMs(b.invoiceDate), y: b.billed }));
    return [
      { name: 'Monthly Rate', color: RATE_COLOR, points: rate, step: true },
      { name: 'Billed (Charges + Tax)', color: BILLED_COLOR, points: billed },
    ];
  }, [s.bills]);

  const maxYear = Math.max(1, ...s.years.map((y) => y.billed));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const bills = [...s.bills].reverse();
  const shown = showAll ? bills : bills.slice(0, 12);
  const firstYear = s.firstInvoice ? Number(s.firstInvoice.slice(0, 4)) : year;
  const fullYears = s.years.filter((y) => y.year > firstYear && y.year < year);
  const avgYear = fullYears.length ? fullYears.reduce((a, y) => a + y.billed, 0) / fullYears.length : null;

  return (
    <div className="ny529 adt">
      {data.flags.length > 0 && (
        <div className="ny529__flags">
          {data.flags.map((f) => (
            <div key={f.id} className={`ny529__flag ny529__flag--${f.severity}`}>
              <span className="ny529__flag-icon">{f.severity === 'warn' ? '⚠' : 'ℹ'}</span>
              <span className="ny529__flag-msg">{f.message}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDismissFlag(f.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ny529__stats">
        <Stat label="Latest Bill" value={latest ? money(latest.totalDue) : '—'} sub={latest ? `${paymentText(latest)} · Billed ${fmtDate(latest.invoiceDate)}` : undefined} tone={s.status === 'past_due' ? 'bad' : undefined} />
        <Stat
          label="Monthly Rate"
          value={s.monthlyRate !== null ? money(s.monthlyRate) : '—'}
          sub={s.monthlyRate !== null ? `${s.monthlyWithTax !== null ? `${money(s.monthlyWithTax)} with tax · ` : '+ tax · '}Since ${fmtMonth(s.rateSince!)}` : undefined}
        />
        <Stat label={`${year} So Far`} value={money(s.ytdBilled)} sub={`${s.ytdBills} bill${s.ytdBills === 1 ? '' : 's'}`} />
        <Stat label={`Since ${firstYear}`} value={money(s.lifetimeBilled, false)} sub={`${s.bills.length} bills${avgYear !== null ? ` · ~${money(avgYear, false)}/yr` : ''}`} />
      </div>

      <div className="ny529__grid">
        <section className="ny529__card ny529__card--wide">
          <h3 className="ny529__card-title">Monthly Rate Over Time</h3>
          <FinanceLineChart series={series} formatY={(v) => `$${Math.round(v)}`} formatX={fmtShort} ariaLabel="ADT monthly rate and amount billed per bill over time" />
          <p className="ny529__note">Monthly Rate is the full-month monitoring charge before tax. Billed is each bill’s charges + tax (credits and pro-rated months dip below the rate).</p>
        </section>

        <section className="ny529__card">
          <h3 className="ny529__card-title">Spend by Year</h3>
          <div className="adt__years">
            {[...s.years].reverse().map((y) => (
              <div key={y.year} className="adt__year" title={`${y.year}: ${money(y.billed)} billed over ${y.bills} bills`}>
                <span className="adt__year-label">{y.year}</span>
                <span className="adt__year-track">
                  <span className="adt__year-bar" style={{ width: `${Math.max(0, (y.billed / maxYear) * 100)}%` }} />
                </span>
                <span className="adt__year-value">{money(y.billed, false)}</span>
                <span className="adt__year-bills">{y.bills}</span>
              </div>
            ))}
          </div>
          <p className="ny529__note">
            Charges + tax by invoice year; right column is bills in Drive.
            {year === Number(s.asOf?.slice(0, 4)) ? ` ${year} is year to date.` : ''}
          </p>
        </section>

        <section className="ny529__card ny529__card--wide">
          <h3 className="ny529__card-title">Rate History</h3>
          <div className="ny529__table-wrap">
            <table className="ny529__table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Through</th>
                  <th>Monthly Rate</th>
                  <th>Change</th>
                  <th>Bills</th>
                  <th>Services</th>
                </tr>
              </thead>
              <tbody>
                {[...s.rateHistory].reverse().map((r, i, arr) => {
                  const prev = arr[i + 1];
                  const delta = prev ? r.rate - prev.rate : null;
                  return (
                    <tr key={r.from}>
                      <td>{fmtMonth(r.from)}</td>
                      <td>{i === 0 ? 'Now' : fmtMonth(r.to)}</td>
                      <td>{money(r.rate)}</td>
                      <td className={delta !== null && delta > 0 ? 'ny529__neg' : undefined}>
                        {delta === null ? '—' : `${delta > 0 ? '+' : ''}${money(delta)} (${delta > 0 ? '+' : ''}${((delta / prev!.rate) * 100).toFixed(0)}%)`}
                      </td>
                      <td>{r.bills}</td>
                      <td>{r.services ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {latest && (
          <section className="ny529__card">
            <h3 className="ny529__card-title">Current Bill · {fmtDate(latest.invoiceDate)}</h3>
            <dl className="adt__kv">
              <dt>Service Period</dt>
              <dd>{period(latest)}</dd>
              <dt>Previous Balance</dt>
              <dd>{money(latest.previousBalance)}</dd>
              <dt>Payments</dt>
              <dd>{money(latest.payments)}</dd>
              <dt>Charges</dt>
              <dd>{money(latest.charges)}</dd>
              <dt>Taxes and Fees</dt>
              <dd>{money(latest.taxes)}</dd>
              <dt>Total Due</dt>
              <dd>
                <strong>{money(latest.totalDue)}</strong>
              </dd>
              <dt>Payment</dt>
              <dd>{paymentText(latest)}</dd>
              {s.nextBillExpected && (
                <>
                  <dt>Next Bill</dt>
                  <dd>Around {fmtDate(s.nextBillExpected)}</dd>
                </>
              )}
            </dl>
            {s.status === 'past_due' ? (
              <div className="ny529__gap">
                <strong>Unpaid balance carried over.</strong> Check the card on file at MyADT.com.
              </div>
            ) : data.payTask && data.payTask.status !== 'done' ? (
              <div className="ny529__gap">Not on autopay — reminder set for {data.payTask.due ? fmtDate(data.payTask.due) : 'the due date'}.</div>
            ) : (
              <div className="ny529__gap ny529__gap--ok">✓ {latest.autopay ? 'On automatic payment.' : 'Nothing outstanding.'}</div>
            )}
          </section>
        )}

        <section className="ny529__card ny529__card--full">
          <div className="ny529__card-head">
            <h3 className="ny529__card-title">Bills</h3>
            {bills.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show Recent' : `Show All ${bills.length}`}
              </button>
            )}
          </div>
          <div className="ny529__table-wrap">
            <table className="ny529__table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Service Period</th>
                  <th>Charges</th>
                  <th>Tax</th>
                  <th>Total Due</th>
                  <th>Payment</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const failed = b.checks.filter((c) => !c.ok);
                  const url = fileUrl(b.fileId);
                  return (
                    <tr key={b.invoiceDate}>
                      <td>{fmtDate(b.invoiceDate)}</td>
                      <td>{period(b)}</td>
                      <td className={b.charges < 0 ? 'ny529__neg' : undefined}>{money(b.charges)}</td>
                      <td>{money(b.taxes)}</td>
                      <td className={carried(b) ? 'ny529__neg' : undefined} title={carried(b) ? `Includes ${money(b.previousBalance)} carried from the previous bill` : undefined}>
                        {money(b.totalDue)}
                      </td>
                      <td>{paymentText(b)}</td>
                      <td title={b.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')}>{failed.length ? `✕ ${failed.length} failed` : `✓ ${b.checks.length}/${b.checks.length}`}</td>
                      <td>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer">
                            Bill ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ny529__note">
            {s.bills.length} bill{s.bills.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
            {s.gaps.length > 0 && ` · ${s.gaps.length} gap${s.gaps.length === 1 ? '' : 's'} of 45+ days between bills`}
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
                  MyADT ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="ny529__stat">
      <span className="ny529__stat-label">{label}</span>
      <span className={`ny529__stat-value${tone === 'bad' ? ' ny529__neg' : ''}`}>{value}</span>
      {sub && <span className="ny529__stat-sub">{sub}</span>}
    </div>
  );
}
