import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UsaaCategory, UsaaDashboard as Data, UsaaFlow, UsaaStatementRow, UsaaTxn } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';
import { CashPlacementDetail } from './CashPlacementCard';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { useUrlRange } from './dash/useUrlRange';
import { inRange, nyToday, previousRange, rangeText } from '../utils/dateRange';

// Same validated pair as the other Finance dashboards (dataviz validator: CVD ΔE 20).
const BALANCE_COLOR = '#2A6FB0';
const AVG_COLOR = '#C0662E';

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const fmtDate = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const fmtShort = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The payee part of a description, for grouping ("ACH Withdrawal · CHASE
 * CREDIT CRD EPAY" → "CHASE CREDIT CRD EPAY"). */
const payee = (t: UsaaTxn) => {
  const rest = t.description.split(' · ')[1] ?? t.description;
  return rest.replace(/\$[\d,.]+.*$/, '').replace(/\b\d{5,}\b/g, '').replace(/\s+/g, ' ').trim() || t.description;
};

function change(now: number, prev: number | null, label: string | null, goodWhenUp: boolean): { text: string; tone: '' | 'up' | 'down' } {
  if (prev == null || label == null || !prev) return { text: '', tone: '' };
  const d = (now - prev) / Math.abs(prev);
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' };
  const good = d > 0 === goodWhenUp;
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: good ? 'up' : 'down' };
}

type Sheet =
  | { kind: 'category'; category: UsaaCategory; dir: 'in' | 'out' }
  | { kind: 'flows'; title: string; dir: 'in' | 'out' | 'net' }
  | { kind: 'txns'; title: string; sub?: string; txns: UsaaTxn[] }
  | { kind: 'statement'; st: UsaaStatementRow }
  | { kind: 'balance' };

/** USAA Classic Checking — Mike's main checking account: balance and how it
 * moves, where money comes from and goes (rule-based categories), card
 * payments, recurring payments, Cash Placement, and every statement with its
 * math. Tiles follow the range picker (statement periods ending in range). */
