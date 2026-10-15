import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TargetCardDashboard as Data, TargetCardStatementRow } from '../api/types';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { useUrlRange } from './dash/useUrlRange';
import { inRange, nyToday, previousRange, rangeText } from '../utils/dateRange';

// Same validated pair as the ADT / 529 / Fios dashboards (dataviz validator: CVD ΔE 20).
const SPEND_COLOR = '#2A6FB0';
const SAVED_COLOR = '#C0662E';

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtYm = (ym: string) => fmtMonth(`${ym}-15`);
const pct = (n: number | null, d = 1) => (n === null ? '—' : `${n.toFixed(d)}%`);
const net = (r: { purchases: number; refunds: number }) => r.purchases - r.refunds;
/** "TARGET.COM 800-591-3869 MN" → "Target.com"; a store row → "In Store · <its location>". */
function where(desc: string): string {
  if (/TARGET\.COM|800-591-3869/i.test(desc) && !/PAY/i.test(desc)) return 'Target.com';
  if (/E-?PAY|PAYMENT/i.test(desc)) return 'Payment';
  if (/LATE ?PAYMENT ?FEE/i.test(desc)) return 'Late Payment Fee';
  if (/INTEREST/i.test(desc)) return 'Interest';
  return `In Store · ${desc.replace(/^(TARGET|CENTRAL ?CHECKOUT)\s*/i, '').trim() || desc}`;
}

function paymentText(r: TargetCardStatementRow): string {
  if (r.newBalance < -0.005) return 'Credit';
  if (r.newBalance <= 0.005) return 'Nothing Due';
  return r.dueDate ? `Due ${fmtDate(r.dueDate)}` : 'Due';
}

type Sheet =
  | { kind: 'statement'; row: TargetCardStatementRow }
  | { kind: 'spent'; title: string }
  | { kind: 'saved'; title: string }
  | { kind: 'year'; year: number };

/** Target RedCard / Circle Card — a card used only at Target. What was spent,
 * what the 5% at checkout saved (from each statement's "saved this year"),
 * the balance and AutoPay, and every statement. Tiles follow the range. */
