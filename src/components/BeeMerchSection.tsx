import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeMerch, MerchOrder } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import { RangePicker } from './dash/RangePicker';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { clampRange } from './dash/useUrlRange';
import { type DateRange, bucketFor, bucketStart, bucketsIn, dayMs, inRange, previousRange, rangeText } from '../utils/dateRange';

/** Bedford Bee → Merch (Fourthwall store), on the dashboard kit (Mike,
 * 2026-10-12). Orders come from the Fourthwall API (Settings → Bedford Bee)
 * and/or the orders export in the Drive folder; everything here is computed
 * from /api/bee/merch for the shared date range. Products, item costs
 * (profit) and where buyers came from need the API — the export has none. */

const SALES_COLOR = '#2A6FB0';
const PROFIT_COLOR = '#C0662E';

const toMs = (iso: string) => dayMs(iso.slice(0, 10));
const fmtDate = (iso: string | null) => (iso ? new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtShort = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
const money = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const r2 = (n: number) => Math.round(n * 100) / 100;
const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const statusLabel = (s: string | null) => (s ? title(s.replace(/_/g, ' ')) : '—');
const buyerKey = (o: MerchOrder) => o.email ?? o.id;
/** Contacts' rule: only all-lowercase names get Title-Cased. */
const tidy = (n: string) => (/[a-z]/.test(n) && n === n.toLowerCase() && !/[@\d]/.test(n) ? title(n) : n);
const buyerName = (o: MerchOrder) => (o.isMe ? 'You' : o.name ? tidy(o.name) : o.shipName ? tidy(o.shipName) : (o.email ?? 'Unknown'));
const townOf = (o: MerchOrder) => ((o.shipCity ?? o.city) ? title(o.shipCity ?? o.city ?? '') : 'Unknown');
const sourceOf = (o: MerchOrder) => (o.utm.source ? title(o.utm.source) : o.via === 'api' ? 'Direct / Unknown' : 'Not Tracked');
const itemText = (o: MerchOrder) => (o.items.length ? o.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name}${i.variant ? ` (${i.variant})` : ''}`).join(', ') : null);

function changeText(now: number, prev: number | null, label: string | null) {
  if (prev == null || label == null) return { text: '', tone: '' as '' | 'up' | 'down' };
  if (!prev) return now ? { text: `new vs ${label}`, tone: 'up' as const } : { text: '', tone: '' as const };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' as const };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: (d > 0 ? 'up' : 'down') as 'up' | 'down' };
}
const toneClass = (t: '' | 'up' | 'down') => (t === 'up' ? ' bee-delta--up' : t === 'down' ? ' bee-delta--down' : '');

interface Stats {
  orders: MerchOrder[]; // not cancelled
  cancelled: MerchOrder[];
  sales: number;
  profit: number | null;
  costKnown: number;
  tips: number;
  buyers: Map<string, MerchOrder[]>;
  units: number | null;
}
function stats(all: MerchOrder[], r: { from: string; to: string }): Stats {
  const inR = all.filter((o) => inRange(o.day, r));
  const orders = inR.filter((o) => !o.cancelled);
  const known = orders.filter((o) => o.profit !== null);
  const buyers = new Map<string, MerchOrder[]>();
  for (const o of orders) buyers.set(buyerKey(o), [...(buyers.get(buyerKey(o)) ?? []), o]);
  return {
    orders,
    cancelled: inR.filter((o) => o.cancelled),
    sales: r2(orders.reduce((n, o) => n + o.sales, 0)),
    profit: orders.length && known.length === orders.length ? r2(known.reduce((n, o) => n + (o.profit ?? 0), 0)) : null,
    costKnown: known.length,
    tips: r2(orders.reduce((n, o) => n + o.donation, 0)),
    buyers,
    units: orders.every((o) => o.units !== null) ? orders.reduce((n, o) => n + (o.units ?? 0), 0) : null,
  };
}

type Sheet =
  | { kind: 'orders' | 'sales' | 'profit' | 'buyers' | 'avg' }
  | { kind: 'product'; name: string }
  | { kind: 'town'; town: string }
  | { kind: 'source'; source: string }
  | { kind: 'buyer'; key: string }
  | { kind: 'order'; order: MerchOrder };

export function BeeMerchSection({
  range: rangeIn,
  setRange,
  onScan,
  scanning,
  scanMsg,
}: {
  range: DateRange;
  setRange: (r: DateRange) => void;
  onScan: () => void;
  scanning: boolean;
  scanMsg: string | null;
}) {
  const [data, setData] = useState<BeeMerch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const load = () =>
    api
      .getBeeMerch()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [scanMsg]);

  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const earliest = useMemo(() => (data?.orders.length ? data.orders.map((o) => o.day).sort()[0] : today), [data, today]);
  const range = clampRange(rangeIn, earliest);
  const prevR = previousRange(range);
  const prevLabel = prevR ? (range.key === 'ytd' ? 'last year' : prevR.label) : null;
  const s = useMemo(() => (data ? stats(data.orders, range) : null), [data, range]);
  const p = useMemo(() => (data && prevR ? stats(data.orders, prevR) : null), [data, prevR]);

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.syncBeeMerch();
      setSyncMsg(`Synced — ${r.orders} order${r.orders === 1 ? '' : 's'} ${r.full ? 'read' : 'updated'}.`);
      load();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  if (error) return <p className="fin-dash__muted">{error}</p>;
  if (!data || !s) return <p className="fin-dash__muted">Loading…</p>;
  const conn = data.connection;
  const hasApi = data.orders.some((o) => o.via === 'api');

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Merch</h2>
        <span className="fin-dash__muted">
          {conn.connected
            ? `${conn.shop ?? 'Fourthwall'}${conn.lastSyncAt ? ` · synced ${new Date(conn.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`
            : data.files.length
              ? `From the Fourthwall export of ${fmtDate(data.files[0].exportDate)}`
              : 'Fourthwall not connected'}
        </span>
      </div>

      {!data.orders.length ? (
        <div className="fin-dash__card">
          <p>
            Connect the Fourthwall store in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> (an Open API user from Fourthwall → Settings → For Developers), or drop Fourthwall’s orders
            export (CSV) in the Drive <strong>Bedford Bee</strong> folder and scan.
          </p>
          <button type="button" className="btn btn--sm" onClick={onScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
          {scanMsg && <p className="fin-dash__note">{scanMsg}</p>}
        </div>
      ) : (
        <>
          <div className="dash-controls dash-controls--solo">
            <RangePicker value={range} onChange={setRange} today={today} earliest={earliest} />
            <span className="dash-controls__range-text">
              {rangeText(range)}
              {prevR ? ` · vs ${rangeText(prevR)}` : ''}{' '}
              <InfoTip label="About these numbers">
                <p>Sales = merchandise after discounts and refunds. Cancelled orders count for nothing. Orders are dated by when they were placed (Eastern time).</p>
                <p>
                  Profit = sales minus Fourthwall’s base cost for each item, plus tips. Shipping and sales tax are paid by the buyer and pass through to Fourthwall, so they’re never counted as income.
                </p>
                <p>Products, item costs and where buyers came from come from the Fourthwall API — orders read only from the export show sales but no profit.</p>
              </InfoTip>
            </span>
          </div>

          <div className="fin-dash__stats fin-dash__stats--5">
            <Tile
              label="Orders"
              value={n0(s.orders.length)}
              {...(() => {
                const c = changeText(s.orders.length, p ? p.orders.length : null, prevLabel);
                return { sub: c.text || (s.units != null ? `${s.units} item${s.units === 1 ? '' : 's'}` : ''), tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'orders' })}
            />
            <Tile
              label="Sales"
              value={money(s.sales)}
              {...(() => {
                const c = changeText(s.sales, p ? p.sales : null, prevLabel);
                return { sub: c.text || 'after discounts + refunds', tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'sales' })}
            />
            <Tile
              label="Profit"
              value={s.profit === null ? '—' : money(s.profit)}
              sub={s.profit === null ? (s.orders.length ? `costs known for ${s.costKnown} of ${s.orders.length}` : '') : s.sales ? `${Math.round(((s.profit - s.tips) / s.sales) * 100)}% margin` : ''}
              onClick={() => setSheet({ kind: 'profit' })}
            />
            <Tile
              label="Buyers"
              value={n0(s.buyers.size)}
              sub={(() => {
                const rep = [...s.buyers.values()].filter((l) => l.length > 1).length;
                return rep ? `${rep} ordered more than once` : 'unique people';
              })()}
              onClick={() => setSheet({ kind: 'buyers' })}
            />
            <Tile
              label="Avg Order"
              value={s.orders.length ? money(s.sales / s.orders.length) : '—'}
              {...(() => {
                const a = s.orders.length ? s.sales / s.orders.length : 0;
                const pa = p && p.orders.length ? p.sales / p.orders.length : null;
                const c = s.orders.length && pa != null ? changeText(a, pa, prevLabel) : { text: '', tone: '' as const };
                return { sub: c.text || 'sales per order', tone: c.tone };
              })()}
              onClick={() => setSheet({ kind: 'avg' })}
            />
          </div>

          <div className="fin-dash__grid">
            <section className="fin-dash__card fin-dash__card--wide">
              <DashTitle info={<p>Sales (after discounts and refunds) by {bucketFor(range)}, and profit where Fourthwall’s item costs are known.</p>}>Sales Over Time</DashTitle>
              <SalesChart orders={s.orders} range={range} />
            </section>
            <ProductsCard orders={s.orders} hasApi={hasApi} onOpen={(name) => setSheet({ kind: 'product', name })} />
            <section className="fin-dash__card">
              <DashTitle info={<p>Where orders were shipped — a read on how local the merch crowd is. Tap a town for its orders.</p>}>Where Orders Ship</DashTitle>
              <Bars rows={tally(s.orders, townOf).map(([k, v]) => ({ key: k, label: k, value: v }))} onClick={(town) => setSheet({ kind: 'town', town })} empty="No orders in this range." />
            </section>
            <section className="fin-dash__card">
              <DashTitle
                info={
                  <p>
                    From the UTM tags on the link a buyer used (utm_source). Tag the shop links you post — e.g. <code>?utm_source=facebook</code> — to see which posts sell. Only API orders carry this.
                  </p>
                }
              >
                Where Buyers Came From
              </DashTitle>
              {hasApi ? (
                <Bars rows={tally(s.orders, sourceOf).map(([k, v]) => ({ key: k, label: k, value: v }))} onClick={(source) => setSheet({ kind: 'source', source })} empty="No orders in this range." />
              ) : (
                <p className="fin-dash__muted">Shows up once the Fourthwall API is connected.</p>
              )}
            </section>
            <BuyersCard s={s} onOpen={(key) => setSheet({ kind: 'buyer', key })} />
            <OrdersCard orders={[...s.orders, ...s.cancelled].sort((a, b) => b.createdAt.localeCompare(a.createdAt))} onOpen={(order) => setSheet({ kind: 'order', order })} />
            <YearsCard data={data} />
            <SourceCard data={data} onScan={onScan} scanning={scanning} scanMsg={scanMsg} onSync={sync} syncing={syncing} syncMsg={syncMsg} />
          </div>
        </>
      )}

      {sheet && <MerchSheet sheet={sheet} data={data} range={range} s={s} p={p} onClose={() => setSheet(null)} onOpen={setSheet} />}
    </section>
  );
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: '' | 'up' | 'down'; onClick: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className={`fin-dash__stat-sub${toneClass(tone ?? '')}`}>{sub}</span>}
    </button>
  );
}

