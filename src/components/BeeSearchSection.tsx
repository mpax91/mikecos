import { useEffect, useMemo, useState } from 'react';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { RangePicker } from './dash/RangePicker';
import { clampRange } from './dash/useUrlRange';
import { type DateRange, BEE_START, bucketFor, bucketStart, bucketsIn, dayMs, rangeText, nyToday } from '../utils/dateRange';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeSearch, BeeSearchDetail } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

/** Bedford Bee → SEO → Google (Search Console). Rules live in
 * worker/src/bee/search.ts. Follows the page's shared date range (the API
 * takes from/to and compares with the period before); every tile, search
 * and page opens a detail sheet (`/api/bee/search/detail`). The to-do
 * lists stay on the last 90 days on purpose (Mike, 2026-10-11). */

const TOTAL_COLOR = '#2A6FB0';
const DISCOVERY_COLOR = '#C0662E';

const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 15).getTime();
};
const fmtDate = (iso: string | null) =>
  iso
    ? new Date(toMs(iso)).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';
const fmtShort = (iso: string) =>
  new Date(toMs(iso)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number | null | undefined, d = 1) => (n == null ? '—' : `${(n * 100).toFixed(d)}%`);
const pos = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));
const path = (url: string | null | undefined) => {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.pathname === '/' ? 'Home Page' : decodeURIComponent(u.pathname);
  } catch {
    return url;
  }
};
function change(now: number, prev: number, label: string, invert = false): { text: string; tone: '' | 'up' | 'down' } {
  if (!prev && !now) return { text: '', tone: '' };
  if (!prev) return { text: `new vs ${label}`, tone: invert ? 'down' : 'up' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' };
  const better = invert ? d < 0 : d > 0;
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: better ? 'up' : 'down' };
}
const toneClass = (t: '' | 'up' | 'down') => (t === 'up' ? ' bee-delta--up' : t === 'down' ? ' bee-delta--down' : '');
const prevLabelOf = (r: DateRange) => (r.key === 'ytd' ? 'last year' : r.key === 'custom' || r.key === 'all' ? 'the period before' : `prior ${r.key.toUpperCase()}`);