export function UsaaDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files, transactions } = data;
  const today = nyToday();
  const earliest = s.firstStatement ?? today;
  const [range, setRange] = useUrlRange(earliest, '1y');
  const prevR = previousRange(range);
  const pl = prevR ? 'previous' : null;
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'' | UsaaCategory>('');
  const [showTx, setShowTx] = useState(50);
  const [showAllStmts, setShowAllStmts] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;

  const flowsR = s.flows.filter((f) => inRange(f.date, range));
  const flowsP = prevR ? s.flows.filter((f) => inRange(f.date, prevR)) : [];
  const totals = (fl: UsaaFlow[]) => ({
    in: sum(fl.map((f) => f.moneyIn)),
    out: sum(fl.map((f) => f.moneyOut)),
    interest: sum(fl.map((f) => f.interest)),
    tin: sum(fl.map((f) => f.transfersIn)),
    tout: sum(fl.map((f) => f.transfersOut)),
  });
  const T = totals(flowsR);
  const P = flowsP.length ? totals(flowsP) : null;
  const net = T.in - T.out + T.interest;
  const stmtsR = statements.filter((st) => inRange(st.periodEnd, range));
  const avgR = stmtsR.length ? sum(stmtsR.map((st) => st.avgDailyBalance ?? st.ending)) / stmtsR.length : null;
  const lowR = stmtsR.reduce<UsaaStatementRow | null>((lo, st) => (st.lowBalance !== null && (!lo || st.lowBalance < (lo.lowBalance ?? Infinity)) ? st : lo), null);

  // Categories in range: in and out separately (signed totals per statement).
  const catRows = useMemo(() => {
    const m = new Map<UsaaCategory, { in: number; out: number }>();
    for (const f of s.flows.filter((x) => inRange(x.date, range))) {
      for (const [k, v] of Object.entries(f.byCategory) as [UsaaCategory, number][]) {
        const row = m.get(k) ?? { in: 0, out: 0 };
        if (v >= 0) row.in += v;
        else row.out -= v;
        m.set(k, row);
      }
    }
    return data.categories.filter((c) => m.has(c)).map((c) => ({ category: c, ...m.get(c)! }));
  }, [s.flows, range, data.categories]);
  const maxCat = Math.max(1, ...catRows.map((r) => Math.max(r.in, r.out)));

  const series = useMemo<LineSeries[]>(() => {
    const rows = s.series.filter((p) => inRange(p.date, range));
    return [
      { name: 'Statement Balance', color: BALANCE_COLOR, points: rows.map((p) => ({ x: toMs(p.date), y: p.balance })) },
      { name: 'Average Daily Balance', color: AVG_COLOR, points: rows.filter((p) => p.avg !== null).map((p) => ({ x: toMs(p.date), y: p.avg! })) },
    ];
  }, [s.series, range]);

  // Calendar-year totals (by statement end).
  const years = useMemo(() => {
    const m = new Map<number, { year: number; in: number; out: number; interest: number; statements: number }>();
    for (const f of s.flows) {
      const y = Number(f.date.slice(0, 4));
      const row = m.get(y) ?? { year: y, in: 0, out: 0, interest: 0, statements: 0 };
      row.in += f.moneyIn;
      row.out += f.moneyOut;
      row.interest += f.interest;
      row.statements++;
      m.set(y, row);
    }
    return [...m.values()].sort((a, b) => b.year - a.year);
  }, [s.flows]);
  const maxYear = Math.max(1, ...years.map((y) => Math.max(y.in, y.out)));

  const txR = transactions.filter((t) => inRange(t.date, range));
  const txCovered = !data.transactionsSince || range.from > data.transactionsSince;
  const txFiltered = [...txR]
    .reverse()
    .filter((t) => (!cat || t.category === cat) && (!q || t.description.toLowerCase().includes(q.toLowerCase())));
  const checksTotal = statements.reduce((n, st) => n + st.checkCount, 0);
  const checksOk = statements.reduce((n, st) => n + st.checkOk, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const stmtList = [...stmtsR].reverse();
  const stmtShown = showAllStmts ? stmtList : stmtList.slice(0, 12);
  const eventsR = s.events.filter((e) => inRange(e.date, range));

  const tile = (label: string, value: string, sub: React.ReactNode, onClick: () => void, negative = false) => (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className={`fin-dash__stat-value${negative ? ' fin-dash__neg' : ''}`}>{value}</span>
      <span className="fin-dash__stat-sub">{sub}</span>
    </button>
  );
  const delta = (now: number, prev: number | null, goodUp: boolean, fallback: string) => {
    const c = change(now, prev, pl, goodUp);
    return <span className={c.tone === 'up' ? 'bee-delta--up' : c.tone === 'down' ? 'bee-delta--down' : undefined}>{c.text || fallback}</span>;
  };

  return (
    <div className="fin-dash usaa-dash">
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
          <InfoTip label="How USAA checking is read">
            <p>Every monthly statement in the Drive folder is read and checked by arithmetic (summary, row totals, running and end-of-day balances). Tiles count statements that end inside the range.</p>
            <p>
              <strong>Money in</strong> is deposits from outside your accounts (pay, Venmo, sportsbook cash-outs…). <strong>Money out</strong> is spending, card payments and fees.{' '}
              <strong>Transfers</strong> between your own accounts (USAA savings, Ally, Amex savings, Robinhood, PayPal) are kept separate so they don’t inflate either side.
            </p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        {tile(
          'Balance',
          money(s.balance),
          s.asOf ? `${fmtDate(s.asOf)}${avgR !== null ? ` · avg ${money(avgR, false)}` : ''}${lowR?.lowBalance != null ? ` · low ${money(lowR.lowBalance, false)}` : ''}` : '—',
          () => setSheet({ kind: 'balance' }),
          s.balance < 0
        )}
        {tile('Money In', money(T.in), delta(T.in, P?.in ?? null, true, `${flowsR.length} statement${flowsR.length === 1 ? '' : 's'}`), () => setSheet({ kind: 'flows', title: `Money In · ${range.label}`, dir: 'in' }))}
        {tile('Money Out', money(T.out), delta(T.out, P?.out ?? null, false, `${money(T.tout, false)} moved to your accounts`), () => setSheet({ kind: 'flows', title: `Money Out · ${range.label}`, dir: 'out' }))}
        {tile('Net', money(net), `${net >= 0 ? 'kept' : 'drew down'} · transfers ${money(T.tin - T.tout, false)}`, () => setSheet({ kind: 'flows', title: `Net · ${range.label}`, dir: 'net' }), net < 0)}
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>The balance on each statement date, and the average of every day’s closing balance in that statement period (time-weighted).</p>}>Balance Over Time</DashTitle>
          <FinanceLineChart series={series} formatY={(v) => money(v, false)} formatX={fmtShort} ariaLabel="USAA checking statement balance and average daily balance over time" />
        </section>

        {s.recurring.length > 0 && (
          <section className="fin-dash__card">
            <DashTitle info={<p>Payees paid in at least 3 of the last 6 statements (card payments grouped by issuer). Sportsbooks, ATM and checks are left out.</p>}>Recurring Payments</DashTitle>
            <ul className="ally__recurring">
              {s.recurring.map((r) => (
                <li key={r.payee}>
                  <span className="ally__recurring-day">{ordinal(r.typicalDay)}</span>
                  <span className="ally__recurring-name">{r.payee}</span>
                  <span className="ally__recurring-amt" title={`Last paid ${fmtDate(r.lastDate)} · in ${r.months} of the last 6 statements`}>
                    {money(r.lastAmount)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Every transaction sorted by rule (payee words). Tap a row to see the payees and transactions behind it{txCovered ? '' : ' — transactions go back 2 years; older ranges show totals only'}.</p>}>
            Where Money Comes From &amp; Goes
          </DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table usaa-dash__cats">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>In</th>
                  <th />
                  <th>Out</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {catRows.map((r) => (
                  <tr key={r.category} className="bee-social__row" onClick={() => setSheet({ kind: 'category', category: r.category, dir: r.out >= r.in ? 'out' : 'in' })}>
                    <td>{r.category}</td>
                    <td>{r.in >= 0.5 ? money(r.in, false) : '—'}</td>
                    <td className="ally__flow-cell">{r.in >= 0.5 && <span className="ally__flow-bar ally__flow-bar--in" style={{ width: `${(r.in / maxCat) * 100}%` }} />}</td>
                    <td>{r.out >= 0.5 ? money(r.out, false) : '—'}</td>
                    <td className="ally__flow-cell">{r.out >= 0.5 && <span className="ally__flow-bar ally__flow-bar--out" style={{ width: `${(r.out / maxCat) * 100}%` }} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {s.issuers.length > 0 && (
          <section className="fin-dash__card">
            <DashTitle info={<p>Credit card payments from checking over the last 12 months, by card issuer. Tap one for its payments.</p>}>Card Payments · 12 Months</DashTitle>
            <ul className="fios-dash__sheet-list">
              {s.issuers.map((i) => (
                <li key={i.issuer}>
                  <button
                    type="button"
                    onClick={() =>
                      setSheet({
                        kind: 'txns',
                        title: `${i.issuer} Payments`,
                        sub: `${i.count} in 12 months · ${money(i.total)}`,
                        txns: [...transactions].reverse().filter((t) => t.category === 'Card Payments' && payee(t).toUpperCase().includes(issuerWord(i.issuer))),
                      })
                    }
                  >
                    <span>{i.issuer}</span>
                    <span className="fios-dash__muted">
                      {i.count} payment{i.count === 1 ? '' : 's'} · last {money(i.lastAmount)} on {fmtDate(i.lastDate)}
                    </span>
                    <strong>{money(i.total, false)}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.cashPlacement && <CashPlacementDetail bank={data.cashPlacement.bank} suggestions={data.cashPlacement.suggestions} rules={data.cashPlacement.rules} />}

        <section className="fin-dash__card">
          <DashTitle info={<p>Money in and out by calendar year (statement date). Transfers between your own accounts and interest aren’t included. The current year is year to date.</p>}>By Year</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>In</th>
                  <th>Out</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr
                    key={y.year}
                    className="bee-social__row"
                    onClick={() => setRange({ key: 'custom', from: `${y.year}-01-01`, to: y.year === Number(today.slice(0, 4)) ? today : `${y.year}-12-31`, label: String(y.year) })}
                  >
                    <td>{y.year}</td>
                    <td>{money(y.in, false)}</td>
                    <td>{money(y.out, false)}</td>
                    <td className="ally__flow-cell">
                      <span className="ally__flow-bar ally__flow-bar--out" style={{ width: `${(y.out / maxYear) * 100}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__stat-sub">Tap a year to set the range to it.</p>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Interest is credited on the statement date, so the statement year is the tax year. USAA sends a 1099-INT only for $10 or more.</p>}>Interest</DashTitle>
          <dl className="adt__kv">
            <dt>APY Earned</dt>
            <dd>{s.apy !== null ? `${s.apy.toFixed(2)}%` : '—'}</dd>
            <dt>This Year</dt>
            <dd>{money(s.interestYtd)}</dd>
            <dt>Since {s.firstStatement ? fmtMonth(s.firstStatement) : '—'}</dt>
            <dd>{money(s.interestLifetime)}</dd>
          </dl>
          <p className="fin-dash__stat-sub">
            {[...s.interestYears]
              .reverse()
              .slice(0, 6)
              .map((y) => `${y.year} ${money(y.total)}`)
              .join(' · ')}
          </p>
        </section>

        {eventsR.length > 0 && (
          <section className="fin-dash__card">
            <DashTitle info={<p>Fees, returned payments and days the balance went negative, in range.</p>}>Fees &amp; Overdrafts</DashTitle>
            <ul className="fios-dash__sheet-list">
              {[...eventsR].reverse().map((e, i) => (
                <li key={`${e.date}-${i}`}>
                  <span>{e.kind === 'overdrawn' ? 'Balance went negative' : e.description}</span>
                  <span className="fios-dash__muted">{fmtDate(e.date)}</span>
                  <strong className="fin-dash__neg">{money(e.amount)}</strong>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <DashTitle info={<p>Transactions in range{data.transactionsSince ? ` (the last 2 years are loaded — since ${fmtDate(data.transactionsSince)})` : ''}. Search matches the description.</p>}>Transactions</DashTitle>
            <div className="ally__txn-tools">
              <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search transactions" />
              <select value={cat} onChange={(e) => setCat(e.target.value as UsaaCategory | '')} aria-label="Category">
                <option value="">All Categories</option>
                {data.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <TxnList txns={txFiltered.slice(0, showTx)} />
          {txFiltered.length > showTx && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowTx((n) => n + 100)}>
              Show More ({txFiltered.length - showTx} left)
            </button>
          )}
          {!txCovered && <p className="fin-dash__stat-sub">Older transactions aren’t loaded here — open a statement below to see its rows.</p>}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <DashTitle
              info={
                <p>
                  Tap a statement for its math and transactions. Checks: summary adds up, rows add up to the printed totals, running (or end-of-day) balances match, and each statement starts where the last
                  ended.
                </p>
              }
            >
              Statements
            </DashTitle>
            {stmtList.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAllStmts((v) => !v)}>
                {showAllStmts ? 'Show Recent' : `Show All ${stmtList.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Balance</th>
                  <th>Lowest Day</th>
                  <th>Math</th>
                </tr>
              </thead>
              <tbody>
                {stmtShown.map((st) => {
                  const failed = st.checkCount - st.checkOk;
                  return (
                    <tr key={st.id} className="bee-social__row" onClick={() => setSheet({ kind: 'statement', st })}>
                      <td>{fmtDate(st.periodEnd)}</td>
                      <td>{money(st.credits)}</td>
                      <td>{money(st.debits)}</td>
                      <td className={st.ending < 0 ? 'fin-dash__neg' : undefined}>{money(st.ending)}</td>
                      <td className={(st.lowBalance ?? 0) < 0 ? 'fin-dash__neg' : undefined}>{st.lowBalance !== null ? money(st.lowBalance) : '—'}</td>
                      <td>{failed ? `✕ ${failed} failed` : `✓ ${st.checkCount}/${st.checkCount}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {stmtShown.map((st) => (
              <li key={`c-${st.id}`}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'statement', st })}>
                  <span className="post-card__top">
                    {fmtDate(st.periodEnd)} · in {money(st.credits, false)} · out {money(st.debits, false)}
                  </span>
                  <span className="post-card__title paypal-dash__card-title">
                    <span>Balance</span>
                    <span className={st.ending < 0 ? 'fin-dash__neg' : undefined}>{money(st.ending)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">
            {statements.length} statement{statements.length === 1 ? '' : 's'} read · {checksOk}/{checksTotal} math checks passed
            {notRead > 0 && ` · ${notRead} file(s) not read`}
            {s.gaps.length > 0 && ` · ${s.gaps.length} month${s.gaps.length === 1 ? '' : 's'} missing`}
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
                  usaa.com ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>

      {sheet?.kind === 'balance' && (
        <DetailSheet title="Balance by Statement" sub={`${stmtsR.length} statements · ${rangeText(range)}`} onClose={() => setSheet(null)}>
          <ul className="fios-dash__sheet-list">
            {[...stmtsR].reverse().map((st) => (
              <li key={st.id}>
                <button type="button" onClick={() => setSheet({ kind: 'statement', st })}>
                  <span>{fmtDate(st.periodEnd)}</span>
                  <span className="fios-dash__muted">
                    avg {st.avgDailyBalance !== null ? money(st.avgDailyBalance, false) : '—'} · low {st.lowBalance !== null ? money(st.lowBalance, false) : '—'}
                    {st.lowDate ? ` (${fmtDate(st.lowDate)})` : ''}
                  </span>
                  <strong className={st.ending < 0 ? 'fin-dash__neg' : undefined}>{money(st.ending)}</strong>
                </button>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'flows' && (
        <DetailSheet
          title={sheet.title}
          sub={sheet.dir === 'in' ? money(T.in) : sheet.dir === 'out' ? money(T.out) : `${money(T.in)} in − ${money(T.out)} out + ${money(T.interest)} interest`}
          onClose={() => setSheet(null)}
        >
          <ul className="fios-dash__sheet-list">
            {catRows
              .filter((r) => (sheet.dir === 'in' ? r.in > 0 && r.category !== 'Transfers' && r.category !== 'Interest' : sheet.dir === 'out' ? r.out > 0 && r.category !== 'Transfers' : r.category !== 'Transfers'))
              .sort((a, b) => (sheet.dir === 'in' ? b.in - a.in : sheet.dir === 'out' ? b.out - a.out : b.in - b.out - (a.in - a.out)))
              .map((r) => (
                <li key={r.category}>
                  <button type="button" onClick={() => setSheet({ kind: 'category', category: r.category, dir: sheet.dir === 'in' ? 'in' : 'out' })}>
                    <span>{r.category}</span>
                    <span className="fios-dash__muted">{sheet.dir === 'net' ? `in ${money(r.in, false)} · out ${money(r.out, false)}` : ''}</span>
                    <strong>{money(sheet.dir === 'in' ? r.in : sheet.dir === 'out' ? r.out : r.in - r.out, false)}</strong>
                  </button>
                </li>
              ))}
          </ul>
          <h4 className="usaa-dash__sheet-head">By Statement</h4>
          <ul className="fios-dash__sheet-list">
            {[...flowsR].reverse().map((f) => (
              <li key={f.date}>
                <span>{fmtDate(f.date)}</span>
                <span className="fios-dash__muted">
                  in {money(f.moneyIn, false)} · out {money(f.moneyOut, false)}
                  {f.transfersIn || f.transfersOut ? ` · transfers ${money(f.transfersIn - f.transfersOut, false)}` : ''}
                </span>
                <strong>{money(sheet.dir === 'in' ? f.moneyIn : sheet.dir === 'out' ? f.moneyOut : f.net, false)}</strong>
              </li>
            ))}
          </ul>
        </DetailSheet>
      )}
      {sheet?.kind === 'category' && <CategorySheet category={sheet.category} txns={txR.filter((t) => t.category === sheet.category)} rows={catRows} covered={txCovered} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'txns' && (
        <DetailSheet title={sheet.title} sub={sheet.sub} onClose={() => setSheet(null)}>
          <TxnList txns={sheet.txns} />
        </DetailSheet>
      )}
      {sheet?.kind === 'statement' && (
        <StatementSheet st={sheet.st} url={fileUrl(sheet.st.fileId)} txns={transactions.filter((t) => (sheet.st.era === 'modern' ? t.date >= sheet.st.periodStart : t.date > sheet.st.periodStart) && t.date <= sheet.st.periodEnd).reverse()} loaded={!data.transactionsSince || sheet.st.periodStart >= data.transactionsSince} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/** The word that identifies an issuer in the payee text. */
function issuerWord(issuer: string): string {
  const map: Record<string, string> = {
    Chase: 'CHASE',
    'American Express': 'AMEX',
    'Bank of America': 'BK OF AMER',
    Discover: 'DISCOVER',
    'Wells Fargo': 'WELLS FARGO',
    'Cardmember Service': 'CARDMEMBER',
    'U.S. Bank': 'BANK WEB',
    Target: 'TARGET',
    'Capital One': 'CAP',
    Barclaycard: 'BARCLAY',
    Citi: 'CITI',
    'USAA Credit Card': 'CREDIT CARD ENDING',
    'Home Depot': 'HOME DEPOT',
    'Synchrony (Lowe’s)': 'SYF',
    'Kohl’s': 'KOHL',
    'Credit Card (web payment)': 'CREDIT CARD WEB',
  };
  return map[issuer] ?? issuer.toUpperCase();
}

function TxnList({ txns }: { txns: UsaaTxn[] }) {
  if (!txns.length) return <p className="fin-dash__stat-sub">No transactions.</p>;
  return (
    <ul className="fios-dash__sheet-list">
      {txns.map((t, i) => (
        <li key={`${t.date}-${i}`}>
          <span>{t.description}</span>
          <span className="fios-dash__muted">
            {fmtDate(t.date)} · {t.category}
          </span>
          <strong className={t.amount > 0 ? 'fios-dash__credit' : undefined}>{money(t.amount)}</strong>
        </li>
      ))}
    </ul>
  );
}

function CategorySheet({ category, txns, rows, covered, onClose }: { category: UsaaCategory; txns: UsaaTxn[]; rows: { category: UsaaCategory; in: number; out: number }[]; covered: boolean; onClose: () => void }) {
  const r = rows.find((x) => x.category === category);
  const groups = new Map<string, { name: string; in: number; out: number; count: number; last: string }>();
  for (const t of txns) {
    const name = payee(t);
    const g = groups.get(name) ?? { name, in: 0, out: 0, count: 0, last: t.date };
    if (t.amount >= 0) g.in += t.amount;
    else g.out -= t.amount;
    g.count++;
    if (t.date > g.last) g.last = t.date;
    groups.set(name, g);
  }
  const list = [...groups.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
  return (
    <DetailSheet title={category} sub={r ? `in ${money(r.in)} · out ${money(r.out)}` : undefined} onClose={onClose}>
      {!covered && <p className="fin-dash__stat-sub">Payees below cover the last 2 years only; the totals above cover the whole range.</p>}
      <h4 className="usaa-dash__sheet-head">Payees</h4>
      <ul className="fios-dash__sheet-list">
        {list.slice(0, 30).map((g) => (
          <li key={g.name}>
            <span>{g.name}</span>
            <span className="fios-dash__muted">
              {g.count}× · last {fmtDate(g.last)}
              {g.in && g.out ? ` · in ${money(g.in, false)} · out ${money(g.out, false)}` : ''}
            </span>
            <strong className={g.in > g.out ? 'fios-dash__credit' : undefined}>{money(g.in - g.out, false)}</strong>
          </li>
        ))}
      </ul>
      <h4 className="usaa-dash__sheet-head">Transactions</h4>
      <TxnList txns={[...txns].reverse().slice(0, 200)} />
    </DetailSheet>
  );
}

function StatementSheet({ st, url, txns, loaded, onClose }: { st: UsaaStatementRow; url: string | null; txns: UsaaTxn[]; loaded: boolean; onClose: () => void }) {
  return (
    <DetailSheet title={`Statement · ${fmtDate(st.periodEnd)}`} sub={`${fmtDate(st.periodStart)} – ${fmtDate(st.periodEnd)}`} onClose={onClose}>
      <dl className="adt__kv">
        <dt>Beginning</dt>
        <dd>{money(st.beginning)}</dd>
        <dt>Deposits &amp; Credits</dt>
        <dd>{money(st.credits)}</dd>
        <dt>Withdrawals &amp; Debits</dt>
        <dd>{money(st.debits)}</dd>
        <dt>Ending</dt>
        <dd>
          <strong>{money(st.ending)}</strong>
        </dd>
        <dt>Average Daily</dt>
        <dd>{st.avgDailyBalance !== null ? money(st.avgDailyBalance) : '—'}</dd>
        <dt>Lowest Day</dt>
        <dd>{st.lowBalance !== null ? `${money(st.lowBalance)}${st.lowDate ? ` · ${fmtDate(st.lowDate)}` : ''}` : '—'}</dd>
        <dt>Interest</dt>
        <dd>
          {money(st.interest)}
          {st.apy !== null ? ` · ${st.apy.toFixed(2)}% APY` : ''}
        </dd>
      </dl>
      <ul className="fios-dash__checks">
        {st.checks.map((c) => (
          <li key={c.name} className={c.ok ? undefined : 'fin-dash__neg'}>
            {c.ok ? '✓' : '✕'} {c.name} — {c.detail}
          </li>
        ))}
        {st.checks.length < st.checkCount && <li>✓ {st.checkOk} of {st.checkCount} checks passed</li>}
      </ul>
      {url && (
        <p>
          <a href={url} target="_blank" rel="noreferrer">
            Open the PDF ↗
          </a>
        </p>
      )}
      <h4 className="usaa-dash__sheet-head">Transactions</h4>
      {loaded ? <TxnList txns={txns} /> : <p className="fin-dash__stat-sub">Older than 2 years — open the PDF for its rows.</p>}
    </DetailSheet>
  );
}
