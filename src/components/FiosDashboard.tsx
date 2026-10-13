import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FiosBill, FiosDashboard as Data, FiosItem } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { useUrlRange } from './dash/useUrlRange';
import { inRange, nyToday, previousRange, rangeText } from '../utils/dateRange';

// Same validated pair as the ADT / 529 dashboards (dataviz validator: CVD ΔE 20).
const REGULAR_COLOR = '#2A6FB0';
const BILLED_COLOR = '#C0662E';

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const speed = (mbps: number | null) => (mbps === null ? '—' : mbps >= 1000 ? `${mbps / 1000} Gig` : `${mbps} Mbps`);
const period = (b: FiosBill) => (b.servicePeriodStart && b.servicePeriodEnd ? `${fmtDate(b.servicePeriodStart)} – ${fmtDate(b.servicePeriodEnd)}` : '—');
const monthsUntil = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / (30.44 * 86400000));

const KIND_LABEL: Record<FiosItem['kind'], string> = {
  service: 'Internet',
  equipment: 'Equipment',
  discount: 'Discount',
  addon: 'Included',
  change: 'Plan Change (Pro-Rated)',
  tax: 'Taxes & Surcharges',
  fee: 'Fee',
};

function paymentText(b: FiosBill): string {
  if (b.totalDue < -0.005) return 'Credit';
  if (b.pastDue) return 'Past Due';
  if (b.totalDue <= 0.005) return 'Nothing Due';
  if (b.autopay) return b.autopayDate ? `Auto Pay ${fmtDate(b.autopayDate)}` : 'Auto Pay';
  return b.dueDate ? `Due ${fmtDate(b.dueDate)}` : 'Due';
}

function change(now: number, prev: number | null, label: string | null): { text: string; tone: '' | 'up' | 'down' } {
  if (prev == null || label == null || !prev) return { text: '', tone: '' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' };
  // A bill going up is bad news: "up" tone reads red in bee-delta.
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: d > 0 ? 'down' : 'up' };
}

type Sheet = { kind: 'bills'; title: string; bills: FiosBill[] } | { kind: 'bill'; bill: FiosBill } | { kind: 'plans' } | { kind: 'monthly' } | { kind: 'lock' };

/** Verizon Fios — the home internet bill: what it costs each month, what the
 * plan is and how it got here, the discounts and the price guarantee, and
 * every bill with its line items and math. Tiles follow the range picker. */