export function BeeSearchSection({ range: rangeIn, setRange }: { range: DateRange; setRange: (r: DateRange) => void }) {
  const [data, setData] = useState<BeeSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [first, setFirst] = useState<string>(BEE_START);
  const range = clampRange(rangeIn, first);
  const load = () =>
    api
      .getBeeSearch({ from: range.from, to: range.to })
      .then((d) => {
        setData(d);
        if (!d.empty && d.range.from !== first) setFirst(d.range.from);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  async function sync() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.syncBeeGsc();
      setMsg(`Synced through ${fmtDate(r.to)} · ${n0(r.rows)} search rows${r.indexChecked ? ` · ${r.indexChecked} pages checked for indexing` : ''}.`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  if (error) return <p className="fin-dash__muted">{error}</p>;
  if (!data) return <p className="fin-dash__muted">Loading…</p>;
  const c = data.connection;

  if (data.empty) {
    return (
      <section className="bee-section">
        <div className="bee-section__head">
          <h2 className="bee-section__title">Google Search</h2>
        </div>
        <div className="fin-dash__card">
          {c.connected ? (
            <>
              <p>Search Console is connected ({c.email}). Pull its 16 months of history:</p>
              <button type="button" className="btn btn--sm" onClick={sync} disabled={syncing}>
                {syncing ? 'Syncing… (a minute the first time)' : 'Sync Now'}
              </button>
            </>
          ) : (
            <p>
              Connect Search Console in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> with the Bee’s Google account (thebedfordbee@gmail.com). MikeOS then pulls the 16 months Google keeps
              and every day after.
            </p>
          )}
          {(msg || c.lastError) && <p className="fin-dash__note">{msg ?? c.lastError}</p>}
        </div>
      </section>
    );
  }

  return <SearchBody data={data} range={range} setRange={setRange} onSync={sync} syncing={syncing} msg={msg} />;
}

type Loaded = Extract<BeeSearch, { empty: false }>;
type Sheet = { kind: 'metric'; metric: 'clicks' | 'impressions' | 'ctr' | 'discovery' } | { kind: 'query' | 'page'; key: string; ninety?: boolean };

function SearchBody({ data, range, setRange, onSync, syncing, msg }: { data: Loaded; range: DateRange; setRange: (r: DateRange) => void; onSync: () => void; syncing: boolean; msg: string | null }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const p = data.period;
  const cur = data.range.current;
  const prevR = data.range.previous;
  const label = prevLabelOf(range);
  const discovery = p.namedClicks - p.brandClicks;
  const clicksCh = change(p.now.clicks, p.prev.clicks, label);
  const imprCh = change(p.now.impressions, p.prev.impressions, label);
  const ctrCh = change(p.now.ctr, p.prev.ctr, label);
  const notIndexed = data.indexing.filter((i) => !i.indexed);
  const clipped = range.from < data.range.from;
  const open90 = (key: string) => setSheet({ kind: 'query', key, ninety: true });

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Google Search</h2>
      </div>
      <div className="dash-controls dash-controls--solo">
        <RangePicker value={range} onChange={setRange} today={nyToday()} earliest={data.range.from} />
        <span className="dash-controls__range-text">
          {rangeText(cur)} · vs {rangeText(prevR)}{' '}
          <InfoTip label="About these numbers">
            <p>From Google Search Console. Google runs 2–3 days behind, so the range ends on the last day it has reported ({fmtDate(data.range.to)}).</p>
            <p>History starts {fmtDate(data.range.from)}{clipped ? ' — earlier dates in this range have no data yet.' : '.'} Tap any number, search or page for its detail.</p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <Tile label="Clicks" value={n0(p.now.clicks)} sub={clicksCh.text} tone={clicksCh.tone} onClick={() => setSheet({ kind: 'metric', metric: 'clicks' })} />
        <Tile label="Impressions" value={n0(p.now.impressions)} sub={imprCh.text} tone={imprCh.tone} onClick={() => setSheet({ kind: 'metric', metric: 'impressions' })} />
        <Tile label="Click Rate" value={pct(p.now.ctr)} sub={ctrCh.text || `avg position ${pos(p.now.position)}`} tone={ctrCh.tone} onClick={() => setSheet({ kind: 'metric', metric: 'ctr' })} />
        <Tile
          label="Discovery Clicks"
          value={n0(discovery)}
          sub={p.namedClicks ? `${pct(discovery / p.namedClicks, 0)} of named clicks` : 'not searching the Bee by name'}
          onClick={() => setSheet({ kind: 'metric', metric: 'discovery' })}
        />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Clicks per {bucketFor(cur)} in the range. Tap a tile above for impressions, click rate and position.</p>}>Clicks Over Time</DashTitle>
          <TrendChart daily={data.daily} range={cur} metric="clicks" />
        </section>

        <ActionCard
          title="Almost on Page One"
          hint="Last 90 days, whatever range is picked. Searches where you average position 8–20 — a sharper title, more depth, or a link from a related post can move these onto page one. Tap one for its trend."
          empty="Nothing in striking distance yet (needs 20+ impressions)."
          onOpen={open90}
          rows={data.strikingDistance.map((q) => ({ key: q.query, main: q.query, sub: path(q.page), stats: `pos ${pos(q.position)} · ${n0(q.impressions)} impr · ${n0(q.clicks)} clicks` }))}
        />
        <ActionCard
          title="Titles Not Earning Clicks"
          hint="Last 90 days. On page one but clicked less than half as often as that position usually gets — rewrite the title or meta description."
          empty="No under-performing titles (needs 30+ impressions)."
          onOpen={open90}
          rows={data.lowCtr.map((q) => ({ key: q.query, main: q.query, sub: path(q.page), stats: `pos ${pos(q.position)} · ${pct(q.ctr)} vs ~${pct(q.expectedCtr, 0)} typical` }))}
        />
        <ActionCard
          title="New Searches"
          hint="Seen for the first time in the last 14 days — early signs of what Bedford is looking for. Post into it while it’s live."
          empty="No brand-new searches in the last 14 days."
          onOpen={open90}
          rows={data.newQueries.map((q) => ({ key: q.query, main: q.query, sub: q.page ? path(q.page) : undefined, stats: `first ${fmtShort(q.first)} · ${n0(q.impressions)} impr · pos ${pos(q.position)}` }))}
        />
        <ActionCard
          title="Content Gaps"
          hint="Last 90 days. Searches you appear for but rank past page two — nothing answers them well yet. Candidates for a dedicated post or evergreen page."
          empty="No gaps with 20+ impressions."
          onOpen={open90}
          rows={data.contentGaps.map((q) => ({ key: q.query, main: q.query, sub: path(q.page), stats: `pos ${pos(q.position)} · ${n0(q.impressions)} impr` }))}
        />
        <ActionCard
          title="Pages Competing With Each Other"
          hint="Last 90 days. Two or more of your pages splitting the same search. Link them, or fold one into the other, so Google has one clear answer."
          empty="No competing pages."
          onOpen={open90}
          rows={data.competing.map((q) => ({ key: q.query, main: q.query, sub: q.pages.map((pg) => `${path(pg.page)} (${n0(pg.impressions)})`).join(' · '), stats: `${n0(q.impressions)} impr` }))}
        />
        <section className="fin-dash__card">
          <DashTitle info={<p>Clicks (or impressions, when clicks didn’t move) in the range vs the period before. Tap a page for its detail.</p>}>Rising &amp; Falling Pages</DashTitle>
          {data.rising.length || data.falling.length ? (
            <ul className="bee-list">
              {[...data.rising.map((m) => ({ ...m, up: true })), ...data.falling.map((m) => ({ ...m, up: false }))].map((m) => (
                <li key={`${m.up}-${m.page}`} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: m.page })}>
                  <span className="bee-gsc__page">{path(m.page)}</span>
                  <span className={`bee-list__meta ${m.up ? 'bee-delta--up' : 'bee-delta--down'}`}>
                    {m.up ? '▲' : '▼'} {m.clicks !== m.prevClicks ? `${m.prevClicks} → ${m.clicks} clicks` : `${n0(m.prevImpressions)} → ${n0(m.impressions)} impressions`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No big moves.</p>
          )}
        </section>

        <RowsCard
          title="Top Searches"
          info="Google hides rare searches for privacy, so these add up to less than the total clicks. Tap a search for its trend and the pages that rank for it."
          rows={data.topQueries.map((q) => ({ key: q.query, label: q.query, badge: q.brand ? 'Brand' : undefined, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position, prevClicks: q.prevClicks }))}
          firstCol="Search"
          onOpen={(key) => setSheet({ kind: 'query', key })}
        />
        <RowsCard
          title="Top Pages"
          info="Tap a page for its trend and the searches that bring people to it."
          rows={data.topPages.map((pg) => ({ key: pg.page, label: path(pg.page), clicks: pg.clicks, impressions: pg.impressions, ctr: pg.ctr, position: pg.position, prevClicks: pg.prevClicks }))}
          firstCol="Page"
          onOpen={(key) => setSheet({ kind: 'page', key })}
        />

        <section className="fin-dash__card">
          <DashTitle info={<p>Devices and top countries in the range.</p>}>Devices &amp; Countries</DashTitle>
          <ul className="bee-list">
            {[...data.devices, ...data.countries.slice(0, 5)].map((d, i) => (
              <li key={`${i}-${d.value}`} className="bee-list__row">
                <span>{d.value.length === 3 ? d.value.toUpperCase() : d.value.charAt(0).toUpperCase() + d.value.slice(1)}</span>
                <span className="bee-list__meta">
                  {n0(d.clicks)} clicks · {n0(d.impressions)} impr
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="fin-dash__card">
          <DashTitle info={<p>Calendar years, whatever range is picked. Google keeps 16 months; MikeOS keeps every day it has pulled, so this grows from here.</p>}>By Year</DashTitle>
          <ul className="bee-list">
            {data.years.map((y) => (
              <li key={y.year} className="bee-list__row">
                <span>
                  {y.year}
                  <span className="fin-dash__muted"> · from {fmtShort(y.first)}</span>
                </span>
                <span className="bee-list__meta">
                  {n0(y.clicks)} clicks · {n0(y.impressions)} impressions
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Pages in your sitemap changed in the last 30 days, checked with Google’s URL Inspection. Re-checked every couple of days until indexed. Tap a page for its search numbers.</p>}>
            Indexing Watch
          </DashTitle>
          {data.indexing.length ? (
            <>
              <p className="bee-gsc__index-summary">
                {data.indexing.length - notIndexed.length} of {data.indexing.length} indexed
                {notIndexed.length ? <span className="fin-dash__neg"> · {notIndexed.length} not yet</span> : null}
              </p>
              <ul className="bee-list">
                {[...notIndexed, ...data.indexing.filter((i) => i.indexed)].slice(0, 15).map((i) => (
                  <li key={i.url} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: i.url })}>
                    <span className="bee-gsc__page">{path(i.url)}</span>
                    <span className={`bee-list__meta${i.indexed ? '' : ' fin-dash__neg'}`}>
                      {i.coverage ?? (i.indexed ? 'Indexed' : 'Not indexed')}
                      {i.lastCrawl ? ` · crawled ${fmtShort(i.lastCrawl)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="fin-dash__muted">No recent sitemap pages checked yet — runs after each sync once the site’s sitemap lists pages with dates.</p>
          )}
        </section>
      </div>

      <div className="dash-footer">
        <span>
          {data.connection.connected ? `${data.connection.site} via ${data.connection.email}` : 'Search Console disconnected — history is kept'}
          {data.connection.lastSyncAt ? ` · synced ${new Date(data.connection.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
        <InfoTip label="About syncing">
          <p>Syncs nightly; each sync re-pulls the last few days because Google revises them. Data through {fmtDate(data.connection.lastDate)}.</p>
        </InfoTip>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
        {(msg || data.connection.lastError) && <span className="fin-dash__note">{msg ?? data.connection.lastError}</span>}
      </div>

      {sheet?.kind === 'metric' && <MetricSheet data={data} metric={sheet.metric} range={range} onClose={() => setSheet(null)} onOpen={setSheet} />}
      {(sheet?.kind === 'query' || sheet?.kind === 'page') && (
        <SearchDetailSheet kind={sheet.kind} keyText={sheet.key} range={sheet.ninety ? { from: addDaysIso(data.range.to, -89), to: data.range.to } : cur} ninety={!!sheet.ninety} onClose={() => setSheet(null)} onOpen={setSheet} />
      )}
    </section>
  );
}

const addDaysIso = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

function Tile({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: '' | 'up' | 'down'; onClick: () => void }) {
  return (
    <button type="button" className="fin-dash__stat" onClick={onClick}>
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className={`fin-dash__stat-sub${toneClass(tone ?? '')}`}>{sub}</span>}
    </button>
  );
}

type DailyRow = { date: string; clicks: number; impressions: number; position: number | null };
function TrendChart({ daily, range, metric, height = 220 }: { daily: DailyRow[]; range: { from: string; to: string }; metric: 'clicks' | 'impressions' | 'ctr' | 'position'; height?: number }) {
  const series = useMemo<LineSeries[]>(() => {
    const bucket = bucketFor(range);
    const buckets = bucketsIn(range, bucket);
    const acc = new Map(buckets.map((b) => [b, { c: 0, i: 0, pw: 0 }]));
    for (const d of daily) {
      const a = acc.get(bucketStart(d.date, bucket));
      if (!a) continue;
      a.c += d.clicks;
      a.i += d.impressions;
      a.pw += (d.position ?? 0) * d.impressions;
    }
    const pts = (f: (a: { c: number; i: number; pw: number }) => number | null) =>
      buckets.map((b) => ({ x: dayMs(b), y: f(acc.get(b)!) })).filter((p): p is { x: number; y: number } => p.y != null);
    if (metric === 'clicks') return [{ name: 'Clicks', color: TOTAL_COLOR, points: pts((a) => a.c) }];
    if (metric === 'impressions') return [{ name: 'Impressions', color: TOTAL_COLOR, points: pts((a) => a.i) }];
    if (metric === 'ctr') return [{ name: 'Click rate %', color: TOTAL_COLOR, points: pts((a) => (a.i ? (a.c / a.i) * 100 : null)) }];
    return [{ name: 'Avg position', color: TOTAL_COLOR, points: pts((a) => (a.i ? a.pw / a.i : null)) }];
  }, [daily, range, metric]);
  if ((series[0]?.points.length ?? 0) < 2) return <p className="fin-dash__muted">Not enough days in this range for a trend.</p>;
  const bucket = bucketFor(range);
  return (
    <FinanceLineChart
      series={series}
      formatY={(v) => (metric === 'ctr' ? `${v.toFixed(1)}%` : metric === 'position' ? v.toFixed(1) : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : n0(v))}
      formatX={(ms) => new Date(ms).toLocaleDateString('en-US', bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })}
      ariaLabel={`Google search ${metric} over time`}
      height={height}
      yFromZero={metric !== 'position'}
    />
  );
}

function MetricSheet({ data, metric, range, onClose, onOpen }: { data: Loaded; metric: 'clicks' | 'impressions' | 'ctr' | 'discovery'; range: DateRange; onClose: () => void; onOpen: (s: Sheet) => void }) {
  const p = data.period;
  const cur = data.range.current;
  const title = { clicks: 'Clicks', impressions: 'Impressions', ctr: 'Click Rate', discovery: 'Discovery Clicks' }[metric];
  const sub = `${range.label} · ${rangeText(cur)}`;
  if (metric === 'discovery') {
    const full = data.monthly.filter((m, i) => i < data.monthly.length - 1 || m.days >= 20);
    return (
      <DetailSheet title={title} sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Discovery', n0(p.namedClicks - p.brandClicks), 'not searching the Bee by name'],
            ['Brand', n0(p.brandClicks), '“bedford bee” and similar'],
            ['Share', p.namedClicks ? pct((p.namedClicks - p.brandClicks) / p.namedClicks, 0) : '—', 'of clicks Google names'],
          ]}
        />
        <p className="fin-dash__muted">Discovery is the SEO growth number — people finding the Bee without already knowing it. Google hides rare searches, so brand + discovery is less than all clicks.</p>
        {full.length > 1 && (
          <div className="dash-sheet__section">
            <h4>By Month (All History)</h4>
            <FinanceLineChart
              series={[
                { name: 'Discovery', color: DISCOVERY_COLOR, points: full.map((m) => ({ x: toMs(`${m.month}-15`), y: m.discoveryClicks })) },
                { name: 'Brand', color: TOTAL_COLOR, points: full.map((m) => ({ x: toMs(`${m.month}-15`), y: m.brandClicks })) },
              ]}
              formatY={n0}
              formatX={fmtAxis}
              ariaLabel="Discovery and brand clicks by month"
              height={200}
            />
          </div>
        )}
        <div className="dash-sheet__section">
          <h4>Top Discovery Searches</h4>
          <QueryList rows={data.topQueries.filter((q) => !q.brand).slice(0, 15)} onOpen={(key) => onOpen({ kind: 'query', key })} />
        </div>
      </DetailSheet>
    );
  }
  const now = metric === 'clicks' ? p.now.clicks : metric === 'impressions' ? p.now.impressions : p.now.ctr;
  const prev = metric === 'clicks' ? p.prev.clicks : metric === 'impressions' ? p.prev.impressions : p.prev.ctr;
  const fmt = metric === 'ctr' ? (v: number) => pct(v) : n0;
  const ch = change(now, prev, prevLabelOf(range));
  const days = Math.max(1, data.daily.length);
  return (
    <DetailSheet title={title} sub={sub} onClose={onClose}>
      <Split
        items={[
          ['Total', fmt(now), ch.text],
          ['Before', fmt(prev), rangeText(data.range.previous)],
          metric === 'ctr' ? ['Avg Position', pos(p.now.position), `${pos(p.prev.position)} before`] : ['Per Day', n0(now / days), `${days} days of data`],
        ]}
      />
      <div className="dash-sheet__section">
        <h4>Over Time</h4>
        <TrendChart daily={data.daily} range={cur} metric={metric} height={200} />
      </div>
      {metric === 'ctr' && (
        <div className="dash-sheet__section">
          <h4>Average Position</h4>
          <TrendChart daily={data.daily} range={cur} metric="position" height={180} />
        </div>
      )}
      <div className="dash-sheet__section">
        <h4>Top Searches</h4>
        <QueryList rows={[...data.topQueries].sort((a, b) => (metric === 'impressions' ? b.impressions - a.impressions : b.clicks - a.clicks)).slice(0, 12)} onOpen={(key) => onOpen({ kind: 'query', key })} />
      </div>
      <div className="dash-sheet__section">
        <h4>Top Pages</h4>
        <ul className="bee-list">
          {[...data.topPages]
            .sort((a, b) => (metric === 'impressions' ? b.impressions - a.impressions : b.clicks - a.clicks))
            .slice(0, 10)
            .map((pg) => (
              <li key={pg.page} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen({ kind: 'page', key: pg.page })}>
                <span className="bee-gsc__page">{path(pg.page)}</span>
                <span className="bee-list__meta">
                  {n0(pg.clicks)} clicks · {n0(pg.impressions)} impr
                </span>
              </li>
            ))}
        </ul>
      </div>
    </DetailSheet>
  );
}

function QueryList({ rows, onOpen }: { rows: { query: string; clicks: number; impressions: number; position: number | null }[]; onOpen: (key: string) => void }) {
  if (!rows.length) return <p className="fin-dash__muted">None in this range.</p>;
  return (
    <ul className="bee-list">
      {rows.map((q) => (
        <li key={q.query} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen(q.query)}>
          <span>{q.query}</span>
          <span className="bee-list__meta">
            {n0(q.clicks)} clicks · {n0(q.impressions)} impr · pos {pos(q.position)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SearchDetailSheet({ kind, keyText, range, ninety, onClose, onOpen }: { kind: 'query' | 'page'; keyText: string; range: { from: string; to: string }; ninety: boolean; onClose: () => void; onOpen: (s: Sheet) => void }) {
  const [d, setD] = useState<BeeSearchDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api
      .getBeeSearchDetail(kind, keyText, range)
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, [kind, keyText, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = kind === 'page' ? path(keyText) : `“${keyText}”`;
  return (
    <DetailSheet title={title} sub={`${kind === 'page' ? 'Page' : 'Search'} · ${ninety ? 'last 90 days' : rangeText(range)}`} onClose={onClose}>
      {err ? (
        <p className="fin-dash__muted">{err}</p>
      ) : !d ? (
        <p className="fin-dash__muted">Loading…</p>
      ) : d.empty ? (
        <p className="fin-dash__muted">No data.</p>
      ) : (
        <>
          <Split
            items={[
              ['Clicks', n0(d.now.clicks), `${n0(d.prev.clicks)} before`],
              ['Impressions', n0(d.now.impressions), `${n0(d.prev.impressions)} before`],
              ['Click Rate', pct(d.now.ctr), `${pct(d.prev.ctr)} before`],
              ['Avg Position', pos(d.now.position), `${pos(d.prev.position)} before`],
            ]}
          />
          {kind === 'page' && (
            <p>
              <a href={keyText} target="_blank" rel="noopener noreferrer">
                Open Page ↗
              </a>
            </p>
          )}
          <div className="dash-sheet__section">
            <h4>Clicks</h4>
            <TrendChart daily={d.daily} range={d.range.current} metric="clicks" height={170} />
          </div>
          <div className="dash-sheet__section">
            <h4>Impressions</h4>
            <TrendChart daily={d.daily} range={d.range.current} metric="impressions" height={150} />
          </div>
          <div className="dash-sheet__section">
            <h4>Position</h4>
            <TrendChart daily={d.daily} range={d.range.current} metric="position" height={160} />
          </div>
          <div className="dash-sheet__section">
            <h4>{kind === 'query' ? 'Pages Ranking for It' : 'Searches Bringing People Here'}</h4>
            {d.breakdown.length ? (
              <ul className="bee-list">
                {d.breakdown.map((b) => (
                  <li key={b.key} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen({ kind: kind === 'query' ? 'page' : 'query', key: b.key })}>
                    <span className="bee-gsc__page">{kind === 'query' ? path(b.key) : b.key}</span>
                    <span className="bee-list__meta">
                      {n0(b.clicks)} clicks · {n0(b.impressions)} impr · pos {pos(b.position)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fin-dash__muted">{kind === 'page' ? 'Google hides the searches when each is rare.' : 'No pages recorded.'}</p>
            )}
          </div>
        </>
      )}
    </DetailSheet>
  );
}

function Split({ items }: { items: (string[] | [string, string, string])[] }) {
  return (
    <div className="dash-split">
      {items.map(([l, v, s]) => (
        <div key={l} className="dash-split__item">
          <span className="fin-dash__stat-label">{l}</span>
          <span className="dash-split__value">{v}</span>
          {s && <span className="fin-dash__stat-sub">{s}</span>}
        </div>
      ))}
    </div>
  );
}

type Row = { key: string; label: string; badge?: string; clicks: number; impressions: number; ctr: number; position: number | null; prevClicks: number };
function RowsCard({ title, info, rows, firstCol, onOpen }: { title: string; info: string; rows: Row[]; firstCol: string; onOpen: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 15);
  return (
    <section className="fin-dash__card fin-dash__card--full">
      <DashTitle info={<p>{info}</p>}>{title}</DashTitle>
      {rows.length ? (
        <>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>{firstCol}</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impressions</th>
                  <th className="num">Click Rate</th>
                  <th className="num">Position</th>
                  <th className="num">Before</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key} className="bee-social__row" onClick={() => onOpen(r.key)}>
                    <td className="bee-posts__title">
                      {r.label}
                      {r.badge && <span className="bee-badge bee-badge--muted bee-gsc__brand">{r.badge}</span>}
                    </td>
                    <td className="num">{n0(r.clicks)}</td>
                    <td className="num">{n0(r.impressions)}</td>
                    <td className="num">{pct(r.ctr)}</td>
                    <td className="num">{pos(r.position)}</td>
                    <td className="num">{n0(r.prevClicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {shown.map((r) => (
              <li key={r.key}>
                <button type="button" className="post-card" onClick={() => onOpen(r.key)}>
                  <div className="post-card__title">
                    {r.label}
                    {r.badge && <span className="bee-badge bee-badge--muted bee-gsc__brand">{r.badge}</span>}
                  </div>
                  <div className="post-card__metrics">
                    <span className="post-card__metric">
                      <span className="post-card__metric-label">Clicks</span>
                      <span className="post-card__metric-value">{n0(r.clicks)}</span>
                    </span>
                    <span className="post-card__metric">
                      <span className="post-card__metric-label">Impr</span>
                      <span className="post-card__metric-value">{n0(r.impressions)}</span>
                    </span>
                    <span className="post-card__metric">
                      <span className="post-card__metric-label">CTR</span>
                      <span className="post-card__metric-value">{pct(r.ctr)}</span>
                    </span>
                    <span className="post-card__metric">
                      <span className="post-card__metric-label">Position</span>
                      <span className="post-card__metric-value">{pos(r.position)}</span>
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="fin-dash__muted">None in this range.</p>
      )}
      {rows.length > 15 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Fewer' : `Show All ${rows.length}`}
        </button>
      )}
    </section>
  );
}

function ActionCard({ title, hint, empty, rows, onOpen }: { title: string; hint: string; empty: string; rows: { key: string; main: string; sub?: string; stats: string }[]; onOpen: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <section className="fin-dash__card">
      <DashTitle info={<p>{hint}</p>}>
        {title}
        {rows.length ? <span className="fin-dash__muted"> · {rows.length}</span> : null}
      </DashTitle>
      {rows.length ? (
        <ul className="bee-list">
          {shown.map((r) => (
            <li key={r.key} className="bee-list__row bee-gsc__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen(r.key)}>
              <span className="bee-person">
                <span>{r.main}</span>
                {r.sub && <span className="bee-person__email">{r.sub}</span>}
              </span>
              <span className="bee-list__meta">{r.stats}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-dash__muted">{empty}</p>
      )}
      {rows.length > 6 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Fewer' : `Show All ${rows.length}`}
        </button>
      )}
    </section>
  );
}