function tally<T>(list: T[], key: (t: T) => string, weight: (t: T) => number = () => 1): [string, number][] {
  const m = new Map<string, number>();
  for (const t of list) m.set(key(t), (m.get(key(t)) ?? 0) + weight(t));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function productRows(orders: MerchOrder[]) {
  const m = new Map<string, { units: number; sales: number; orders: number }>();
  for (const o of orders)
    for (const i of o.items) {
      const r = m.get(i.name) ?? { units: 0, sales: 0, orders: 0 };
      r.units += i.qty;
      r.sales += (i.price ?? 0) * i.qty;
      r.orders++;
      m.set(i.name, r);
    }
  return [...m.entries()].sort((a, b) => b[1].units - a[1].units);
}

function SalesChart({ orders, range }: { orders: MerchOrder[]; range: { from: string; to: string } }) {
  const bucket = bucketFor(range);
  const buckets = bucketsIn(range, bucket);
  const sum = (f: (o: MerchOrder) => number | null) => {
    const m = new Map(buckets.map((b) => [b, 0]));
    for (const o of orders) {
      const b = bucketStart(o.day, bucket);
      if (m.has(b)) m.set(b, (m.get(b) ?? 0) + (f(o) ?? 0));
    }
    return buckets.map((b) => ({ x: dayMs(b), y: r2(m.get(b) ?? 0) }));
  };
  const withProfit = orders.length > 0 && orders.every((o) => o.profit !== null);
  if (!orders.length) return <p className="fin-dash__muted">No orders in this range.</p>;
  return (
    <FinanceLineChart
      series={[{ name: 'Sales', color: SALES_COLOR, points: sum((o) => o.sales) }, ...(withProfit ? [{ name: 'Profit', color: PROFIT_COLOR, points: sum((o) => o.profit) }] : [])]}
      formatY={(v) => money(v)}
      formatX={(ms) => new Date(ms).toLocaleDateString('en-US', bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })}
      ariaLabel="Merch sales over time"
      height={200}
    />
  );
}

