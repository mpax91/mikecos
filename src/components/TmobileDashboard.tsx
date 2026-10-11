import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TmobileBill, TmobileDashboard as Data } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

// Same validated pair as the 529 / ADT dashboards (dataviz validator: CVD ΔE 20).
const BLUE = '#2A6FB0';
const ORANGE = '#C0662E';

const money = (n: number, cents = true) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const gb = (n: number | null) => (n === null ? '—' : `${n.toFixed(n >= 10 ? 1 : 2)} GB`);

function paymentText(b: TmobileBill): string {
  if (b.totalDue < -0.005) return 'Credit';
  if (b.balance > 0.005) return 'Past Due';
  if (b.totalDue <= 0.005) return 'Nothing Due';
  if (b.autopay) return b.dueDate ? `AutoPay · Due ${fmtDate(b.dueDate)}` : 'AutoPay';
  if (b.dueDate) return `Due ${fmtDate(b.dueDate)}`;
  return b.dueNote ?? 'Due';
}

/** T-Mobile — a monthly bill with lines and phones on installment plans:
 * what it costs now and per line, which phones are still being paid off,
 * how the plan and spending moved, data use, and every bill with its math. */
export function TmobileDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const [showAll, setShowAll] = useState(false);
  const [showPastDevices, setShowPastDevices] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const latest = s.latest;
  const year = Number((s.asOf ?? new Date().toISOString()).slice(0, 4));

  const billSeries = useMemo<LineSeries[]>(
    () => [
      { name: 'Billed', color: BLUE, points: s.bills.map((b) => ({ x: toMs(b.billDate), y: b.billed })) },
      { name: 'Plans', color: ORANGE, points: s.bills.map((b) => ({ x: toMs(b.billDate), y: b.plans })), step: true },
    ],
    [s.bills]
  );
  // Data per named line (Mike / Wife) — other lines barely use data.
  const named = s.lines.filter((l) => l.name === 'Mike' || l.name === 'Wife');
  const usageSeries = useMemo<LineSeries[]>(
    () =>
      named.map((l, i) => ({
        name: l.name,
        color: i === 0 ? BLUE : ORANGE,
        points: data.usage.flatMap((u) => {
          const row = u.lines.find((x) => x.number === l.number);
          return row && row.gb !== null ? [{ x: toMs(u.date), y: row.gb }] : [];
        }),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.usage, s.lines]
  );

  const maxYear = Math.max(1, ...s.years.map((y) => y.billed));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const bills = [...s.bills].reverse();
  const shown = showAll ? bills : bills.slice(0, 12);
  const firstYear = s.firstBill ? Number(s.firstBill.slice(0, 4)) : year;
  const fullYears = s.years.filter((y) => y.year > firstYear && y.year < year);
  const avgYear = fullYears.length ? fullYears.reduce((a, y) => a + y.billed, 0) / fullYears.length : null;
  const activeDevices = s.devices.filter((d) => d.active);
  const pastDevices = s.devices.filter((d) => !d.active);
  const activeLines = s.lines.filter((l) => l.active);
  const pastLines = s.lines.filter((l) => !l.active);

  return (
    <div className="fin-dash tmobile">
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
        <Stat label="Latest Bill" value={latest ? money(latest.totalDue) : '—'} sub={latest ? `${paymentText(latest)} · Billed ${fmtDate(latest.billDate)}` : undefined} tone={s.status === 'past_due' ? 'bad' : undefined} />
        <Stat
          label="Plan"
          value={s.planCharge !== null ? money(s.planCharge) : '—'}
          sub={[s.plan, `${activeLines.length} line${activeLines.length === 1 ? '' : 's'}`, s.planSince ? `Since ${fmtMonth(s.planSince)}` : null].filter(Boolean).join(' · ')}
        />
        <Stat
          label="Phones Owed"
          value={money(s.devicePayments)}
          sub={activeDevices.length ? activeDevices.map((d) => `${d.device}${d.payoffExpected ? ` → ${fmtMonth(d.payoffExpected)}` : ''}`).join(' · ') : 'No phones on installment plans'}
        />
        <Stat
          label={`${year} So Far`}
          value={money(s.ytdBilled)}
          sub={`${s.ytdBills} bill${s.ytdBills === 1 ? '' : 's'} · ${money(s.lifetimeBilled, false)} since ${firstYear}${avgYear !== null ? ` (~${money(avgYear, false)}/yr)` : ''}`}
        />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Monthly Bill Over Time</h3>
          <FinanceLineChart series={billSeries} formatY={(v) => `$${Math.round(v)}`} formatX={fmtShort} ariaLabel="T-Mobile amount billed and plan charge per bill over time" yFromZero />
          <p className="fin-dash__note">Billed is each bill’s own charges (taxes are included in T-Mobile’s prices) — device credits and one-time items move it around the plan charge.</p>
        </section>

        {latest && (
          <section className="fin-dash__card">
            <h3 className="fin-dash__card-title">Current Bill · {fmtDate(latest.billDate)}</h3>
            <dl className="adt__kv">
              <dt>Service Period</dt>
              <dd>{latest.servicePeriodStart && latest.servicePeriodEnd ? `${fmtDate(latest.servicePeriodStart)} – ${fmtDate(latest.servicePeriodEnd)}` : '—'}</dd>
              <dt>Plans</dt>
              <dd>{money(latest.plans)}</dd>
              <dt>Equipment</dt>
              <dd>{money(latest.equipment)}</dd>
              <dt>Services</dt>
              <dd>{money(latest.services)}</dd>
              {latest.oneTime !== 0 && (
                <>
                  <dt>One-Time</dt>
                  <dd>{money(latest.oneTime)}</dd>
                </>
              )}
              {latest.balance !== 0 && (
                <>
                  <dt>{latest.balance > 0 ? 'Unpaid From Last Bill' : 'Credit From Last Bill'}</dt>
                  <dd className={latest.balance > 0 ? 'fin-dash__neg' : undefined}>{money(latest.balance)}</dd>
                </>
              )}
              <dt>Total Due</dt>
              <dd>
                <strong>{money(latest.totalDue)}</strong>
              </dd>
              <dt>Payment</dt>
              <dd>{paymentText(latest)}</dd>
              {latest.autopayCard && (
                <>
                  <dt>AutoPay Card</dt>
                  <dd>{latest.autopayCard}</dd>
                </>
              )}
              {latest.savings !== null && latest.savings > 0 && (
                <>
                  <dt>Discounts This Bill</dt>
                  <dd>{money(latest.savings)}</dd>
                </>
              )}
            </dl>
            {s.status === 'past_due' ? (
              <div className="fin-dash__gap">
                <strong>Unpaid balance carried over.</strong> Check the AutoPay card at t-mobile.com.
              </div>
            ) : (
              <div className="fin-dash__gap fin-dash__gap--ok">✓ {latest.autopay ? 'On AutoPay.' : 'Nothing outstanding.'}</div>
            )}
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--wide">
          <h3 className="fin-dash__card-title">Lines</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Number</th>
                  <th>Monthly</th>
                  <th>Phone</th>
                  <th>Data (Last Bill)</th>
                  <th>Data (12-Mo Avg)</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {activeLines.map((l) => (
                  <tr key={l.number}>
                    <td>
                      <strong>{l.name}</strong>
                      {l.type && l.type !== 'Voice' ? ` · ${l.type}` : ''}
                    </td>
                    <td>{l.number}</td>
                    <td title={`Plan share ${money(l.planShare)} + own charges ${money(l.ownCharges)}`}>{money(l.monthly)}</td>
                    <td>{l.device ?? '—'}</td>
                    <td>{gb(l.latestDataGb)}</td>
                    <td>{gb(l.avgDataGb12)}</td>
                    <td>{fmtMonth(l.firstBill)}</td>
                  </tr>
                ))}
                {pastLines.map((l) => (
                  <tr key={l.number} className="tmobile__past">
                    <td>{l.name}</td>
                    <td>{l.number}</td>
                    <td colSpan={3}>Ended {fmtMonth(l.lastBill)}</td>
                    <td>—</td>
                    <td>{fmtMonth(l.firstBill)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">Monthly = the line’s own charges + an even share of the account plan charge across the lines whose plan is “Included”.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Spend by Year</h3>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <div key={y.year} className="fin-dash__year" title={`${y.year}: ${money(y.billed)} billed over ${y.bills} bills · plans ${money(y.plans)} · equipment ${money(y.equipment)}`}>
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.billed / maxYear) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.billed, false)}</span>
                <span className="fin-dash__year-bills">{y.bills}</span>
              </div>
            ))}
          </div>
          <p className="fin-dash__note">
            Charges by bill year; right column is bills in Drive.{year === Number(s.asOf?.slice(0, 4)) ? ` ${year} is year to date.` : ''} {money(s.lifetimeEquipment, false)} of the total went to phones.
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Device Payments</h3>
            {pastDevices.length > 0 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowPastDevices((v) => !v)}>
                {showPastDevices ? 'Hide Paid Off' : `Show Paid Off (${pastDevices.length})`}
              </button>
            )}
          </div>
          {activeDevices.length === 0 && <p className="fin-dash__note">No phones on installment plans right now.</p>}
          {activeDevices.map((d) => {
            const pct = d.installment !== null && d.of ? Math.round((d.installment / d.of) * 100) : 0;
            return (
              <div key={d.id} className="tmobile__device">
                <div className="tmobile__device-head">
                  <strong>{d.device}</strong>
                  <span>{d.lineName ?? d.line ?? ''}</span>
                </div>
                <span className="fin-dash__year-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.device} paid ${pct}%`}>
                  <span className="fin-dash__year-bar" style={{ width: `${pct}%` }} />
                </span>
                <div className="tmobile__device-meta">
                  {d.installment !== null ? `Installment ${d.installment} of ${d.of}` : 'Installment plan'}
                  {d.balance !== null ? ` · ${money(d.balance)} left` : ''}
                  {` · ${money(d.monthlyCharge)}/mo`}
                  {d.monthlyCredit ? ` after ${money(-d.monthlyCredit)} promo credit` : ''}
                  {d.payoffExpected ? ` · Paid off ${fmtMonth(d.payoffExpected)}` : ''}
                </div>
              </div>
            );
          })}
          {showPastDevices && (
            <div className="fin-dash__table-wrap">
              <table className="fin-dash__table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Line</th>
                    <th>From</th>
                    <th>Through</th>
                    <th>Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {pastDevices.map((d) => (
                    <tr key={d.id}>
                      <td>{d.device}</td>
                      <td>{d.lineName ?? d.line ?? '—'}</td>
                      <td>{fmtMonth(d.firstBill)}</td>
                      <td>{fmtMonth(d.lastBill)}</td>
                      <td>{d.of ? `${d.of} months` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Plan History</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Plan</th>
                  <th>Plans</th>
                  <th>Lines</th>
                </tr>
              </thead>
              <tbody>
                {[...s.planHistory].reverse().map((p) => (
                  <tr key={p.from}>
                    <td>{fmtMonth(p.from)}</td>
                    <td>{p.plan ?? '—'}</td>
                    <td>{money(p.plans)}</td>
                    <td>{p.lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">A new row starts whenever the plan, its price or the number of lines changes.</p>
        </section>

        {usageSeries.length > 0 && (
          <section className="fin-dash__card fin-dash__card--full">
            <h3 className="fin-dash__card-title">Data Used per Bill</h3>
            <FinanceLineChart series={usageSeries} formatY={(v) => `${Math.round(v)} GB`} formatX={fmtShort} ariaLabel="T-Mobile data used per bill by line" yFromZero />
            <p className="fin-dash__note">Unlimited plan — this is for curiosity, not cost. Talk and text counts are on each bill below.</p>
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Bills</h3>
            {bills.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show Recent' : `Show All ${bills.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Bill Date</th>
                  <th>Plans</th>
                  <th>Equipment</th>
                  <th>Services</th>
                  <th>One-Time</th>
                  <th>Billed</th>
                  <th>Total Due</th>
                  <th>Payment</th>
                  <th>Data</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const failed = b.checks.filter((c) => !c.ok);
                  const url = fileUrl(b.fileId);
                  return (
                    <tr key={b.billDate}>
                      <td>{fmtDate(b.billDate)}</td>
                      <td>{money(b.plans)}</td>
                      <td>{money(b.equipment)}</td>
                      <td>{money(b.services)}</td>
                      <td>{b.oneTime ? money(b.oneTime) : '—'}</td>
                      <td>{money(b.billed)}</td>
                      <td className={b.balance > 0.005 ? 'fin-dash__neg' : undefined} title={b.balance ? `Includes ${money(b.balance)} from the previous bill` : undefined}>
                        {money(b.totalDue)}
                      </td>
                      <td>{paymentText(b)}</td>
                      <td title={b.minutes !== null ? `${b.minutes.toLocaleString()} minutes · ${b.messages?.toLocaleString() ?? '—'} messages` : undefined}>{gb(b.dataGb)}</td>
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
          <p className="fin-dash__note">
            {s.bills.length} bill{s.bills.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
            {s.gaps.length > 0 && ` · ${s.gaps.length} gap${s.gaps.length === 1 ? '' : 's'} of 45+ days between bills`}
            {s.lifetimeSavings > 0 && ` · ${money(s.lifetimeSavings, false)} in discounts since ${firstYear}`}
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
            {' · '}
            <a href="https://account.t-mobile.com" target="_blank" rel="noreferrer">
              T-Mobile ↗
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">{label}</span>
      <span className={`fin-dash__stat-value${tone === 'bad' ? ' fin-dash__neg' : ''}`}>{value}</span>
      {sub && <span className="fin-dash__stat-sub">{sub}</span>}
    </div>
  );
}
