import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LowesCardDashboard as Data, LowesCardStatementRow, LowesItemLine } from '../api/types';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { useUrlRange } from './dash/useUrlRange';
import { inRange, nyToday, previousRange, rangeText } from '../utils/dateRange';

// Same validated pair as the Target / ADT / Fios dashboards (dataviz validator: CVD ΔE 20).
const SPEND_COLOR = '#2A6FB0';
const SAVED_COLOR = '#C0662E';
const COMPARE_RATE = 0.02;

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function statusText(s: Data['summary']): { value: string; sub: string; tone: 'ok' | 'warn' | 'plain' } {
  const l = s.latest;
  if (!l) return { value: '$0.00', sub: '—', tone: 'plain' };
  switch (s.status) {
    case 'paid':
      return { value: '$0.00', sub: l.newBalance > 0.005 ? `${money(l.newBalance)} from ${fmtMonth(l.closingDate)} paid` : 'Nothing owed', tone: 'ok' };
    case 'credit':
      return { value: money(l.newBalance), sub: 'Credit balance', tone: 'plain' };
    case 'due':
      return { value: money(l.newBalance), sub: l.dueDate ? `Due ${fmtDate(l.dueDate)}` : 'Due', tone: 'plain' };
    case 'unconfirmed':
      return { value: money(l.newBalance), sub: `Can’t confirm paid · was due ${l.dueDate ? fmtDate(l.dueDate) : '—'}`, tone: 'warn' };
    default:
      return { value: '$0.00', sub: '—', tone: 'plain' };
  }
}

type Sheet =
  | { kind: 'statement'; index: number }
  | { kind: 'purchase'; item: LowesItemLine }
  | { kind: 'spent' }
  | { kind: 'saved' }
  | { kind: 'category'; category: string }
  | { kind: 'year'; year: number }
  | { kind: 'use' };

/** Lowe's store card (Synchrony) — used a few times a year. What was bought
 * (Lowe's prints the department under each purchase), what the 5% at checkout
 * likely saved, whether each balance was paid (the payment-only statements
 * aren't kept, so proof comes from later statements or USAA Checking), and
 * whether the card is sitting idle. Tiles follow the range. */