function ProductsCard({ orders, hasApi, onOpen }: { orders: MerchOrder[]; hasApi: boolean; onOpen: (name: string) => void }) {
  const rows = productRows(orders);
  return (
    <section className="fin-dash__card">
      <DashTitle info={<p>Items sold in the range, by units. Tap one for its orders, sizes and colors.</p>}>Top Products</DashTitle>
      {rows.length ? (
        <Bars rows={rows.slice(0, 10).map(([name, r]) => ({ key: name, label: name, value: r.units, sub: money(r.sales) }))} onClick={onOpen} />
      ) : (
        <p className="fin-dash__muted">{hasApi ? 'No items in this range.' : 'Products show up once the Fourthwall API is connected — the export doesn’t list items.'}</p>
      )}
    </section>
  );
}

function BuyersCard({ s, onOpen }: { s: Stats; onOpen: (key: string) => void }) {
  const list = [...s.buyers.entries()].sort((a, b) => b[1].length - a[1].length || b[1].reduce((n, o) => n + o.sales, 0) - a[1].reduce((n, o) => n + o.sales, 0));
  return (
    <section className="fin-dash__card fin-dash__card--wide">
      <DashTitle info={<p>Everyone who ordered in the range. Buyers are added to Contacts automatically with a “Merch” label (your own orders aren’t).</p>}>Buyers</DashTitle>
      {list.length ? (
        <ul className="bee-list">
          {list.slice(0, 25).map(([key, os]) => (
            <li key={key} className="bee-list__row">
              <button type="button" className="link-btn" style={{ textAlign: 'left' }} onClick={() => onOpen(key)}>
                {buyerName(os[0])}
              </button>
              <span className="bee-list__meta">
                {os.length > 1 ? `${os.length} orders · ` : ''}
                {money(os.reduce((n, o) => n + o.sales, 0))} · {townOf(os[0])}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-dash__muted">Nobody ordered in this range.</p>
      )}
    </section>
  );
}

function OrdersCard({ orders, onOpen }: { orders: MerchOrder[]; onOpen: (o: MerchOrder) => void }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(25);
  const ql = q.trim().toLowerCase();
  const list = ql ? orders.filter((o) => [o.name, o.shipName, o.email, o.friendlyId, itemText(o), townOf(o)].some((v) => v?.toLowerCase().includes(ql))) : orders;
  const shown = list.slice(0, limit);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle info={<p>Every order in the range, newest first — cancelled ones are listed but count for nothing. Tap an order for its items and money.</p>}>Orders</DashTitle>
      <div className="ally__txn-tools dash-card-tools">
        <input placeholder="Search Buyers, Items, Towns" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
      </div>
      {list.length ? (
        <>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Buyer</th>
                  <th>Items</th>
                  <th>Status</th>
                  <th className="num">Sales</th>
                  <th className="num">Profit</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={o.id} className="bee-social__row" onClick={() => onOpen(o)}>
                    <td>{fmtShort(o.day)}</td>
                    <td>
                      {buyerName(o)}
                      <span className="fin-dash__muted"> · {townOf(o)}</span>
                    </td>
                    <td className="bee-posts__title">{itemText(o) ?? <span className="fin-dash__muted">—</span>}</td>
                    <td className={o.cancelled ? 'fin-dash__neg' : ''}>{statusLabel(o.status)}</td>
                    <td className="num">{money(o.sales)}</td>
                    <td className="num">{o.profit === null || o.cancelled ? <span className="fin-dash__muted">—</span> : money(o.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <OrderCards orders={shown} onOpen={onOpen} phoneOnly />
        </>
      ) : (
        <p className="fin-dash__muted">No orders in this range.</p>
      )}
      {list.length > limit && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLimit((l) => l + 50)}>
          Show More ({list.length - limit} left)
        </button>
      )}
    </section>
  );
}

function OrderCards({ orders, onOpen, phoneOnly }: { orders: MerchOrder[]; onOpen: (o: MerchOrder) => void; phoneOnly?: boolean }) {
  if (!orders.length) return <p className="fin-dash__muted">No orders.</p>;
  return (
    <ul className="post-cards" style={phoneOnly ? undefined : { display: 'block' }}>
      {orders.slice(0, 60).map((o) => (
        <li key={o.id}>
          <button type="button" className="post-card" onClick={() => onOpen(o)}>
            <div className="post-card__top">
              {fmtShort(o.day)} · {statusLabel(o.status)}
            </div>
            <div className="post-card__title">
              {buyerName(o)} · {townOf(o)}
            </div>
            {itemText(o) && <div className="fin-dash__muted">{itemText(o)}</div>}
            <div className="post-card__metrics">
              <span className="post-card__metric">
                <span className="post-card__metric-label">Sales</span>
                <span className="post-card__metric-value">{money(o.sales)}</span>
              </span>
              <span className="post-card__metric">
                <span className="post-card__metric-label">Profit</span>
                <span className="post-card__metric-value">{money(o.profit)}</span>
              </span>
              <span className="post-card__metric">
                <span className="post-card__metric-label">Paid</span>
                <span className="post-card__metric-value">{money(o.total)}</span>
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function YearsCard({ data }: { data: BeeMerch }) {
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle
        info={
          <p>
            By calendar year of the order — the same numbers as the “Bedford Bee (Merch)” section of each Tax Packet. Shipping and sales tax are collected from buyers for Fourthwall and aren’t income.
            Check the year against Fourthwall’s payouts and any 1099-K.
          </p>
        }
      >
        Money by Year
      </DashTitle>
      <div className="fin-dash__table-wrap">
        <table className="fin-dash__table bee-table--compact">
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Orders</th>
              <th className="num">Sales</th>
              <th className="num bee-hide-sm">Shipping</th>
              <th className="num bee-hide-sm">Sales Tax</th>
              <th className="num">Item Costs</th>
              <th className="num">Profit</th>
            </tr>
          </thead>
          <tbody>
            {data.years.map((y) => (
              <tr key={y.year}>
                <td>{y.year}</td>
                <td className="num">{y.orders}</td>
                <td className="num">{money(y.sales)}</td>
                <td className="num fin-dash__muted bee-hide-sm">{money(y.shipping)}</td>
                <td className="num fin-dash__muted bee-hide-sm">{money(y.tax)}</td>
                <td className="num">{y.cost !== null ? money(y.cost) : <span className="fin-dash__muted">{y.costKnown ? `${y.costKnown} of ${y.orders}` : '—'}</span>}</td>
                <td className="num">{money(y.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SourceCard({
  data,
  onScan,
  scanning,
  scanMsg,
  onSync,
  syncing,
  syncMsg,
}: {
  data: BeeMerch;
  onScan: () => void;
  scanning: boolean;
  scanMsg: string | null;
  onSync: () => void;
  syncing: boolean;
  syncMsg: string | null;
}) {
  const c = data.connection;
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <div className="fin-dash__card-head">
        <DashTitle
          info={
            <p>
              The Fourthwall API is checked every hour for new and changed orders (and a full re-read weekly). Orders from the export file in the Drive folder fill in history and refunds; an API order
              always wins.
            </p>
          }
        >
          Data
        </DashTitle>
        {c.connected ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan Drive'}
          </button>
        )}
      </div>
      <p className="fin-dash__muted">
        {c.connected ? (
          <>
            Fourthwall API · {c.shop ?? 'connected'}
            {c.lastSyncAt ? ` · synced ${new Date(c.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </>
        ) : (
          <>
            Fourthwall API not connected — <Link to="/settings?cat=bee">connect it in Settings</Link> for products, item costs (profit) and new orders every hour.
          </>
        )}
      </p>
      {(syncMsg || scanMsg) && <p className="fin-dash__note">{syncMsg ?? scanMsg}</p>}
      {c.lastError && <p className="fin-dash__note fin-dash__neg">{c.lastError}</p>}
      {data.files.length > 0 && (
        <ul className="bee-list">
          {data.files.map((f) => (
            <li key={f.fileId} className="bee-list__row">
              <span>
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
              </span>
              <span className={`bee-list__meta${f.status === 'failed' ? ' fin-dash__neg' : ''}`}>
                {f.status === 'parsed' ? `${f.rows ?? 0} orders · ${fmtDate(f.exportDate)}` : (f.error ?? f.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- sheets

function Split({ items }: { items: [string, string, string][] }) {
  return (
    <div className="dash-split">
      {items.map(([label, value, sub]) => (
        <div key={label} className="dash-split__item">
          <span className="fin-dash__stat-label">{label}</span>
          <span className="dash-split__value">{value}</span>
          {sub && <span className="fin-dash__stat-sub">{sub}</span>}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dash-sheet__section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Bars({ rows, onClick, empty = 'Nothing yet.' }: { rows: { key: string; label: string; value: number; sub?: string }[]; onClick?: (key: string) => void; empty?: string }) {
  if (!rows.length) return <p className="fin-dash__muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bee-bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="bee-bars__label">{r.label}</span>
            <span className="bee-bars__track">
              <span className="bee-bars__bar" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="bee-bars__value">
              {r.value}
              {r.sub ? <span className="bee-bars__paid"> · {r.sub}</span> : null}
            </span>
          </>
        );
        return onClick ? (
          <button key={r.key} type="button" className="bee-bars__row" onClick={() => onClick(r.key)}>
            {inner}
          </button>
        ) : (
          <div key={r.key} className="bee-bars__row bee-bars__row--static">
            {inner}
          </div>
        );
      })}
    </div>
  );
}

function OrderList({ orders, onOpen }: { orders: MerchOrder[]; onOpen: (s: Sheet) => void }) {
  if (!orders.length) return <p className="fin-dash__muted">No orders.</p>;
  return (
    <ul className="bee-list">
      {orders.slice(0, 60).map((o) => (
        <li key={o.id} className="bee-list__row">
          <button type="button" className="link-btn" style={{ textAlign: 'left' }} onClick={() => onOpen({ kind: 'order', order: o })}>
            {fmtShort(o.day)} · {buyerName(o)}
          </button>
          <span className="bee-list__meta">
            {itemText(o) ? `${itemText(o)} · ` : ''}
            {money(o.sales)}
            {o.cancelled ? ' · cancelled' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MerchSheet({ sheet, data, range, s, p, onClose, onOpen }: { sheet: Sheet; data: BeeMerch; range: DateRange; s: Stats; p: Stats | null; onClose: () => void; onOpen: (s: Sheet) => void }) {
  const sub = `${range.label} · ${rangeText(range)}`;
  if (sheet.kind === 'order') {
    const o = sheet.order;
    return (
      <DetailSheet title={`Order ${o.friendlyId ?? ''}`.trim()} sub={`${fmtDate(o.day)} · ${statusLabel(o.status)}`} onClose={onClose}>
        <Split
          items={[
            ['Sales', money(o.sales), o.cancelled ? 'cancelled — not counted' : 'after discounts + refunds'],
            ['Profit', money(o.profit), o.cost !== null ? `item costs ${money(o.cost)}` : 'needs the API'],
            ['Buyer Paid', money(o.total), 'incl. shipping + tax'],
          ]}
        />
        <Section title="Buyer">
          <p>
            {o.contactId && o.contactId !== 'none' ? <Link to={`/contacts/${o.contactId}`}>{buyerName(o)}</Link> : buyerName(o)}
            {o.email && !o.isMe ? <span className="fin-dash__muted"> · {o.email}</span> : null}
          </p>
          <p className="fin-dash__muted">
            Ships to {o.shipName && o.shipName !== o.name ? `${o.shipName}, ` : ''}
            {townOf(o)}
            {o.utm.source ? ` · came from ${sourceOf(o)}${o.utm.campaign ? ` (${o.utm.campaign})` : ''}` : ''}
          </p>
        </Section>
        {o.items.length > 0 && (
          <Section title="Items">
            <ul className="bee-list">
              {o.items.map((i, n) => (
                <li key={n} className="bee-list__row">
                  <span>
                    {i.qty > 1 ? `${i.qty}× ` : ''}
                    {i.name}
                    {i.variant ? <span className="fin-dash__muted"> · {i.variant}</span> : null}
                  </span>
                  <span className="bee-list__meta">
                    {money(i.price)}
                    {i.cost !== null ? ` · cost ${money(i.cost)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Money">
          <ul className="bee-list">
            {(
              [
                ['Merchandise', o.merchandise],
                ['Discount', -o.discount],
                ['Refunded', -o.refunded],
                ['Tip', o.donation],
                ['Shipping (to Fourthwall)', o.shipping],
                ['Sales Tax (to Fourthwall)', o.tax],
                ['Buyer Paid', o.total],
              ] as [string, number][]
            )
              .filter(([k, v]) => v !== 0 || k === 'Merchandise' || k === 'Buyer Paid')
              .map(([k, v]) => (
                <li key={k} className="bee-list__row">
                  <span>{k}</span>
                  <span className="bee-list__meta">{money(v)}</span>
                </li>
              ))}
          </ul>
          {o.promo && <p className="fin-dash__muted">Promotion {o.promo}</p>}
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'buyer') {
    const all = data.orders.filter((o) => buyerKey(o) === sheet.key);
    const live = all.filter((o) => !o.cancelled);
    const first = all[all.length - 1];
    return (
      <DetailSheet title={first ? buyerName(first) : 'Buyer'} sub={first?.email && !first.isMe ? first.email : undefined} onClose={onClose}>
        <Split
          items={[
            ['Orders', n0(live.length), 'all time'],
            ['Sales', money(live.reduce((n, o) => n + o.sales, 0)), ''],
            ['First Order', live.length ? fmtShort(live[live.length - 1].day) : '—', ''],
          ]}
        />
        {first?.contactId && first.contactId !== 'none' && (
          <p>
            <Link to={`/contacts/${first.contactId}`}>Open contact card</Link>
          </p>
        )}
        <Section title="Orders">
          <OrderList orders={all} onOpen={onOpen} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'product') {
    const os = s.orders.filter((o) => o.items.some((i) => i.name === sheet.name));
    const items = os.flatMap((o) => o.items.filter((i) => i.name === sheet.name));
    const units = items.reduce((n, i) => n + i.qty, 0);
    return (
      <DetailSheet title={sheet.name} sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Sold', n0(units), `${os.length} order${os.length === 1 ? '' : 's'}`],
            ['Sales', money(items.reduce((n, i) => n + (i.price ?? 0) * i.qty, 0)), 'list price'],
            ['Profit / Item', items.every((i) => i.price !== null && i.cost !== null) && items.length ? money((items[0].price ?? 0) - (items[0].cost ?? 0)) : '—', 'price − base cost'],
          ]}
        />
        <Section title="Sizes & Colors">
          <Bars
            rows={tally(
              items,
              (i) => i.variant ?? 'One option',
              (i) => i.qty,
            ).map(([k, v]) => ({ key: k, label: k, value: v }))}
          />
        </Section>
        <Section title="Orders">
          <OrderList orders={os} onOpen={onOpen} />
        </Section>
      </DetailSheet>
    );
  }
  if (sheet.kind === 'town' || sheet.kind === 'source') {
    const os = s.orders.filter((o) => (sheet.kind === 'town' ? townOf(o) === sheet.town : sourceOf(o) === sheet.source));
    return (
      <DetailSheet title={sheet.kind === 'town' ? sheet.town : sheet.source} sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Orders', n0(os.length), ''],
            ['Sales', money(os.reduce((n, o) => n + o.sales, 0)), ''],
            ['Buyers', n0(new Set(os.map(buyerKey)).size), ''],
          ]}
        />
        <Section title="Orders">
          <OrderList orders={os} onOpen={onOpen} />
        </Section>
      </DetailSheet>
    );
  }
  // Tile sheets: orders / sales / profit / buyers / avg
  const heading = { orders: 'Orders', sales: 'Sales', profit: 'Profit', buyers: 'Buyers', avg: 'Average Order' }[sheet.kind];
  const sum = (list: MerchOrder[], f: (o: MerchOrder) => number) => r2(list.reduce((n, o) => n + f(o), 0));
  return (
    <DetailSheet title={heading} sub={sub} onClose={onClose}>
      <Split
        items={
          sheet.kind === 'profit'
            ? [
                ['Sales', money(s.sales), ''],
                ['Item Costs', s.profit === null ? '—' : money(sum(s.orders, (o) => o.cost ?? 0)), s.profit === null ? `known for ${s.costKnown} of ${s.orders.length}` : 'Fourthwall base cost'],
                ['Tips', money(s.tips), ''],
                ['Profit', money(s.profit), p && p.profit !== null ? `${money(p.profit)} before` : ''],
              ]
            : sheet.kind === 'buyers'
              ? [
                  ['Buyers', n0(s.buyers.size), p ? `${n0(p.buyers.size)} before` : ''],
                  ['Repeat', n0([...s.buyers.values()].filter((l) => l.length > 1).length), 'more than one order'],
                  ['New', n0([...s.buyers.keys()].filter((k) => !data.orders.some((o) => buyerKey(o) === k && !o.cancelled && o.day < range.from)).length), 'first order in range'],
                ]
              : [
                  ['Orders', n0(s.orders.length), p ? `${n0(p.orders.length)} before` : ''],
                  ['Sales', money(s.sales), p ? `${money(p.sales)} before` : ''],
                  ['Discounts', money(sum(s.orders, (o) => o.discount)), ''],
                  ['Refunds', money(sum(s.orders, (o) => o.refunded)), s.cancelled.length ? `${s.cancelled.length} cancelled` : ''],
                ]
        }
      />
      <Section title="Over Time">
        <SalesChart orders={s.orders} range={range} />
      </Section>
      {sheet.kind === 'buyers' ? (
        <Section title="People">
          <ul className="bee-list">
            {[...s.buyers.entries()].map(([key, os]) => (
              <li key={key} className="bee-list__row">
                <button type="button" className="link-btn" style={{ textAlign: 'left' }} onClick={() => onOpen({ kind: 'buyer', key })}>
                  {buyerName(os[0])}
                </button>
                <span className="bee-list__meta">
                  {os.length} order{os.length === 1 ? '' : 's'} · {money(sum(os, (o) => o.sales))}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Section title="Orders">
          <OrderList orders={s.orders} onOpen={onOpen} />
        </Section>
      )}
    </DetailSheet>
  );
}