export function FiosDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const today = nyToday();
  const earliest = s.firstBill ?? today;
  const [range, setRange] = useUrlRange(earliest, '1y');
  const prevR = previousRange(range);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const latest = s.latest;

  const inR = s.bills.filter((b) => inRange(b.billDate, range));
  const inP = prevR ? s.bills.filter((b) => inRange(b.billDate, prevR)) : [];
  const billed = inR.reduce((a, b) => a + b.billed, 0);
  const billedPrev = prevR && inP.length ? inP.reduce((a, b) => a + b.billed, 0) : null;
  const pl = prevR ? 'previous' : null;

  const series = useMemo<LineSeries[]>(() => {
    const rows = s.bills.filter((b) => inRange(b.billDate, range));
    return [
      { name: 'Regular Monthly', color: REGULAR_COLOR, points: rows.map((b) => ({ x: toMs(b.billDate), y: b.regular })), step: true },
      { name: 'Billed', color: BILLED_COLOR, points: rows.map((b) => ({ x: toMs(b.billDate), y: b.billed })) },
    ];
  }, [s.bills, range]);

  const maxYear = Math.max(1, ...s.years.map((y) => y.billed));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const bills = [...inR].reverse();
  const shown = showAll ? bills : bills.slice(0, 12);
  const lockMonths = s.priceGuaranteeUntil ? monthsUntil(today, s.priceGuaranteeUntil) : null;
  const ap = s.autopayDiscount;
  const lastRental = [...s.bills].reverse().find((b) => b.items.some((i) => i.kind === 'equipment' || (i.kind === 'change' && /rent|router/i.test(i.description))));

  return (
    <div className="fin-dash fios-dash">
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

      <div className="dash-controls dash-controls--solo">
        <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} presets={['90d', 'ytd', '1y', 'all']} />
        <span className="dash-controls__range-text">
          {rangeText(range)}
          {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
          <InfoTip label="How the Fios bill is read">
            <p>Each bill in the Drive folder is read for its charges: the internet plan, equipment, add-ons, discounts, taxes and surcharges, plan-change pro-rations and late fees.</p>
            <p>
              <strong>Regular monthly</strong> is what a normal month costs (plan + equipment + add-ons − discounts + taxes). <strong>Billed</strong> is everything on that bill, including one-time
              pro-rations and fees.
            </p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'bills', title: `Billed · ${range.label}`, bills: [...inR].reverse() })}>
          <span className="fin-dash__stat-label">Billed</span>
          <span className="fin-dash__stat-value">{money(billed)}</span>
          {(() => {
            const c = change(billed, billedPrev, pl);
            return (
              <span className={`fin-dash__stat-sub${c.tone === 'up' ? ' bee-delta--up' : c.tone === 'down' ? ' bee-delta--down' : ''}`}>
                {c.text || `${inR.length} bill${inR.length === 1 ? '' : 's'}`}
              </span>
            );
          })()}
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'monthly' })}>
          <span className="fin-dash__stat-label">Monthly Now</span>
          <span className="fin-dash__stat-value">{s.monthly !== null ? money(s.monthly) : '—'}</span>
          <span className="fin-dash__stat-sub">
            {s.listPrice !== null && s.monthly !== null && s.listPrice > s.monthly ? `List ${money(s.listPrice)} · saves ${money(s.listPrice - s.monthly)}` : s.priceSince ? `Since ${fmtMonth(s.priceSince)}` : ''}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'plans' })}>
          <span className="fin-dash__stat-label">Plan</span>
          <span className="fin-dash__stat-value">{speed(s.speedMbps)}</span>
          <span className="fin-dash__stat-sub">
            {s.plan ?? '—'}
            {s.planSince ? ` · since ${fmtMonth(s.planSince)}` : ''}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'lock' })}>
          <span className="fin-dash__stat-label">Price Guarantee</span>
          <span className={`fin-dash__stat-value${lockMonths !== null && lockMonths <= 3 ? ' fin-dash__neg' : ''}`}>{s.priceGuaranteeUntil ? fmtMonth(s.priceGuaranteeUntil) : 'None'}</span>
          <span className="fin-dash__stat-sub">
            {lockMonths === null ? 'not printed on the bill' : lockMonths > 0 ? `${lockMonths} month${lockMonths === 1 ? '' : 's'} left` : 'ended — rate can change'}
          </span>
        </button>
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Regular monthly is a normal month’s cost; Billed is each bill’s total charges — plan-change months and late fees jump above it, pro-rated credits dip below.</p>}>
            Monthly Bill Over Time
          </DashTitle>
          <FinanceLineChart series={series} formatY={(v) => `$${Math.round(v)}`} formatX={fmtShort} ariaLabel="Verizon Fios regular monthly cost and amount billed per bill over time" />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Things worth knowing from the bills, recomputed with every new bill.</p>}>Worth Knowing</DashTitle>
          <ul className="fios-dash__notes">
            {s.priceGuaranteeUntil && (
              <li className={lockMonths !== null && lockMonths <= 3 ? 'fios-dash__note--warn' : undefined}>
                <strong>Price guarantee through {fmtDate(s.priceGuaranteeUntil)}.</strong> {s.plan ?? 'The plan'} stays at its base rate until then; call Verizon a couple of months before for a new rate.
              </li>
            )}
            {ap.endedOn && ap.amount !== null && (
              <li className="fios-dash__note--warn">
                <strong>The {money(ap.amount, false)} Auto-Pay discount stopped on the {fmtMonth(ap.endedOn)} bill</strong> — about {money(ap.extraPaid, false)} more over {ap.billsWithout} bills since. Verizon
                ties it to Auto Pay from a bank account or Verizon Visa with paper-free billing; worth asking whether your plan still qualifies.
              </li>
            )}
            {s.perGig !== null && s.speedMbps !== null && s.speedMbps < 1000 && (
              <li>
                {speed(s.speedMbps)} for {money(s.monthly ?? 0)} a month — {money(s.perGig)} per Gig.
              </li>
            )}
            {s.addOns.length > 0 && <li>Included at no charge: {s.addOns.join(', ')}.</li>}
            {s.equipment.length === 0 && lastRental && <li>No equipment rental on the bill any more (the last rental charge was on the {fmtMonth(lastRental.billDate)} bill).</li>}
            <li>
              {money(s.lifetimeDiscounts, false)} in discounts since {s.firstBill ? fmtMonth(s.firstBill) : '—'}
              {s.lateFees > 0 ? ` · ${money(s.lateFees)} in late fees (${s.pastDueBills.map(fmtMonth).join(', ')})` : ''}.
            </li>
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Every plan on the bills in Drive, with its regular monthly at the end of the run.</p>}>Plan History</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Through</th>
                  <th>Plan</th>
                  <th>Speed</th>
                  <th>Monthly</th>
                  <th>Bills</th>
                </tr>
              </thead>
              <tbody>
                {[...s.planHistory].reverse().map((p, i) => (
                  <tr key={p.from}>
                    <td>{fmtMonth(p.from)}</td>
                    <td>{i === 0 ? 'Now' : fmtMonth(p.to)}</td>
                    <td>{p.plan}</td>
                    <td>{speed(p.speedMbps)}</td>
                    <td>{money(p.regular)}</td>
                    <td>{p.bills}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Charges by bill year; the right column is bills in Drive. The current year is year to date.</p>}>Spend by Year</DashTitle>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <button
                type="button"
                key={y.year}
                className="fin-dash__year fios-dash__year"
                onClick={() => setSheet({ kind: 'bills', title: `${y.year} Bills`, bills: s.bills.filter((b) => b.billDate.startsWith(String(y.year))).reverse() })}
              >
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.billed / maxYear) * 100)}%` }} />
                </span>
                <span className="fin-dash__year-value">{money(y.billed, false)}</span>
                <span className="fin-dash__year-bills">{y.bills}</span>
              </button>
            ))}
          </div>
        </section>

        {latest && (
          <section className="fin-dash__card">
            <h3 className="fin-dash__card-title">Current Bill · {fmtDate(latest.billDate)}</h3>
            <dl className="adt__kv">
              <dt>Service Period</dt>
              <dd>{period(latest)}</dd>
              <dt>Previous Balance</dt>
              <dd>{money(latest.previousBalance)}</dd>
              <dt>Payments</dt>
              <dd>{money(latest.payments)}</dd>
              <dt>Charges</dt>
              <dd>{money(latest.billed)}</dd>
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
              <div className="fin-dash__gap">
                <strong>Unpaid balance carried over.</strong> Check Auto Pay in My Verizon.
              </div>
            ) : (
              <div className="fin-dash__gap fin-dash__gap--ok">✓ {latest.autopay ? 'On Auto Pay.' : 'Nothing outstanding.'}</div>
            )}
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <DashTitle info={<p>Tap a bill for its line items and math. Math checks: previous balance + payments = balance forward, balance forward + charges = total due, each subtotal = its lines, and last bill’s total = this bill’s previous balance.</p>}>
              Bills
            </DashTitle>
            {bills.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show Recent' : `Show All ${bills.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Bill Date</th>
                  <th>Plan</th>
                  <th>Charges</th>
                  <th>Total Due</th>
                  <th>Payment</th>
                  <th>Math</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const failed = b.checks.filter((c) => !c.ok);
                  return (
                    <tr key={b.billDate} className="bee-social__row" onClick={() => setSheet({ kind: 'bill', bill: b })}>
                      <td>{fmtDate(b.billDate)}</td>
                      <td>{b.plan ?? '—'}</td>
                      <td className={b.billed > b.regular + 0.005 ? 'fin-dash__neg' : undefined}>{money(b.billed)}</td>
                      <td>{money(b.totalDue)}</td>
                      <td className={b.pastDue ? 'fin-dash__neg' : undefined}>{paymentText(b)}</td>
                      <td>{failed.length ? `✕ ${failed.length} failed` : `✓ ${b.checks.length}/${b.checks.length}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {shown.map((b) => (
              <li key={`c-${b.billDate}`}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'bill', bill: b })}>
                  <span className="post-card__top">
                    {fmtDate(b.billDate)} · {paymentText(b)}
                  </span>
                  <span className="post-card__title paypal-dash__card-title">
                    <span>{b.plan ?? 'Bill'}</span>
                    <span className={b.billed > b.regular + 0.005 ? 'fin-dash__neg' : undefined}>{money(b.billed)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">
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
            {' · '}
            <Link to="/home">Home → Internet</Link>
            {data.template?.site && (
              <>
                {' · '}
                <a href={data.template.site} target="_blank" rel="noreferrer">
                  My Verizon ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>

      {sheet?.kind === 'bills' && (
        <DetailSheet title={sheet.title} sub={`${sheet.bills.length} bills · ${money(sheet.bills.reduce((a, b) => a + b.billed, 0))}`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {sheet.bills.map((b) => (
              <li key={b.billDate}>
                <button type="button" onClick={() => setSheet({ kind: 'bill', bill: b })}>
                  <span>{fmtDate(b.billDate)}</span>
                  <span className="fios-dash__muted">{b.plan ?? ''}</span>
                  <strong>{money(b.billed)}</strong>
                </button>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'bill' && <BillSheet bill={sheet.bill} url={fileUrl(sheet.bill.fileId)} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'plans' && (
        <DetailSheet title="Plan History" sub={s.firstBill ? `Since ${fmtMonth(s.firstBill)}` : undefined} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...s.planHistory].reverse().map((p, i) => (
              <li key={p.from}>
                <span>
                  {fmtMonth(p.from)} – {i === 0 ? 'Now' : fmtMonth(p.to)}
                </span>
                <span className="fios-dash__muted">
                  {p.plan} · {speed(p.speedMbps)}
                  {p.listPrice !== null && p.listPrice > p.regular ? ` · list ${money(p.listPrice)}` : ''}
                </span>
                <strong>{money(p.regular)}/mo</strong>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'monthly' && (
        <DetailSheet title="Monthly Price History" sub="Regular monthly, plan changes and discounts included" onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...s.priceHistory].reverse().map((p, i) => (
              <li key={p.from}>
                <span>
                  {fmtMonth(p.from)} – {i === 0 ? 'Now' : fmtMonth(p.to)}
                </span>
                <span className="fios-dash__muted">
                  {p.bills} bill{p.bills === 1 ? '' : 's'}
                  {ap.endedOn === p.from ? ' · Auto-Pay discount stopped' : ''}
                </span>
                <strong>{money(p.amount)}</strong>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'lock' && (
        <DetailSheet title="Price Guarantee" sub={s.priceGuaranteeUntil ? `Through ${fmtDate(s.priceGuaranteeUntil)}` : 'None printed'} onClose={() => setSheet(null)}>
          <p>
            {s.priceGuaranteeUntil
              ? `Verizon’s bill says the base monthly rate for ${s.plan ?? 'your plan'} won’t change through ${fmtDate(s.priceGuaranteeUntil)} as long as the service stays in good standing. MikeOS flags it ${90} days before it ends so there’s time to call for a new rate or compare offers.`
              : 'The latest bill doesn’t mention a price guarantee.'}
          </p>
          {s.planSince && <p>Current plan since {fmtMonth(s.planSince)}.</p>}
        </DetailSheet>
      )}
    </div>
  );
}

function BillSheet({ bill: b, url, onClose }: { bill: FiosBill; url: string | null; onClose: () => void }) {
  const groups = (['service', 'equipment', 'addon', 'discount', 'change', 'tax', 'fee'] as FiosItem['kind'][]).map((k) => [k, b.items.filter((i) => i.kind === k)] as const).filter(([, list]) => list.length);
  return (
    <DetailSheet title={`Bill · ${fmtDate(b.billDate)}`} sub={`${period(b)} · ${paymentText(b)}`} onClose={onClose}>
      {groups.map(([k, list]) => (
        <div key={k} className="fios-dash__group">
          <h4>{KIND_LABEL[k]}</h4>
          <ul className="fios-dash__sheet-list">
            {list.map((i, n) => (
              <li key={n}>
                <span>
                  {i.description}
                  {i.change ? ` (${i.change}${i.changeDate ? ` ${fmtDate(i.changeDate)}` : ''})` : ''}
                </span>
                <span className="fios-dash__muted">{i.start && i.end ? `${fmtDate(i.start)} – ${fmtDate(i.end)}` : ''}</span>
                <strong className={i.amount < 0 ? 'fios-dash__credit' : undefined}>{money(i.amount)}</strong>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <dl className="adt__kv">
        <dt>Previous Balance</dt>
        <dd>{money(b.previousBalance)}</dd>
        <dt>Payments</dt>
        <dd>{money(b.payments)}</dd>
        <dt>Charges</dt>
        <dd>{money(b.billed)}</dd>
        <dt>Total Due</dt>
        <dd>
          <strong>{money(b.totalDue)}</strong>
        </dd>
      </dl>
      <ul className="fios-dash__checks">
        {b.checks.map((c) => (
          <li key={c.name} className={c.ok ? undefined : 'fin-dash__neg'}>
            {c.ok ? '✓' : '✕'} {c.name} — {c.detail}
          </li>
        ))}
      </ul>
      {url && (
        <p>
          <a href={url} target="_blank" rel="noreferrer">
            Open the PDF ↗
          </a>
        </p>
      )}
    </DetailSheet>
  );
}
