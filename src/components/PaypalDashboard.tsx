import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PaypalActivity, PaypalClass, PaypalDashboard as Data } from '../api/types';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { useUrlRange } from './dash/useUrlRange';
import { inRange, nyToday, previousRange, rangeText } from '../utils/dateRange';
import type { DateRange } from '../utils/dateRange';

const money = (n: number, cents = true) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const toDate = (iso: string) => new Date(`${iso.length === 7 ? `${iso}-15` : iso}T12:00:00`);
const fmtDate = (iso: string) => toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso: string) => toDate(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const SPEND: PaypalClass[] = ['purchase', 'payment'];
const IN: PaypalClass[] = ['received', 'reward'];
const CLASS_LABEL: Record<PaypalClass, string> = {
  purchase: 'Store',
  payment: 'Sent',
  received: 'Received',
  refund: 'Refund',
  reward: 'PayPal Credit',
  withdrawal: 'To Bank',
  add_funds: 'Added Funds',
  funding: 'Funding',
  card_return: 'Back to Card',
};
type Filter = 'all' | 'stores' | 'people' | 'in' | 'refunds' | 'bank';
const FILTERS: [Filter, string][] = [
  ['all', 'All Activity'],
  ['stores', 'Stores'],
  ['people', 'Sent to People'],
  ['in', 'Received'],
  ['refunds', 'Refunds'],
  ['bank', 'To Bank'],
];
const matchesFilter = (a: PaypalActivity, f: Filter) =>
  f === 'all' ||
  (f === 'stores' && a.cls === 'purchase') ||
  (f === 'people' && a.cls === 'payment') ||
  (f === 'in' && IN.includes(a.cls)) ||
  (f === 'refunds' && a.cls === 'refund') ||
  (f === 'bank' && (a.cls === 'withdrawal' || a.cls === 'add_funds'));

type Sheet = { kind: 'tile'; filter: Filter; title: string } | { kind: 'row'; row: PaypalActivity } | { kind: 'party'; name: string; people: boolean } | { kind: 'source'; label: string };

interface Totals {
  spent: number;
  received: number;
  refunds: number;
  withdrawn: number;
  fees: number;
  count: number;
}
function totalsOf(xs: PaypalActivity[]): Totals {
  const usd = xs.filter((a) => a.currency === 'USD');
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    spent: r2(usd.filter((a) => SPEND.includes(a.cls)).reduce((s, a) => s - a.amount, 0)),
    received: r2(usd.filter((a) => IN.includes(a.cls)).reduce((s, a) => s + a.amount, 0)),
    refunds: r2(usd.filter((a) => a.cls === 'refund' && a.amount > 0).reduce((s, a) => s + a.amount, 0)),
    withdrawn: r2(usd.filter((a) => a.cls === 'withdrawal').reduce((s, a) => s - a.total, 0)),
    fees: r2(usd.reduce((s, a) => s - a.fee, 0)),
    count: usd.filter((a) => SPEND.includes(a.cls) || IN.includes(a.cls)).length,
  };
}
function change(now: number, prev: number | null, label: string | null, invert = false): { text: string; tone: '' | 'up' | 'down' } {
  if (prev == null || label == null) return { text: '', tone: '' };
  if (!prev) return now ? { text: `new vs ${label}`, tone: invert ? 'down' : 'up' } : { text: '', tone: '' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: d > 0 !== invert ? 'up' : 'down' };
}
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** PayPal — a pass-through payment app (Mike, 2026-10-12): who he paid and
 * who paid him, which card or bank funded it (card-funded rows matched to
 * the card statements), subscriptions, withdrawals and fees. Tiles follow
 * the range picker; every tile and row opens a detail sheet. */