export function TargetCardDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files, transactions } = data;
  const today = nyToday();
  const earliest = s.firstStatement ?? today;
  const [range, setRange] = useUrlRange(earliest, 'all');
  const prevR = previousRange(range);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [showAll, setShowAll] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;
  const stmtIdOf = useMemo(() => new Map(statements.map((st) => [st.periodEnd, st.id])), [statements]);
  const latest = s.latest;

  const inR = s.statements.filter((r) => inRange(r.closingDate, range));
  const inP = prevR ? s.statements.filter((r) => inRange(r.closingDate, prevR)) : [];
  const spent = inR.reduce((a, r) => a + net(r), 0);
  const spentPrev = prevR && inP.length ? inP.reduce((a, r) => a + net(r), 0) : null;
  const saved = inR.reduce((a, r) => a + (r.savings ?? 0), 0);
  const rate = spent > 0.005 ? (saved / spent) * 100 : null;
  const purchasesInR = transactions.filter((t) => t.kind === 'purchase' && inRange(t.date, range));
  const maxYear = Math.max(1, ...s.years.map((y) => y.net));
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const rows = [...inR].reverse();
  const shown = showAll ? rows : rows.slice(0, 12);
  const firstApr = s.statements.find((r) => r.apr !== null)?.apr ?? null;
  const delta = spentPrev ? (spent - spentPrev) / spentPrev : null;

  return (
    <div className="fin-dash target-dash">
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
          <InfoTip label="How the Target card is read">
            <p>Each statement in the Drive folder is read for its balance, payments, purchases (Target.com or a store), fees and interest, and the line “You’ve saved $X this year”.</p>
            <p>
              The 5% comes off at checkout — the card is charged the discounted price, so there’s nothing to redeem. <strong>Saved</strong> is what the statements print; each statement’s share is
              its year-to-date figure minus the one before it that year. Purchases after the year’s last closing (about Dec 20–31) aren’t in any year’s figure, and the gift-card-sized $15 lines may
              not earn the discount, so the rate runs a little under 5.26% (5% off the full price).
            </p>
            <p>Target only sends a statement for a month you used the card or owed a balance — empty months aren’t missing.</p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'spent', title: `Spent · ${range.label}` })}>
          <span className="fin-dash__stat-label">Spent</span>
          <span className="fin-dash__stat-value">{money(spent)}</span>
          <span className={`fin-dash__stat-sub${delta !== null && Math.abs(delta) >= 0.05 ? (delta > 0 ? ' bee-delta--down' : ' bee-delta--up') : ''}`}>
            {delta !== null && Math.abs(delta) >= 0.05 ? `${delta > 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(0)}% vs previous` : `${purchasesInR.length} purchase${purchasesInR.length === 1 ? '' : 's'}`}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'saved', title: `Saved · ${range.label}` })}>
          <span className="fin-dash__stat-label">Saved</span>
          <span className="fin-dash__stat-value">{money(saved)}</span>
          <span className="fin-dash__stat-sub">{rate !== null ? `${rate.toFixed(1)}% of spending` : '5% off at checkout'}</span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => latest && setSheet({ kind: 'statement', row: latest })}>
          <span className="fin-dash__stat-label">Balance</span>
          <span className="fin-dash__stat-value">{money(s.balance)}</span>
          <span className="fin-dash__stat-sub">
            {latest ? (s.nextDue ? `${paymentText(latest)}${s.autopayLikely ? ' · AutoPay' : ''}` : `as of ${fmtDate(latest.closingDate)}`) : '—'}
          </span>
        </button>
        <button type="button" className="fin-dash__stat" onClick={() => setSheet({ kind: 'saved', title: 'Saved by Year' })}>
          <span className="fin-dash__stat-label">Saved This Year</span>
          <span className="fin-dash__stat-value">{money(s.savingsYtd)}</span>
          <span className="fin-dash__stat-sub">{s.savingsYtdAsOf ? `as of ${fmtDate(s.savingsYtdAsOf)}` : `no statement yet · ${money(s.lifetimeSavings, false)} all-time`}</span>
        </button>
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Net Target spending (purchases − returns) by statement year, with what the statements say was saved. The current and first years are partial. Tap a year for its statements.</p>}>
            Spend &amp; Savings by Year
          </DashTitle>
          <div className="fin-dash__years">
            {[...s.years].reverse().map((y) => (
              <button type="button" key={y.year} className="fin-dash__year target-dash__year" onClick={() => setSheet({ kind: 'year', year: y.year })}>
                <span className="fin-dash__year-label">
                  {y.year}
                  {y.partial ? '*' : ''}
                </span>
                <span className="fin-dash__year-track">
                  <span className="fin-dash__year-bar" style={{ width: `${Math.max(0, (y.net / maxYear) * 100)}%`, background: SPEND_COLOR }} />
                </span>
                <span className="fin-dash__year-value">{money(y.net, false)}</span>
                <span className="target-dash__saved" style={{ color: SAVED_COLOR }}>
                  {money(y.savings)} saved
                </span>
              </button>
            ))}
          </div>
          <p className="fin-dash__stat-sub">* partial year</p>
        </section>

        {latest && (
          <section className="fin-dash__card">
            <h3 className="fin-dash__card-title">Latest Statement · {fmtDate(latest.closingDate)}</h3>
            <dl className="adt__kv">
              <dt>Balance</dt>
              <dd>
                <strong>{money(latest.newBalance)}</strong>
              </dd>
              <dt>Payment</dt>
              <dd>
                {paymentText(latest)}
                {s.nextDue && s.autopayLikely ? ' — AutoPay pays it that day' : ''}
              </dd>
              <dt>Credit Limit</dt>
              <dd>{s.creditLine !== null ? `${money(s.creditLine, false)}${s.utilization !== null ? ` · ${s.utilization.toFixed(1)}% used` : ''}` : '—'}</dd>
              <dt>Purchase APR</dt>
              <dd>{s.purchaseApr !== null ? `${s.purchaseApr}%` : '—'}</dd>
              <dt>Saved This Year</dt>
              <dd>{s.savingsYtdAsOf ? `${money(s.savingsYtd)} (as of ${fmtDate(s.savingsYtdAsOf)})` : 'No statement yet this year'}</dd>
              <dt>Next Statement</dt>
              <dd>{s.expectNext && s.nextStatementExpected ? `Around ${fmtDate(s.nextStatementExpected)}` : 'Only after you use the card'}</dd>
            </dl>
            {s.paidInFullStreak > 0 ? (
              <div className="fin-dash__gap fin-dash__gap--ok">✓ Paid in full {s.paidInFullStreak} statement{s.paidInFullStreak === 1 ? '' : 's'} in a row.</div>
            ) : (
              <div className="fin-dash__gap">
                <strong>A balance carried over</strong> — check the payment on Target.com/myCircleCard.
              </div>
            )}
          </section>
        )}

        <section className="fin-dash__card">
          <DashTitle info={<p>Patterns in the statements, recomputed with every new one.</p>}>Worth Knowing</DashTitle>
          <ul className="fios-dash__notes">
            {s.autopayLikely && <li>Every payment is the full statement balance on the due date — that’s AutoPay. Bills &amp; Due Dates treats it as Auto-Pay (change it there if not).</li>}
            {s.onlineShare !== null && (
              <li>
                {s.onlineShare}% of what you’ve put on the card was on Target.com; the rest in a store.
              </li>
            )}
            <li>
              Used in {s.activeMonths} of the months since {s.firstStatement ? fmtMonth(s.firstStatement) : '—'}
              {s.lastPurchase ? `; last purchase ${fmtDate(s.lastPurchase)}` : ''}.
            </li>
            {s.lateFees.length > 0 && (
              <li className="fios-dash__note--warn">
                {s.lateFees.map((f) => `${money(f.amount)} late fee on ${fmtDate(f.date)}`).join(', ')}
                {s.totalInterest > 0 ? ` and ${money(s.totalInterest)} interest` : ''} — the payment landed a day after the due date.
              </li>
            )}
            {firstApr !== null && s.purchaseApr !== null && firstApr !== s.purchaseApr && (
              <li>
                Purchase APR {firstApr}% → {s.purchaseApr}% (variable). It never matters while the balance is paid in full.
              </li>
            )}
            {data.gaps.missing.length > 0 && <li className="fios-dash__note--warn">Missing from Drive: {data.gaps.missing.map(fmtYm).join(', ')} (each followed a statement with a balance).</li>}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <DashTitle
              info={
                <p>
                  Tap a statement for its transactions and math. Checks: previous balance − payments + purchases + fees + interest = new balance; each section matches its rows; the balance carries
                  to the next statement; savings this year never go down.
                </p>
              }
            >
              Statements
            </DashTitle>
            {rows.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show Recent' : `Show All ${rows.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Closing</th>
                  <th>Purchases</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Saved</th>
                  <th>Math</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const st = statements.find((x) => x.periodEnd === r.closingDate);
                  const failed = st?.checks.filter((c) => !c.ok).length ?? 0;
                  return (
                    <tr key={r.closingDate} className="bee-social__row" onClick={() => setSheet({ kind: 'statement', row: r })}>
                      <td>{fmtDate(r.closingDate)}</td>
                      <td>{r.purchases ? money(r.purchases) : '—'}</td>
                      <td>{r.paid ? money(r.paid) : '—'}</td>
                      <td>{money(r.newBalance)}</td>
                      <td>{r.savings !== null ? money(r.savings) : '—'}</td>
                      <td className={failed ? 'fin-dash__neg' : undefined}>{failed ? `✕ ${failed} failed` : `✓ ${st?.checks.length ?? 0}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {shown.map((r) => (
              <li key={`c-${r.closingDate}`}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'statement', row: r })}>
                  <span className="post-card__top">
                    {fmtDate(r.closingDate)} · {r.purchases ? `${money(r.purchases)} spent` : 'no purchases'}
                    {r.savings ? ` · ${money(r.savings)} saved` : ''}
                  </span>
                  <span className="post-card__title paypal-dash__card-title">
                    <span>{paymentText(r)}</span>
                    <span>{money(r.newBalance)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">
            {s.statements.length} statement{s.statements.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
            {data.gaps.quiet.length > 0 && ` · ${data.gaps.quiet.length} months without a statement (card not used)`}
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
          row={sheet.row}
          txns={transactions.filter((t) => t.statementId === stmtIdOf.get(sheet.row.closingDate))}
          checks={statements.find((x) => x.periodEnd === sheet.row.closingDate)?.checks ?? []}
          url={fileUrl(sheet.row.fileId)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'spent' && (
        <DetailSheet title={sheet.title} sub={`${purchasesInR.length} purchases · ${money(spent)} net of returns`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...transactions]
              .filter((t) => (t.kind === 'purchase' || t.kind === 'refund') && inRange(t.date, range))
              .reverse()
              .map((t, i) => (
                <li key={i}>
                  <span>{fmtDate(t.date)}</span>
                  <span className="fios-dash__muted">{t.kind === 'refund' ? `Return · ${where(t.description)}` : where(t.description)}</span>
                  <strong className={t.amount < 0 ? 'fios-dash__credit' : undefined}>{money(t.amount)}</strong>
                </li>
              ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'saved' && (
        <DetailSheet title={sheet.title} sub={`${money(s.lifetimeSavings)} all-time · ${pct(s.savingsRate, 2)} of net spending`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...s.years].reverse().map((y) => (
              <li key={y.year}>
                <button type="button" onClick={() => setSheet({ kind: 'year', year: y.year })}>
                  <span>
                    {y.year}
                    {y.partial ? '*' : ''}
                  </span>
                  <span className="fios-dash__muted">
                    on {money(y.net)} · {pct(y.rate)}
                    {y.savingsAsOf ? ` · as of ${fmtDate(y.savingsAsOf)}` : ''}
                  </span>
                  <strong>{money(y.savings)}</strong>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">From “You’ve saved $X this year” on each statement. * partial year.</p>
        </DetailSheet>
      )}
      {sheet?.kind === 'year' &&
        (() => {
          const y = s.years.find((x) => x.year === sheet.year)!;
          const list = s.statements.filter((r) => r.closingDate.startsWith(String(sheet.year))).reverse();
          return (
            <DetailSheet title={`${sheet.year}`} sub={`${money(y.net)} spent · ${money(y.savings)} saved · ${y.statements} statements`} onClose={() => setSheet(null)}>
              <dl className="adt__kv">
                <dt>Target.com</dt>
                <dd>{money(y.online)}</dd>
                <dt>In Store</dt>
                <dd>{money(y.inStore)}</dd>
                <dt>Returns</dt>
                <dd>{money(y.refunds)}</dd>
                <dt>Fees &amp; Interest</dt>
                <dd>{money(y.fees + y.interest)}</dd>
              </dl>
              <ul className="fios-dash__sheet-list">
                {list.map((r) => (
                  <li key={r.closingDate}>
                    <button type="button" onClick={() => setSheet({ kind: 'statement', row: r })}>
                      <span>{fmtDate(r.closingDate)}</span>
                      <span className="fios-dash__muted">{r.savings !== null ? `${money(r.savings)} saved` : ''}</span>
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

function StatementSheet({
  row: r,
  txns,
  checks,
  url,
  onClose,
}: {
  row: TargetCardStatementRow;
  txns: Data['transactions'];
  checks: Data['statements'][number]['checks'];
  url: string | null;
  onClose: () => void;
}) {
  return (
    <DetailSheet title={`Statement · ${fmtDate(r.closingDate)}`} sub={`${fmtDate(r.openingDate)} – ${fmtDate(r.closingDate)} · ${paymentText(r)}`} onClose={onClose}>
      <ul className="fios-dash__sheet-list">
        {txns.length ? (
          txns.map((t, i) => (
            <li key={i}>
              <span>{fmtDate(t.date)}</span>
              <span className="fios-dash__muted">{where(t.description)}</span>
              <strong className={t.amount < 0 ? 'fios-dash__credit' : undefined}>{money(t.amount)}</strong>
            </li>
          ))
        ) : (
          <li>
            <span className="fios-dash__muted">No transactions</span>
          </li>
        )}
      </ul>
      <dl className="adt__kv">
        <dt>Previous Balance</dt>
        <dd>{money(r.previousBalance)}</dd>
        <dt>Payments</dt>
        <dd>
          {money(-r.paid)}
          {r.autopay ? ' (on the due date)' : r.paidLate ? ' (after the due date)' : ''}
        </dd>
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
        </dd>
        <dt>Saved This Year</dt>
        <dd>{r.savingsYtd !== null ? `${money(r.savingsYtd)}${r.savings ? ` (+${money(r.savings)} on this statement)` : ''}` : 'Not printed'}</dd>
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