export function LowesCardDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files, paymentLines } = data;
  const today = nyToday();
  const earliest = s.firstPurchase ?? s.firstStatement ?? today;
  const [range, setRange] = useUrlRange(earliest, 'all');
  const prevR = previousRange(range);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const latest = s.latest;

  const itemsR = s.items.filter((it) => inRange(it.date, range));
  const itemsP = prevR ? s.items.filter((it) => inRange(it.date, prevR)) : [];
  const spent = itemsR.reduce((a, it) => a + it.amount, 0);
  const spentPrev = prevR && itemsP.length ? itemsP.reduce((a, it) => a + it.amount, 0) : null;
  const saved = itemsR.reduce((a, it) => a + it.estSavings, 0);
  const buysR = itemsR.filter((it) => it.amount > 0);
  const delta = spentPrev ? (spent - spentPrev) / spentPrev : null;
  const st = statusText(s);
  const maxYear = Math.max(1, ...s.years.map((y) => y.net));
  const cats = (() => {
    const m = new Map<string, { category: string; amount: number; count: number }>();
    for (const it of buysR) {
      const c = m.get(it.category) ?? { category: it.category, amount: 0, count: 0 };
      c.amount += it.amount;
      c.count++;
      m.set(it.category, c);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  })();
  const maxCat = Math.max(1, ...cats.map((c) => c.amount));
  const checksTotal = statements.reduce((n, x) => n + x.checks.length, 0);
  const checksOk = statements.reduce((n, x) => n + x.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const rowsIdx = s.statements.map((r, i) => ({ r, i })).filter(({ r }) => inRange(r.closingDate, range)).reverse();
  const withBalance = s.statements.filter((r) => r.newBalance > 0.005).length;
  const aprMoves = s.changes.filter((c) => c.what === 'apr');
  const idleWarn = s.monthsSinceUse !== null && s.monthsSinceUse >= 9;

  return (
    <div className="fin-dash target-dash lowes-dash">
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
        <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} presets={['ytd', '1y', 'all']} />
        <span className="dash-controls__range-text">
          {rangeText(range)}
          {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
          <InfoTip label="How the Lowe’s card is read">
            <p>Each statement in the Drive folder is read for its balance, payments, fees, interest and every purchase — Lowe’s prints the department or product under each one, so you can see what was bought.</p>
            <p>
              Only months with purchases are kept in Drive. The statement Synchrony sends the month after (it just shows the payment) isn’t, so a balance counts as <strong>paid</strong> when a
              later statement opens at $0, or when USAA Checking shows a Synchrony payment for exactly that amount. Year-to-date fee totals on later statements prove no late fee hit an unkept month.
            </p>
            <p>
              <strong>Saved</strong> is an estimate: the 5% comes off at checkout (not on tax or shipping) and the statement never prints it — charged × 5/95, before 8.375% sales tax. “Vs a 2%
              card” is that minus 2% of the same spending.
            </p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'spent' })}>
          <span className="fin-dash__stat-label">Spent</span>
          <span className="fin-dash__stat-value">{money(spent)}</span>
          <span className={`fin-dash__stat-sub${delta !== null && Math.abs(delta) >= 0.05 ? (delta > 0 ? ' bee-delta--down' : ' bee-delta--up') : ''}`}>
            {delta !== null && Math.abs(delta) >= 0.05 ? `${delta > 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(0)}% vs previous` : `${buysR.length} purchase${buysR.length === 1 ? '' : 's'}`}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'saved' })}>
          <span className="fin-dash__stat-label">Saved (Est.)</span>
          <span className="fin-dash__stat-value">≈ {money(saved)}</span>
          <span className="fin-dash__stat-sub">{spent > 0.005 ? `≈ ${money(saved - spent * COMPARE_RATE)} more than a 2% card` : '5% off at checkout'}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => latest && setSheet({ kind: 'statement', index: s.statements.length - 1 })}>
          <span className="fin-dash__stat-label">Owed Now</span>
          <span className={`fin-dash__stat-value${st.tone === 'warn' ? ' fin-dash__neg' : ''}`}>{st.value}</span>
          <span className={`fin-dash__stat-sub${st.tone === 'warn' ? ' fin-dash__neg' : st.tone === 'ok' ? ' bee-delta--up' : ''}`}>{st.sub}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'use' })}>
          <span className="fin-dash__stat-label">Last Used</span>
          <span className="fin-dash__stat-value">{s.monthsSinceUse !== null ? (s.monthsSinceUse < 1 ? 'This month' : `${s.monthsSinceUse} mo ago`) : '—'}</span>
          <span className={`fin-dash__stat-sub${idleWarn ? ' fin-dash__neg' : ''}`}>{s.lastPurchase ? fmtDate(s.lastPurchase) : '—'}</span>
        </button>
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Every purchase in the range, newest first, with the department Lowe’s printed under it. Tap one for its statement and how it was paid.</p>}>What You Bought</DashTitle>
          {buysR.length ? (
            <ul className="lowes-dash__buys">
              {itemsR.map((it, i) => (
                <li key={`${it.date}-${i}`}>
                  <button type="button" className="lowes-dash__buy" onClick={() => setSheet({ kind: 'purchase', item: it })}>
                    <span className="lowes-dash__buy-date">{fmtDate(it.date)}</span>
                    <span className="lowes-dash__buy-what">
                      <strong>{it.items.length ? it.items.join(', ') : it.amount < 0 ? 'Return' : 'Purchase'}</strong>
                      <span className="fios-dash__muted">
                        {it.where}
                        {it.shipped ? ' · delivered' : ''} · {it.category}
                      </span>
                    </span>
                    <span className={`lowes-dash__buy-amt${it.amount < 0 ? ' fios-dash__credit' : ''}`}>{money(it.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fios-dash__muted">No purchases in this range.</p>
          )}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Purchases grouped by what Lowe’s printed under them (a rule list — e.g. weed control and chainsaws → Lawn &amp; Garden). Tap one for its purchases.</p>}>Where It Went</DashTitle>
          {cats.length ? (
            <div className="fin-dash__years">
              {cats.map((c) => (
                <button type="button" key={c.category} className="fin-dash__year target-dash__year lowes-dash__cat" onClick={() => setSheet({ kind: 'category', category: c.category })}>
                  <span className="fin-dash__year-label">{c.category}</span>
                  <span className="fin-dash__year-track">
                    <span className="fin-dash__year-bar" style={{ width: `${(c.amount / maxCat) * 100}%`, background: SPEND_COLOR }} />
                  </span>
                  <span className="fin-dash__year-value">{money(c.amount, false)}</span>
                  <span className="target-dash__saved fios-dash__muted">
                    {c.count} buy{c.count === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="fios-dash__muted">Nothing in this range.</p>
          )}
        </section>

        {latest && (
          <section className="fin-dash__card">
            <h3 className="fin-dash__card-title">Latest Statement · {fmtDate(latest.closingDate)}</h3>
            <dl className="adt__kv">
              <dt>Balance</dt>
              <dd>
                <strong>{money(latest.newBalance)}</strong>
              </dd>
              <dt>Due</dt>
              <dd>{latest.dueDate && latest.newBalance > 0.005 ? `${fmtDate(latest.dueDate)} · minimum ${money(latest.minimumPayment)}` : 'Nothing due'}</dd>
              <dt>Payment</dt>
              <dd className={latest.payment.status === 'unconfirmed' ? 'fin-dash__neg' : undefined}>{paymentLines[s.statements.length - 1]}</dd>
              <dt>Credit Limit</dt>
              <dd>{s.creditLine !== null ? money(s.creditLine, false) : '—'}</dd>
              <dt>Purchase APR</dt>
              <dd>{s.purchaseApr !== null ? `${s.purchaseApr}% (variable)` : '—'}</dd>
            </dl>
            {s.status === 'unconfirmed' ? (
              <div className="fin-dash__gap">
                <strong>Can’t confirm this was paid.</strong> Check{' '}
                <a href={data.template?.site ?? 'https://www.lowes.com/eservice'} target="_blank" rel="noreferrer">
                  lowes.com/eservice
                </a>
                {s.checkingLinked ? ' — no matching Synchrony payment in USAA Checking yet.' : '.'}
              </div>
            ) : s.carriedStatements.length === 0 && withBalance > 0 ? (
              <div className="fin-dash__gap fin-dash__gap--ok">
                ✓ Every balance paid in full — {s.totalFees + s.totalInterest > 0.005 ? `${money(s.totalFees + s.totalInterest)} in fees & interest` : 'never a fee or interest'}.
              </div>
            ) : null}
          </section>
        )}

        <section className="fin-dash__card">
          <DashTitle info={<p>Rule-based read of the card’s value, recomputed with every statement. Estimates are marked ≈.</p>}>Worth Knowing</DashTitle>
          <ul className="fios-dash__notes">
            <li>
              ≈ {money(s.estSavings)} saved on {money(s.lifetimeNet)} since {s.firstPurchase ? fmtMonth(s.firstPurchase) : '—'} — about {money(s.vsFlat)} {s.vsFlat >= 0 ? 'more' : 'less'} than a 2% card would
              have paid. Worth keeping for Lowe’s only; never carry a balance.
            </li>
            {s.purchaseApr !== null && (
              <li className={s.purchaseApr >= 30 ? 'fios-dash__note--warn' : undefined}>
                {s.purchaseApr}% APR{aprMoves.length ? ` (was ${aprMoves[0].from} until ${fmtMonth(aprMoves[aprMoves.length - 1].date)})` : ''} — one month of interest on a balance wipes out the 5% discount.
              </li>
            )}
            <li>
              {s.purchaseCount} purchases in {s.firstPurchase ? Math.max(1, Math.round((toMs(today) - toMs(s.firstPurchase)) / (365.25 * 86400000))) : '—'} years
              {s.avgPurchase !== null ? `, about ${money(s.avgPurchase, false)} each` : ''}
              {s.onlineShare !== null ? `; ${s.onlineShare}% online` : ''}.
            </li>
            {s.longestIdle && s.longestIdle.months >= 6 && (
              <li>
                Went {s.longestIdle.months} months unused ({fmtMonth(s.longestIdle.from)} → {fmtMonth(s.longestIdle.to)}). Synchrony can close idle store cards — that would drop{' '}
                {s.creditLine !== null ? money(s.creditLine, false) : 'the'} of available credit. A small buy once a year keeps it open.
              </li>
            )}
            {s.hiddenFees + s.hiddenInterest > 0.005 && (
              <li className="fios-dash__note--warn">
                {money(s.hiddenFees + s.hiddenInterest)} in fees/interest appears only in year-to-date totals — a statement you didn’t keep had a charge.
              </li>
            )}
            {s.promos.length > 0 && <li className="fios-dash__note--warn">Promotional (deferred-interest) balance on the latest statement: {s.promos.map((p) => `${p.type} ${money(p.balance)}`).join(', ')}.</li>}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Spending by statement year with the estimated 5% savings. Tap a year for its statements.</p>}>Spend &amp; Savings by Year</DashTitle>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <button type="button" key={y.year} className="fin-dash__year target-dash__year" onClick={() => setSheet({ kind: 'year', year: y.year })}>
                <span className="fin-dash__year-label">{y.year}</span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.net / maxYear) * 100)}%`, background: SPEND_COLOR }} />
                </span>
                <span className="fin-dash__year-value">{money(y.net, false)}</span>
                <span className="target-dash__saved" style={{ color: SAVED_COLOR }}>
                  ≈ {money(y.estSavings)} saved
                </span>
              </button>
            ))}
          </div>
          <p className="fin-dash__stat-sub">Years with no purchases have no statement in Drive.</p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <p>
                Tap a statement for its purchases, math and how it was paid. Checks: previous balance − payments + purchases + fees + interest = new balance; each section matches its rows; page 1
                matches the summary; balance types add up; year-to-date fees never go down.
              </p>
            }
          >
            Statements
          </DashTitle>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Closing</th>
                  <th>Purchases</th>
                  <th>Balance</th>
                  <th>Paid?</th>
                  <th>Math</th>
                </tr>
              </thead>
              <tbody>
                {rowsIdx.map(({ r, i }) => {
                  const failed = statements[i]?.checks.filter((c) => !c.ok).length ?? 0;
                  return (
                    <tr key={r.closingDate} className="bee-social__row" onClick={() => setSheet({ kind: 'statement', index: i })}>
                      <td>{fmtDate(r.closingDate)}</td>
                      <td>{r.purchases ? money(r.purchases) : '—'}</td>
                      <td>{money(r.newBalance)}</td>
                      <td className={r.payment.status === 'unconfirmed' || r.payment.status === 'carried' ? 'fin-dash__neg' : undefined}>{paymentLines[i]}</td>
                      <td className={failed ? 'fin-dash__neg' : undefined}>{failed ? `✕ ${failed} failed` : `✓ ${statements[i]?.checks.length ?? 0}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {rowsIdx.map(({ r, i }) => (
              <li key={`c-${r.closingDate}`}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'statement', index: i })}>
                  <span className="post-card__top">
                    {fmtDate(r.closingDate)} · {r.purchases ? `${money(r.purchases)} spent` : 'no purchases'}
                  </span>
                  <span className="post-card__title paypal-dash__card-title">
                    <span className={r.payment.status === 'unconfirmed' ? 'fin-dash__neg' : undefined}>{paymentLines[i]}</span>
                    <span>{money(r.newBalance)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">
            {s.statements.length} statement{s.statements.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
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
                  Manage My Card ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>

      {sheet?.kind === 'statement' && (
        <StatementSheet
          row={s.statements[sheet.index]}
          payLine={paymentLines[sheet.index]}
          items={s.items.filter((it) => it.statementClosing === s.statements[sheet.index].closingDate)}
          checks={statements[sheet.index]?.checks ?? []}
          url={fileUrl(s.statements[sheet.index].fileId)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'purchase' &&
        (() => {
          const it = sheet.item;
          const idx = s.statements.findIndex((r) => r.closingDate === it.statementClosing);
          return (
            <DetailSheet title={it.items.join(', ') || 'Purchase'} sub={`${fmtDate(it.date)} · ${it.where} · ${money(it.amount)}`} onClose={() => setSheet(null)}>
              <dl className="adt__kv">
                <dt>Category</dt>
                <dd>{it.category}</dd>
                <dt>Delivered</dt>
                <dd>{it.shipped ? 'Yes (freight / parcel line)' : 'No'}</dd>
                <dt>Saved (Est.)</dt>
                <dd>≈ {money(it.estSavings)}</dd>
                <dt>Statement</dt>
                <dd>{fmtDate(it.statementClosing)}</dd>
                <dt>Paid</dt>
                <dd>{idx >= 0 ? paymentLines[idx] : '—'}</dd>
              </dl>
              {idx >= 0 && (
                <p>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSheet({ kind: 'statement', index: idx })}>
                    Open the Statement
                  </button>
                </p>
              )}
            </DetailSheet>
          );
        })()}
      {sheet?.kind === 'spent' && (
        <DetailSheet title={`Spent · ${range.label}`} sub={`${buysR.length} purchases · ${money(spent)}`} onClose={() => setSheet(null)}>
          <ItemList items={itemsR} onPick={(item) => setSheet({ kind: 'purchase', item })} />
        </DetailSheet>
      )}
      {sheet?.kind === 'category' && (
        <DetailSheet title={sheet.category} sub={rangeText(range)} onClose={() => setSheet(null)}>
          <ItemList items={buysR.filter((it) => it.category === sheet.category)} onPick={(item) => setSheet({ kind: 'purchase', item })} />
        </DetailSheet>
      )}
      {sheet?.kind === 'saved' && (
        <DetailSheet title="Saved by Year (Est.)" sub={`≈ ${money(s.estSavings)} all-time · ≈ ${money(s.vsFlat)} vs a 2% card`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...s.years].reverse().map((y) => (
              <li key={y.year}>
                <button type="button" onClick={() => setSheet({ kind: 'year', year: y.year })}>
                  <span>{y.year}</span>
                  <span className="fios-dash__muted">
                    on {money(y.net)} · {y.vsFlat >= 0 ? '+' : '−'}
                    {money(Math.abs(y.vsFlat))} vs 2%
                  </span>
                  <strong>≈ {money(y.estSavings)}</strong>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">The statement never prints the discount — estimated as 5% off the pre-tax price.</p>
        </DetailSheet>
      )}
      {sheet?.kind === 'use' && (
        <DetailSheet title="Card Use" sub={`${s.purchaseCount} purchases since ${s.firstPurchase ? fmtMonth(s.firstPurchase) : '—'}`} onClose={() => setSheet(null)}>
          <dl className="adt__kv">
            <dt>Last Purchase</dt>
            <dd>{s.lastPurchase ? `${fmtDate(s.lastPurchase)} (${s.monthsSinceUse} months ago)` : '—'}</dd>
            <dt>Longest Unused</dt>
            <dd>{s.longestIdle ? `${s.longestIdle.months} months (${fmtMonth(s.longestIdle.from)} → ${fmtMonth(s.longestIdle.to)})` : '—'}</dd>
            <dt>Last 12 Months</dt>
            <dd>{money(s.last12Net)}</dd>
            <dt>Credit Limit</dt>
            <dd>{s.creditLine !== null ? money(s.creditLine, false) : '—'}</dd>
          </dl>
          <p className="fin-dash__stat-sub">A flag appears after 12 months unused — Synchrony can close store cards that sit idle.</p>
        </DetailSheet>
      )}
      {sheet?.kind === 'year' &&
        (() => {
          const y = s.years.find((x) => x.year === sheet.year)!;
          const list = s.statements.map((r, i) => ({ r, i })).filter(({ r }) => r.closingDate.startsWith(String(sheet.year))).reverse();
          return (
            <DetailSheet title={`${sheet.year}`} sub={`${money(y.net)} spent · ≈ ${money(y.estSavings)} saved · ${y.statements} statement${y.statements === 1 ? '' : 's'}`} onClose={() => setSheet(null)}>
              <dl className="adt__kv">
                <dt>Lowes.com</dt>
                <dd>{money(y.online)}</dd>
                <dt>In Store</dt>
                <dd>{money(y.inStore)}</dd>
                <dt>Fees &amp; Interest</dt>
                <dd>{money(y.fees + y.interest)}</dd>
              </dl>
              <ul className="fios-dash__sheet-list">
                {list.map(({ r, i }) => (
                  <li key={r.closingDate}>
                    <button type="button" onClick={() => setSheet({ kind: 'statement', index: i })}>
                      <span>{fmtDate(r.closingDate)}</span>
                      <span className="fios-dash__muted">{paymentLines[i]}</span>
                      <strong>{money(r.purchases)}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </DetailSheet>
          );
        })()}
    </div>
  );
}

function ItemList({ items, onPick }: { items: LowesItemLine[]; onPick: (it: LowesItemLine) => void }) {
  return (
    <ul className="fios-dash__sheet-list">
      {items.map((it, i) => (
        <li key={i}>
          <button type="button" onClick={() => onPick(it)}>
            <span>{fmtDate(it.date)}</span>
            <span className="fios-dash__muted">{it.items.join(', ') || it.where}</span>
            <strong className={it.amount < 0 ? 'fios-dash__credit' : undefined}>{money(it.amount)}</strong>
          </button>
        </li>
      ))}
    </ul>
  );
}

function StatementSheet({
  row: r,
  payLine,
  items,
  checks,
  url,
  onClose,
}: {
  row: LowesCardStatementRow;
  payLine: string;
  items: LowesItemLine[];
  checks: Data['statements'][number]['checks'];
  url: string | null;
  onClose: () => void;
}) {
  return (
    <DetailSheet title={`Statement · ${fmtDate(r.closingDate)}`} sub={`${fmtDate(r.openingDate)} – ${fmtDate(r.closingDate)} · ${payLine}`} onClose={onClose}>
      <ul className="fios-dash__sheet-list">
        {items.length ? (
          items.map((it, i) => (
            <li key={i}>
              <span>{fmtDate(it.date)}</span>
              <span className="fios-dash__muted">
                {it.items.join(', ') || 'Purchase'} · {it.where}
              </span>
              <strong className={it.amount < 0 ? 'fios-dash__credit' : undefined}>{money(it.amount)}</strong>
            </li>
          ))
        ) : (
          <li>
            <span className="fios-dash__muted">No purchases</span>
          </li>
        )}
      </ul>
      <dl className="adt__kv">
        <dt>Previous Balance</dt>
        <dd>{money(r.previousBalance)}</dd>
        {r.paid > 0.005 && (
          <>
            <dt>Payments</dt>
            <dd>{money(-r.paid)}</dd>
          </>
        )}
        {r.refunds > 0.005 && (
          <>
            <dt>Returns</dt>
            <dd>{money(-r.refunds)}</dd>
          </>
        )}
        <dt>Purchases</dt>
        <dd>{money(r.purchases)}</dd>
        {r.fees + r.interest > 0.005 && (
          <>
            <dt>Fees &amp; Interest</dt>
            <dd className="fin-dash__neg">{money(r.fees + r.interest)}</dd>
          </>
        )}
        <dt>New Balance</dt>
        <dd>
          <strong>{money(r.newBalance)}</strong>
          {r.dueDate && r.newBalance > 0.005 ? ` · due ${fmtDate(r.dueDate)}` : ''}
        </dd>
        <dt>How It Was Paid</dt>
        <dd className={r.payment.status === 'unconfirmed' || r.payment.status === 'carried' ? 'fin-dash__neg' : undefined}>{payLine}</dd>
        <dt>Purchase APR</dt>
        <dd>
          {r.apr !== null ? `${r.apr}%` : '—'}
          {r.termsNotice ? ` · change-in-terms notice${r.noticeApr ? ` (→ ${r.noticeApr}%)` : ''}` : ''}
        </dd>
        <dt>Saved (Est.)</dt>
        <dd>≈ {money(r.estSavings)}</dd>
      </dl>
      <ul className="fios-dash__checks">
        {checks.map((c) => (
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

export default LowesCardDashboard;