export function PaypalDashboard({ data, onDismissFlag }: { data: Data; onDismissFlag: (id: string) => void }) {
  const { summary: s, statements, files } = data;
  const earliest = s.activity[0]?.date ?? s.firstStatement ?? nyToday();
  const [range, setRange] = useUrlRange(earliest, '1y');
  const today = nyToday();
  const prevR = previousRange(range);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);
  const [allStmts, setAllStmts] = useState(false);
  const fileUrl = (fileId: string) => files.find((f) => f.fileId === fileId)?.url ?? null;

  /** "Card (PayPal doesn't say which)" → the matched card, when known. */
  const fundedBy = (a: PaypalActivity) => {
    const m = a.id ? data.cards.paidBy[a.id] : undefined;
    return a.fundedBy.map((f) => (m && /^Card\b/.test(f) ? m.card : f));
  };

  const inR = useMemo(() => s.activity.filter((a) => inRange(a.date, range)), [s.activity, range]);
  const inPrev = useMemo(() => (prevR ? s.activity.filter((a) => inRange(a.date, prevR)) : null), [s.activity, prevR]);
  const t = totalsOf(inR);
  const p = inPrev ? totalsOf(inPrev) : null;
  const pl = prevR?.label ?? null;

  const stores = useMemo(
    () =>
      groupBy(
        inR.filter((a) => a.cls === 'purchase' || a.cls === 'refund'),
        (a) => -a.amount,
      ).filter((g) => g.count > 0),
    [inR],
  );
  const people = useMemo(() => {
    const peopleNames = new Set(s.people.map((x) => nameKey(x.name)));
    return groupBy(
      inR.filter((a) => (a.cls === 'payment' || a.cls === 'received') && peopleNames.has(nameKey(a.name))),
      (a) => a.amount,
    );
  }, [inR, s.people]);
  const sources = useMemo(() => {
    const m = new Map<string, { label: string; total: number; count: number }>();
    for (const a of inR.filter((x) => SPEND.includes(x.cls) && x.currency === 'USD')) {
      for (const f of fundedBy(a)) {
        const cur = m.get(f) ?? { label: f, total: 0, count: 0 };
        cur.count++;
        cur.total += a.fundedBy.length === 1 ? -a.amount : 0;
        m.set(f, cur);
      }
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inR, data.cards]);
  const months = useMemo(() => s.months.filter((m) => m.month >= range.from.slice(0, 7) && m.month <= range.to.slice(0, 7)), [s.months, range]);
  const byYear = months.length > 24;
  const chartRows = byYear
    ? s.years
        .filter((y) => String(y.year) >= range.from.slice(0, 4) && String(y.year) <= range.to.slice(0, 4))
        .map((y) => ({ key: String(y.year), label: String(y.year), value: y.purchases + y.payments }))
    : months.map((m) => ({ key: m.month, label: fmtMonth(m.month), value: m.spent }));

  const q = query.trim().toLowerCase();
  const rows = [...inR]
    .reverse()
    .filter(
      (a) =>
        matchesFilter(a, filter) && (!q || a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) || money(a.amount).includes(q) || fundedBy(a).some((f) => f.toLowerCase().includes(q))),
    );
  const checksTotal = statements.reduce((n, st) => n + st.checks.length, 0);
  const checksOk = statements.reduce((n, st) => n + st.checks.filter((c) => c.ok).length, 0);
  const notRead = files.filter((f) => f.status !== 'parsed' && f.status !== 'skipped' && f.status !== 'duplicate').length;
  const stmtsDesc = [...statements].reverse();
  const activeSubs = s.subscriptions.filter((x) => x.active);

  return (
    <div className="fin-dash paypal-dash">
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
        <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} />
        <span className="dash-controls__range-text">
          {rangeText(range)}
          {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
          <InfoTip label="How PayPal works here">
            <p>
              PayPal is a pass-through: a payment is funded by a card or bank at the moment you pay, and money you receive is withdrawn to the bank — so the balance is almost always $0 and it counts
              toward Household only when money is sitting there.
            </p>
            <p>
              “Card” rows are PayPal’s General Credit Card Deposits — PayPal doesn’t print which card. They’re matched to your card statements by amount and date (0–5 days later) when that card is
              live in Finance.
            </p>
            <p>PayPal only sends a statement for a month with activity, so a missing month is only flagged when a card shows PayPal charges for it.</p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats fin-dash__stats--5">
        <Tile
          label="Paid Out"
          value={money(t.spent)}
          c={change(t.spent, p?.spent ?? null, pl, true)}
          fallback={`${inR.filter((a) => SPEND.includes(a.cls)).length} payments`}
          onClick={() => setSheet({ kind: 'tile', filter: 'all', title: 'Paid Out' })}
        />
        <Tile
          label="Received"
          value={money(t.received)}
          c={change(t.received, p?.received ?? null, pl)}
          fallback="people, businesses, credits"
          onClick={() => setSheet({ kind: 'tile', filter: 'in', title: 'Received' })}
        />
        <Tile
          label="Refunds"
          value={money(t.refunds)}
          c={change(t.refunds, p?.refunds ?? null, pl)}
          fallback="back to you"
          onClick={() => setSheet({ kind: 'tile', filter: 'refunds', title: 'Refunds' })}
        />
        <Tile
          label="To Bank"
          value={money(t.withdrawn)}
          c={change(t.withdrawn, p?.withdrawn ?? null, pl)}
          fallback="withdrawn"
          onClick={() => setSheet({ kind: 'tile', filter: 'bank', title: 'Withdrawn to Bank' })}
        />
        <Tile
          label="PayPal Fees"
          value={money(t.fees)}
          c={change(t.fees, p?.fees ?? null, pl, true)}
          fallback={s.balancePrinted ? `Balance ${money(s.balance)}` : 'on money received'}
          onClick={() => setSheet({ kind: 'tile', filter: 'in', title: 'Fees (on money received)' })}
        />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--wide">
          <DashTitle info={<p>Stores plus money sent to people, by {byYear ? 'year' : 'month'} of the payment. Funding rows (the card or bank charge behind each payment) aren’t counted twice.</p>}>
            Paid Out by {byYear ? 'Year' : 'Month'}
          </DashTitle>
          <Bars rows={chartRows} empty="Nothing paid through PayPal in this range." />
        </section>

        <section className="fin-dash__card">
          <DashTitle
            info={
              <p>
                Active = charged within ~40 days of the latest statement. A subscription is a PayPal “Subscription Payment”, or the same price charged on a monthly or yearly schedule at least 3 times.
              </p>
            }
          >
            Subscriptions
          </DashTitle>
          {s.subscriptions.length ? (
            <ul className="ally__recurring">
              {[...activeSubs, ...s.subscriptions.filter((x) => !x.active).slice(0, Math.max(0, 6 - activeSubs.length))].map((x) => (
                <li key={x.name}>
                  <button type="button" className="paypal-dash__link" onClick={() => setSheet({ kind: 'party', name: x.name, people: false })}>
                    <span className="ally__recurring-name">
                      {x.name}
                      <span className="paypal-dash__sub">
                        {x.active ? 'Active' : `Last ${fmtMonth(x.last)}`} · since {fmtMonth(x.first)}
                        {x.change ? ` · ${money(x.change.from)} → ${money(x.change.to)} ${fmtMonth(x.change.date)}` : ''}
                      </span>
                    </span>
                    <span className="ally__recurring-amt">{money(x.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No subscriptions through PayPal.</p>
          )}
        </section>

        <section className="fin-dash__card">
          <DashTitle
            info={
              <p>
                Which card or bank paid for PayPal payments in this range. Matched cards come from your live card statements; “Card (PayPal doesn’t say which)” is left when no live card shows the
                charge.
              </p>
            }
          >
            How It Was Paid
          </DashTitle>
          {sources.length ? (
            <div className="fin-dash__years paypal-dash__bars">
              {sources.map((f) => (
                <button key={f.label} type="button" className="fin-dash__year paypal-dash__row" onClick={() => setSheet({ kind: 'source', label: f.label })}>
                  <span className="fin-dash__year-label">{f.label}</span>
                  <span className="fin-dash__year-value">
                    {f.count} payment{f.count === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="fin-dash__muted">No payments in this range.</p>
          )}
          {data.cards.cardsLive > 0 && data.cards.byCard.length > 0 && (
            <p className="fin-dash__stat-sub">Matched to card statements: {data.cards.byCard.map((c) => `${c.card} (${c.count})`).join(' · ')}</p>
          )}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Stores paid through PayPal in this range, net of refunds.</p>}>Stores</DashTitle>
          <Bars
            rows={stores.slice(0, 10).map((g) => ({ key: g.name, label: g.name, value: g.total, sub: `${g.count}×` }))}
            onClick={(name) => setSheet({ kind: 'party', name, people: false })}
            empty="No store payments in this range."
            wide
          />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Money sent to and received from people (companies are under Stores or Received).</p>}>People</DashTitle>
          {people.length ? (
            <ul className="ally__recurring">
              {people.slice(0, 10).map((g) => (
                <li key={g.name}>
                  <button type="button" className="paypal-dash__link" onClick={() => setSheet({ kind: 'party', name: g.name, people: true })}>
                    <span className="ally__recurring-name">
                      {g.name}
                      <span className="paypal-dash__sub">
                        {g.count}× · last {fmtDate(g.last)}
                      </span>
                    </span>
                    <span className={`ally__recurring-amt${g.total < 0 ? ' fin-dash__neg' : ''}`}>{`${g.total > 0 ? '+' : ''}${money(g.total)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No money sent to or from people in this range.</p>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Every year since the first statement; Stores and People are money paid out, Received includes PayPal’s own credits.</p>}>By Year</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table paypal-dash__years-table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>Stores</th>
                  <th>People</th>
                  <th>Received</th>
                  <th>Refunds</th>
                  <th>Fees</th>
                </tr>
              </thead>
              <tbody>
                {[...s.years].reverse().map((y) => (
                  <tr key={y.year}>
                    <td>{y.year}</td>
                    <td>{money(y.purchases, false)}</td>
                    <td>{money(y.payments, false)}</td>
                    <td>{money(y.received, false)}</td>
                    <td>{money(y.refunds, false)}</td>
                    <td>{money(y.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Activity</h3>
            <div className="ally__txn-tools">
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Type">
                {FILTERS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search activity" />
            </div>
          </div>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Who</th>
                  <th>Type</th>
                  <th>Paid With</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((a, i) => (
                  <tr key={`${a.id ?? a.date}-${i}`} className="bee-social__row" onClick={() => setSheet({ kind: 'row', row: a })}>
                    <td>{fmtDate(a.date)}</td>
                    <td className="ally__desc">{a.name}</td>
                    <td>{CLASS_LABEL[a.cls]}</td>
                    <td className="paypal-dash__funded">{fundedBy(a).join(' + ') || '—'}</td>
                    <td className={`ally__amt${a.amount < 0 ? ' fin-dash__neg' : ''}`}>
                      {money(a.amount)}
                      {a.currency !== 'USD' ? ` ${a.currency}` : ''}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="fin-dash__muted">
                      No matching activity.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {rows.slice(0, limit).map((a, i) => (
              <li key={`${a.id ?? a.date}-c${i}`}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'row', row: a })}>
                  <span className="post-card__top">
                    {fmtDate(a.date)} · {CLASS_LABEL[a.cls]}
                  </span>
                  <span className="post-card__title paypal-dash__card-title">
                    <span>{a.name}</span>
                    <span className={a.amount < 0 ? 'fin-dash__neg' : undefined}>{money(a.amount)}</span>
                  </span>
                  <span className="paypal-dash__sub">{fundedBy(a).join(' + ') || '—'}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="fin-dash__stat-sub">
            {rows.length} item{rows.length === 1 ? '' : 's'} in {range.label.toLowerCase()}
            {rows.length > limit && (
              <>
                {' · '}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((n) => n + 100)}>
                  Show More
                </button>
              </>
            )}
          </p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <DashTitle info={<p>PayPal only sends a statement for a month with activity. Math checks: each row’s amount + fee = total; the balance carries; every payment is fully funded.</p>}>
              Statements
            </DashTitle>
            {stmtsDesc.length > 12 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllStmts((v) => !v)}>
                {allStmts ? 'Show Recent' : `Show All ${stmtsDesc.length}`}
              </button>
            )}
          </div>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table paypal-dash__stmts">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Items</th>
                  <th>Paid Out</th>
                  <th>Received</th>
                  <th>To Bank</th>
                  <th>Math</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(allStmts ? stmtsDesc : stmtsDesc.slice(0, 12)).map((st) => {
                  const failed = st.checks.filter((c) => !c.ok);
                  const url = fileUrl(st.fileId);
                  return (
                    <tr key={st.id}>
                      <td>{fmtMonth(st.periodEnd)}</td>
                      <td>{st.count}</td>
                      <td>{money(st.spent, false)}</td>
                      <td>{money(st.received, false)}</td>
                      <td>{money(st.withdrawn, false)}</td>
                      <td title={st.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')} className={failed.length ? 'fin-dash__neg' : undefined}>
                        {failed.length ? `✕ ${failed.length}` : `✓ ${st.checks.length}`}
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
          <p className="fin-dash__stat-sub">
            {statements.length} statements read · {checksOk}/{checksTotal} math checks passed
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
                  PayPal ↗
                </a>
              </>
            )}
          </p>
        </section>
      </div>

      {sheet && <PaypalSheet sheet={sheet} data={data} range={range} inR={inR} fundedBy={fundedBy} onClose={() => setSheet(null)} onOpen={setSheet} />}
    </div>
  );
}

function groupBy(xs: PaypalActivity[], value: (a: PaypalActivity) => number) {
  const m = new Map<string, { name: string; total: number; count: number; last: string }>();
  for (const a of xs.filter((x) => x.currency === 'USD')) {
    const k = nameKey(a.name);
    const cur = m.get(k) ?? { name: a.name, total: 0, count: 0, last: a.date };
    cur.total = Math.round((cur.total + value(a)) * 100) / 100;
    if (a.cls !== 'refund') cur.count++;
    cur.last = a.date;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

function Tile({ label, value, c, fallback, onClick }: { label: string; value: string; c: { text: string; tone: '' | 'up' | 'down' }; fallback: string; onClick: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      <span className={`fin-dash__stat-sub${c.tone === 'up' ? ' bee-delta--up' : c.tone === 'down' ? ' bee-delta--down' : ''}`}>{c.text || fallback}</span>
    </button>
  );
}

function Bars({ rows, onClick, empty, wide }: { rows: { key: string; label: string; value: number; sub?: string }[]; onClick?: (key: string) => void; empty: string; wide?: boolean }) {
  if (!rows.length) return <p className="fin-dash__muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className={`fin-dash__years paypal-dash__bars${wide ? ' paypal-dash__bars--wide' : ''}`}>
      {rows.map((r) => {
        const inner = (
          <>
            <span className="fin-dash__year-label" title={r.label}>
              {r.label}
            </span>
            <span className="fin-dash__year-track">
              <span className="fin-dash__year-bar" style={{ width: `${(Math.max(0, r.value) / max) * 100}%` }} />
            </span>
            <span className="fin-dash__year-value">{money(r.value, false)}</span>
            <span className="fin-dash__year-bills">{r.sub ?? ''}</span>
          </>
        );
        return onClick ? (
          <button key={r.key} type="button" className="fin-dash__year paypal-dash__row" onClick={() => onClick(r.key)}>
            {inner}
          </button>
        ) : (
          <div key={r.key} className="fin-dash__year">
            {inner}
          </div>
        );
      })}
    </div>
  );
}

function PaypalSheet({
  sheet,
  data,
  range,
  inR,
  fundedBy,
  onClose,
  onOpen,
}: {
  sheet: Sheet;
  data: Data;
  range: DateRange;
  inR: PaypalActivity[];
  fundedBy: (a: PaypalActivity) => string[];
  onClose: () => void;
  onOpen: (s: Sheet) => void;
}) {
  const sub = `${range.label} · ${rangeText(range)}`;
  if (sheet.kind === 'row') {
    const a = sheet.row;
    const card = a.id ? data.cards.paidBy[a.id] : undefined;
    const st = data.statements.find((x) => x.periodEnd === a.statement);
    const url = st ? data.files.find((f) => f.fileId === st.fileId)?.url : null;
    return (
      <DetailSheet title={a.name} sub={`${fmtDate(a.date)} · ${a.type}`} onClose={onClose}>
        <div className="dash-split">
          <Item label="Amount" value={`${money(a.amount)}${a.currency !== 'USD' ? ` ${a.currency}` : ''}`} />
          {a.fee !== 0 && <Item label="PayPal Fee" value={money(-a.fee)} />}
          {a.fee !== 0 && <Item label="You Got" value={money(a.total)} />}
          <Item label="Kind" value={CLASS_LABEL[a.cls]} />
        </div>
        <div className="dash-sheet__section">
          <h4>Paid With</h4>
          <p>{fundedBy(a).join(' + ') || 'PayPal balance / not shown'}</p>
          {card && (
            <p className="fin-dash__stat-sub">
              On the <Link to={`/finance/${card.folderId}`}>{card.card}</Link> statement as “{card.description}” ({fmtDate(card.date)})
            </p>
          )}
        </div>
        <div className="dash-sheet__section">
          <h4>Statement</h4>
          <p>
            {fmtMonth(a.statement)}
            {url && (
              <>
                {' · '}
                <a href={url} target="_blank" rel="noreferrer">
                  PDF ↗
                </a>
              </>
            )}
            {a.id ? ` · PayPal ID ${a.id}` : ''}
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpen({ kind: 'party', name: a.name, people: a.cls === 'payment' || a.cls === 'received' })}>
          All Activity With {a.name}
        </button>
      </DetailSheet>
    );
  }
  let title = '';
  let list: PaypalActivity[] = [];
  let scope = sub;
  if (sheet.kind === 'tile') {
    title = sheet.title;
    list = inR.filter((a) => (sheet.title === 'Paid Out' ? SPEND.includes(a.cls) : sheet.title.startsWith('Fees') ? a.fee !== 0 : matchesFilter(a, sheet.filter)));
  } else if (sheet.kind === 'party') {
    title = sheet.name;
    list = data.summary.activity.filter((a) => nameKey(a.name) === nameKey(sheet.name));
    scope = 'All time';
  } else {
    title = sheet.label;
    list = inR.filter((a) => SPEND.includes(a.cls) && fundedBy(a).includes(sheet.label));
  }
  const total = list.reduce((s2, a) => s2 + (sheet.kind === 'tile' && sheet.title.startsWith('Fees') ? -a.fee : a.amount), 0);
  const groups = sheet.kind === 'party' ? [] : groupBy(list, (a) => (a.amount < 0 ? -a.amount : a.amount)).slice(0, 8);
  return (
    <DetailSheet title={title} sub={scope} onClose={onClose}>
      <div className="dash-split">
        <Item label="Total" value={money(Math.abs(total))} />
        <Item label="Items" value={String(list.length)} />
        {list.length > 0 && <Item label="Latest" value={fmtDate(list[list.length - 1].date)} />}
      </div>
      {groups.length > 1 && (
        <div className="dash-sheet__section">
          <h4>By Name</h4>
          <Bars rows={groups.map((g) => ({ key: g.name, label: g.name, value: g.total, sub: `${g.count}×` }))} onClick={(name) => onOpen({ kind: 'party', name, people: false })} empty="" wide />
        </div>
      )}
      <div className="dash-sheet__section">
        <h4>Items</h4>
        <ul className="ally__recurring">
          {[...list].reverse().map((a, i) => (
            <li key={`${a.id ?? a.date}-${i}`}>
              <button type="button" className="paypal-dash__link" onClick={() => onOpen({ kind: 'row', row: a })}>
                <span className="ally__recurring-name">
                  {a.name}
                  <span className="paypal-dash__sub">
                    {fmtDate(a.date)} · {CLASS_LABEL[a.cls]}
                    {a.fee ? ` · fee ${money(-a.fee)}` : ''} · {fundedBy(a).join(' + ') || '—'}
                  </span>
                </span>
                <span className={`ally__recurring-amt${a.amount < 0 ? ' fin-dash__neg' : ''}`}>{money(a.amount)}</span>
              </button>
            </li>
          ))}
          {!list.length && <li className="fin-dash__muted">Nothing here.</li>}
        </ul>
      </div>
    </DetailSheet>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="dash-split__item">
      <span className="fin-dash__stat-label">{label}</span>
      <span className="dash-split__value">{value}</span>
    </div>
  );
}
