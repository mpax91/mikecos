import { useEffect, useMemo, useState } from 'react';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { DetailSheet } from './dash/DetailSheet';
import { RangePicker } from './dash/RangePicker';
import { clampRange } from './dash/useUrlRange';
import { type DateRange, BEE_START, bucketFor, bucketStart, bucketsIn, dayMs, rangeText, nyToday } from '../utils/dateRange';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeAnalytics, BeeAnalyticsDetail, BeeVisitors } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

/** Bedford Bee → Website (Google Analytics 4). Rules live in
 * worker/src/bee/analytics.ts. Follows the page's shared date range; unique
 * visitors come from /api/bee/analytics/visitors (cached, live for custom
 * ranges); sources and pages open /api/bee/analytics/detail. */

const TOTAL_COLOR = '#2A6FB0';
const SOCIAL_COLOR = '#C0662E';

const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 15).getTime();
};
const fmtDate = (iso: string | null) => (iso ? new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtShort = (iso: string) => new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtAxis = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number | null | undefined, d = 0) => (n == null ? '—' : `${(n * 100).toFixed(d)}%`);
const secs = (n: number | null | undefined) => {
  if (n == null) return '—';
  const s = Math.round(n);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const hourLabel = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const pageLabel = (p: string) => (p === '/' ? 'Home Page' : p);
export function BeeWebsiteSection({ range: rangeIn, setRange }: { range: DateRange; setRange: (r: DateRange) => void }) {
  const [data, setData] = useState<BeeAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [first, setFirst] = useState<string>(BEE_START);
  const range = clampRange(rangeIn, first);
  const load = () =>
    api
      .getBeeAnalytics({ from: range.from, to: range.to })
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
      const r = await api.syncBeeGa();
      setMsg(`Synced through ${fmtDate(r.to)}.`);
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
          <h2 className="bee-section__title">Website</h2>
        </div>
        <div className="fin-dash__card">
          {c.connected && c.property ? (
            <>
              <p>Google Analytics is connected ({c.propertyName}). Pull its history:</p>
              <button type="button" className="btn btn--sm" onClick={sync} disabled={syncing}>
                {syncing ? 'Syncing… (a minute or two the first time)' : 'Sync Now'}
              </button>
            </>
          ) : c.connected && !c.hasScope ? (
            <p>
              Your Google connection was made before Analytics was added. Click <strong>Reconnect</strong> in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> and allow “See and download
              your Google Analytics data.”
            </p>
          ) : c.connected ? (
            <p>Connected, but no Google Analytics property for thebedfordbee.com was found on {c.email}. Make sure that account has access to the property, then Reconnect.</p>
          ) : (
            <p>
              Connect Google in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> with the Bee’s account — one sign-in covers Search Console and Analytics.
            </p>
          )}
          {(msg || c.lastError) && <p className="fin-dash__note">{msg ?? c.lastError}</p>}
        </div>
      </section>
    );
  }
  return <WebsiteBody data={data} range={range} setRange={setRange} onSync={sync} syncing={syncing} msg={msg} />;
}

function change(now: number, prev: number, label: string): { text: string; tone: '' | 'up' | 'down' } {
  if (!prev && !now) return { text: '', tone: '' };
  if (!prev) return { text: `new vs ${label}`, tone: 'up' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: `≈ ${label}`, tone: '' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs ${label}`, tone: d > 0 ? 'up' : 'down' };
}
const toneClass = (t: '' | 'up' | 'down') => (t === 'up' ? ' bee-delta--up' : t === 'down' ? ' bee-delta--down' : '');
const prevLabelOf = (r: DateRange) => (r.key === 'ytd' ? 'last year' : r.key === 'custom' || r.key === 'all' ? 'the period before' : `prior ${r.key.toUpperCase()}`);

type Loaded = Extract<BeeAnalytics, { empty: false }>;
type Sheet = { kind: 'visits' | 'visitors' | 'engaged' | 'social' | 'local' } | { kind: 'platform' | 'page'; key: string };

function WebsiteBody({ data, range, setRange, onSync, syncing, msg }: { data: Loaded; range: DateRange; setRange: (r: DateRange) => void; onSync: () => void; syncing: boolean; msg: string | null }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [visitors, setVisitors] = useState<BeeVisitors | null>(null);
  const p = data.period;
  const cur = data.range.current;
  const label = prevLabelOf(range);
  useEffect(() => {
    setVisitors(null);
    api
      .getBeeVisitors(cur)
      .then(setVisitors)
      .catch(() => setVisitors({ now: null, prev: null, live: false }));
  }, [cur.from, cur.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const visitsCh = change(p.now.sessions, p.prev.sessions, label);
  const visitorsCh = visitors?.now && visitors.prev ? change(visitors.now.users, visitors.prev.users, label) : { text: '', tone: '' as const };
  const engagedRate = p.now.sessions ? p.now.engaged / p.now.sessions : null;
  const prevEngaged = p.prev.sessions ? p.prev.engaged / p.prev.sessions : null;
  const engCh = engagedRate != null && prevEngaged != null ? change(engagedRate, prevEngaged, label) : { text: '', tone: '' as const };
  const social = data.platforms.filter((x) => x.social);
  const socialNow = social.reduce((n, x) => n + x.sessions, 0);
  const socialPrev = social.reduce((n, x) => n + x.prevSessions, 0);
  const socialCh = change(socialNow, socialPrev, label);
  const maxDow = Math.max(1, ...data.bestDays.map((d) => d.sessions));
  const blocks = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ from: h, sessions: data.bestHours.slice(h, h + 3).reduce((n, x) => n + x.sessions, 0) }));
  const maxBlock = Math.max(1, ...blocks.map((b) => b.sessions));
  const local = data.local;
  const multiHost = data.hosts.length > 1;
  const clipped = range.from < data.range.from;

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Website</h2>
      </div>
      <div className="dash-controls dash-controls--solo">
        <RangePicker value={range} onChange={setRange} today={nyToday()} earliest={data.range.from} />
        <span className="dash-controls__range-text">
          {rangeText(cur)} · vs {rangeText(data.range.previous)}{' '}
          <InfoTip label="About these numbers">
            <p>From Google Analytics. A visit = a GA4 session; visitors are de-duplicated people (counted by Google for exactly this range).</p>
            <p>
              Data through {fmtDate(data.range.to)}; history starts {fmtDate(data.range.from)}
              {clipped ? ' — earlier dates in this range have no data yet' : ''}. Tap any number, source or page for its detail.
            </p>
          </InfoTip>
        </span>
      </div>

      <div className="fin-dash__stats">
        <Tile label="Visits" value={n0(p.now.sessions)} sub={visitsCh.text} tone={visitsCh.tone} onClick={() => setSheet({ kind: 'visits' })} />
        <Tile
          label="Visitors"
          value={visitors ? (visitors.now ? n0(visitors.now.users) : '—') : '…'}
          sub={visitors?.now ? visitorsCh.text || `${n0(visitors.now.newUsers)} new` : visitors ? 'not available' : 'asking Google…'}
          tone={visitorsCh.tone}
          onClick={() => setSheet({ kind: 'visitors' })}
        />
        <Tile label="Engaged Visits" value={pct(engagedRate)} sub={engCh.text || `${secs(p.now.sessions ? p.now.engagementSec / p.now.sessions : null)} avg per visit`} tone={engCh.tone} onClick={() => setSheet({ kind: 'engaged' })} />
        <Tile label="From Social" value={n0(socialNow)} sub={socialCh.text || (p.now.sessions ? `${pct(socialNow / p.now.sessions)} of visits` : '')} tone={socialCh.tone} onClick={() => setSheet({ kind: 'social' })} />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card">
          <DashTitle info={<p>Visits per {bucketFor(cur)} in the range. Tap the Visits tile for the numbers.</p>}>Visits Over Time</DashTitle>
          <VisitsChart daily={data.daily} range={cur} />
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Towns counted: {local.towns.join(', ')}. GA guesses city from the internet provider, so some locals show as nearby hubs (White Plains, New York). Tap for the trend by month.</p>}>
            Local Reach
          </DashTitle>
          <button type="button" className="bee-local__big" onClick={() => setSheet({ kind: 'local' })}>
            <span className="bee-big">{pct(local.now.share)}</span>
            <span className="fin-dash__muted">
              of visits from Bedford-area towns ({n0(local.now.local)} of {n0(local.now.total)}){local.prev.share !== null ? ` · ${pct(local.prev.share)} before` : ''} ›
            </span>
          </button>
          <ul className="bee-list">
            {data.cities.map((ct) => (
              <li key={`${ct.city}-${ct.region}`} className="bee-list__row">
                <span>
                  {ct.city === '(not set)' ? 'Unknown' : ct.city}
                  <span className="fin-dash__muted">{ct.region && ct.region !== '(not set)' ? `, ${ct.region}` : ''}</span>
                  {ct.local && <span className="bee-badge bee-gsc__brand">Local</span>}
                </span>
                <span className="bee-list__meta">{n0(ct.sessions)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle
            info={
              <p>
                Visits in the range by where they came from, vs the period before. Facebook and Instagram app visits often arrive without a referrer and land in Direct — tag the links you post (for
                example <code>?utm_source=facebook&amp;utm_medium=social</code>) to count them exactly. Tap a source for its trend and landing pages.
              </p>
            }
          >
            Where Visitors Come From
          </DashTitle>
          <div className="fin-dash__table-wrap post-table">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Visits</th>
                  <th className="num">Before</th>
                  <th className="num">Engaged</th>
                  <th className="num">Time / Visit</th>
                  <th className="num">Pages / Visit</th>
                  <th>Top Landing Pages</th>
                </tr>
              </thead>
              <tbody>
                {data.platforms.map((x) => (
                  <tr key={x.name} className="bee-social__row" onClick={() => setSheet({ kind: 'platform', key: x.name })}>
                    <td>
                      {x.name}
                      {x.social && <span className="bee-badge bee-badge--fwd bee-gsc__brand">Social</span>}
                    </td>
                    <td className="num">{n0(x.sessions)}</td>
                    <td className={`num ${x.sessions > x.prevSessions * 1.1 ? 'bee-delta--up' : x.sessions < x.prevSessions * 0.9 ? 'bee-delta--down' : 'fin-dash__muted'}`}>{n0(x.prevSessions)}</td>
                    <td className="num">{pct(x.engagedRate)}</td>
                    <td className="num">{secs(x.secPerSession)}</td>
                    <td className="num">{x.viewsPerSession === null ? '—' : x.viewsPerSession.toFixed(1)}</td>
                    <td className="bee-web__landing">{x.topLanding.slice(0, 3).map((l) => `${pageLabel(l.landing)} (${l.sessions})`).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="post-cards">
            {data.platforms.map((x) => (
              <li key={x.name}>
                <button type="button" className="post-card" onClick={() => setSheet({ kind: 'platform', key: x.name })}>
                  <div className="post-card__title">
                    {x.name}
                    {x.social && <span className="bee-badge bee-badge--fwd bee-gsc__brand">Social</span>}
                  </div>
                  <div className="post-card__metrics">
                    <Metric label="Visits" value={n0(x.sessions)} tone={x.sessions > x.prevSessions * 1.1 ? 'up' : x.sessions < x.prevSessions * 0.9 ? 'down' : ''} />
                    <Metric label="Before" value={n0(x.prevSessions)} />
                    <Metric label="Engaged" value={pct(x.engagedRate)} />
                    <Metric label="Time" value={secs(x.secPerSession)} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Outbound clicks from the website to Substack in the range — which pages send readers toward subscribing. Tap a page for its traffic.</p>}>Clicks to Your Substack</DashTitle>
          {data.subscribeClicks.length ? (
            <ul className="bee-list">
              {data.subscribeClicks.map((s) => (
                <li key={s.path} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: s.path })}>
                  <span className="bee-gsc__page">{pageLabel(s.path)}</span>
                  <span className="bee-list__meta">
                    {n0(s.clicks)} clicks{s.per100 !== null ? ` · ${s.per100.toFixed(1)} per 100 views` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No clicks to Substack in this range.</p>
          )}
          {data.outboundDomains.length > 0 && <p className="fin-dash__note">All outbound clicks: {data.outboundDomains.map((d) => `${d.domain} ${d.clicks}`).join(' · ')}.</p>}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Pages people land on from Google Search in the range (10+ visits). A low engaged share means the page doesn’t deliver what the search promised. Tap a page for its traffic.</p>}>
            Do Google Visitors Stay?
          </DashTitle>
          {data.searchLanding.length ? (
            <ul className="bee-list">
              {data.searchLanding.map((s) => (
                <li key={s.landing} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: s.landing })}>
                  <span className="bee-gsc__page">{pageLabel(s.landing)}</span>
                  <span className={`bee-list__meta${s.engagedRate < 0.4 ? ' fin-dash__neg' : ''}`}>
                    {n0(s.sessions)} visits · {pct(s.engagedRate)} engaged · {secs(s.secPerSession)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">Not enough Google visits per page in this range.</p>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Most viewed pages in the range, and the stickiest (time per view, 25+ views). Tap a page for where its visits come from.</p>}>Pages</DashTitle>
          <div className="bee-year__tops">
            <div>
              <h4 className="fin-dash__subtitle">Most Viewed</h4>
              <ol className="bee-tops">
                {data.topPages.map((pg) => (
                  <li key={`${pg.host}${pg.path}`} className="bee-tops__click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: pg.path })}>
                    <span className="bee-tops__title" title={`${pg.host}${pg.path}`}>
                      {pg.title || pageLabel(pg.path)}
                      {multiHost && <span className="fin-dash__muted"> · {pg.host}</span>}
                    </span>
                    <span className="bee-tops__metric">{n0(pg.views)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h4 className="fin-dash__subtitle">Stickiest</h4>
              <ol className="bee-tops">
                {data.stickiest.map((pg) => (
                  <li key={`${pg.host}${pg.path}`} className="bee-tops__click" role="button" tabIndex={0} onClick={() => setSheet({ kind: 'page', key: pg.path })}>
                    <span className="bee-tops__title" title={`${pg.host}${pg.path}`}>
                      {pg.title || pageLabel(pg.path)}
                    </span>
                    <span className="bee-tops__metric">{secs(pg.secPerView)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          {multiHost && <p className="fin-dash__note">Views by site: {data.hosts.map((h) => `${h.host} ${n0(h.views)}`).join(' · ')}.</p>}
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Visits in the range by day of week and 3-hour block, in the GA property’s time zone.</p>}>Best Days &amp; Times</DashTitle>
          <div className="bee-bars">
            {data.bestDays.map((d) => (
              <div key={d.day} className="bee-bars__row bee-bars__row--static">
                <span className="bee-bars__label">{d.day}</span>
                <span className="bee-bars__track">
                  <span className="bee-bars__bar" style={{ width: `${(d.sessions / maxDow) * 100}%` }} />
                </span>
                <span className="bee-bars__value">{n0(d.sessions)}</span>
              </div>
            ))}
          </div>
          <h4 className="fin-dash__subtitle">Time of Day</h4>
          <div className="bee-bars">
            {blocks.map((b) => (
              <div key={b.from} className="bee-bars__row bee-bars__row--static">
                <span className="bee-bars__label">
                  {hourLabel(b.from)}–{hourLabel((b.from + 3) % 24)}
                </span>
                <span className="bee-bars__track">
                  <span className="bee-bars__bar" style={{ width: `${(b.sessions / maxBlock) * 100}%` }} />
                </span>
                <span className="bee-bars__value">{n0(b.sessions)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Years are calendar years, whatever range is picked; devices follow the range.</p>}>By Year &amp; Device</DashTitle>
          <ul className="bee-list">
            {data.years.map((y) => (
              <li key={y.year} className="bee-list__row">
                <span>
                  {y.year}
                  <span className="fin-dash__muted"> · from {fmtShort(y.first)}</span>
                </span>
                <span className="bee-list__meta">
                  {n0(y.sessions)} visits · {n0(y.views)} views
                </span>
              </li>
            ))}
            {data.devices.map((d) => (
              <li key={d.device} className="bee-list__row">
                <span>{d.device.charAt(0).toUpperCase() + d.device.slice(1)}</span>
                <span className="bee-list__meta">{n0(d.sessions)} visits</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="dash-footer">
        <span>
          {data.connection.propertyName ?? data.connection.property} via {data.connection.email}
          {data.connection.lastSyncAt ? ` · synced ${new Date(data.connection.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
        <InfoTip label="About syncing">
          <p>Syncs nightly (re-pulling the last 3 days, which GA revises). Data through {fmtDate(data.connection.lastDate)}.</p>
        </InfoTip>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
        {(msg || data.connection.lastError) && <span className="fin-dash__note">{msg ?? data.connection.lastError}</span>}
      </div>

      {sheet && 'key' in sheet ? (
        <AnalyticsDetailSheet kind={sheet.kind} keyText={sheet.key} range={cur} onClose={() => setSheet(null)} onOpen={setSheet} />
      ) : sheet ? (
        <MetricSheet kind={sheet.kind} data={data} range={range} visitors={visitors} onClose={() => setSheet(null)} onOpen={setSheet} />
      ) : null}
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

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: '' | 'up' | 'down' }) {
  return (
    <span className="post-card__metric">
      <span className="post-card__metric-label">{label}</span>
      <span className={`post-card__metric-value${toneClass(tone)}`}>{value}</span>
    </span>
  );
}

function Split({ items }: { items: [string, string, string][] }) {
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

function VisitsChart({ daily, range, metric = 'sessions', height = 220 }: { daily: { date: string; sessions: number; views?: number; engaged?: number }[]; range: { from: string; to: string }; metric?: 'sessions' | 'engaged'; height?: number }) {
  const series = useMemo<LineSeries[]>(() => {
    const bucket = bucketFor(range);
    const buckets = bucketsIn(range, bucket);
    const acc = new Map(buckets.map((b) => [b, { s: 0, e: 0 }]));
    for (const d of daily) {
      const a = acc.get(bucketStart(d.date, bucket));
      if (!a) continue;
      a.s += d.sessions;
      a.e += d.engaged ?? 0;
    }
    return metric === 'engaged'
      ? [{ name: 'Engaged %', color: TOTAL_COLOR, points: buckets.filter((b) => acc.get(b)!.s).map((b) => ({ x: dayMs(b), y: (acc.get(b)!.e / acc.get(b)!.s) * 100 })) }]
      : [{ name: 'Visits', color: TOTAL_COLOR, points: buckets.map((b) => ({ x: dayMs(b), y: acc.get(b)!.s })) }];
  }, [daily, range, metric]);
  if ((series[0]?.points.length ?? 0) < 2) return <p className="fin-dash__muted">Not enough days in this range for a trend.</p>;
  const bucket = bucketFor(range);
  return (
    <FinanceLineChart
      series={series}
      formatY={(v) => (metric === 'engaged' ? `${Math.round(v)}%` : n0(v))}
      formatX={(ms) => new Date(ms).toLocaleDateString('en-US', bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' })}
      ariaLabel="Website visits over time"
      height={height}
    />
  );
}

function PlatformList({ data, onOpen, socialOnly }: { data: Loaded; onOpen: (s: Sheet) => void; socialOnly?: boolean }) {
  const rows = data.platforms.filter((x) => !socialOnly || x.social);
  if (!rows.length) return <p className="fin-dash__muted">None in this range.</p>;
  return (
    <ul className="bee-list">
      {rows.map((x) => (
        <li key={x.name} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen({ kind: 'platform', key: x.name })}>
          <span>{x.name}</span>
          <span className="bee-list__meta">
            {n0(x.sessions)} visits · {n0(x.prevSessions)} before · {pct(x.engagedRate)} engaged
          </span>
        </li>
      ))}
    </ul>
  );
}

function MetricSheet({ kind, data, range, visitors, onClose, onOpen }: { kind: 'visits' | 'visitors' | 'engaged' | 'social' | 'local'; data: Loaded; range: DateRange; visitors: BeeVisitors | null; onClose: () => void; onOpen: (s: Sheet) => void }) {
  const p = data.period;
  const cur = data.range.current;
  const sub = `${range.label} · ${rangeText(cur)}`;
  const days = Math.max(1, data.daily.length);
  if (kind === 'visits')
    return (
      <DetailSheet title="Visits" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Visits', n0(p.now.sessions), `${n0(p.prev.sessions)} before`],
            ['Per Day', n0(p.now.sessions / days), `${days} days of data`],
            ['Page Views', n0(p.now.views), `${(p.now.sessions ? p.now.views / p.now.sessions : 0).toFixed(1)} per visit`],
          ]}
        />
        <div className="dash-sheet__section">
          <h4>Over Time</h4>
          <VisitsChart daily={data.daily} range={cur} height={200} />
        </div>
        <div className="dash-sheet__section">
          <h4>By Source</h4>
          <PlatformList data={data} onOpen={onOpen} />
        </div>
      </DetailSheet>
    );
  if (kind === 'visitors')
    return (
      <DetailSheet title="Visitors" sub={sub} onClose={onClose}>
        {visitors?.now ? (
          <>
            <Split
              items={[
                ['Visitors', n0(visitors.now.users), visitors.prev ? `${n0(visitors.prev.users)} before` : ''],
                ['New', n0(visitors.now.newUsers), visitors.now.users ? `${pct(visitors.now.newUsers / visitors.now.users)} of visitors` : ''],
                ['Returning', n0(Math.max(0, visitors.now.users - visitors.now.newUsers)), ''],
                ['Visits Each', visitors.now.users ? (p.now.sessions / visitors.now.users).toFixed(1) : '—', 'visits per visitor'],
              ]}
            />
            <p className="fin-dash__muted">
              People are counted once however often they came back, so this can’t be split by day.{visitors.live ? ' Counted by Google just now for this range.' : ''}
              {p.visitorsThisYear ? ` This year so far: ${n0(p.visitorsThisYear.users)}${p.visitorsLastYear?.users ? `; last year ${n0(p.visitorsLastYear.users)}` : ''}.` : ''}
            </p>
          </>
        ) : (
          <p className="fin-dash__muted">{visitors ? 'Google didn’t return a visitor count for this range.' : 'Asking Google…'}</p>
        )}
      </DetailSheet>
    );
  if (kind === 'engaged') {
    const rate = p.now.sessions ? p.now.engaged / p.now.sessions : null;
    return (
      <DetailSheet title="Engaged Visits" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['Engaged', pct(rate), p.prev.sessions ? `${pct(p.prev.engaged / p.prev.sessions)} before` : ''],
            ['Time / Visit', secs(p.now.sessions ? p.now.engagementSec / p.now.sessions : null), p.prev.sessions ? `${secs(p.prev.engagementSec / p.prev.sessions)} before` : ''],
            ['Engaged Visits', n0(p.now.engaged), `of ${n0(p.now.sessions)}`],
          ]}
        />
        <p className="fin-dash__muted">Engaged = stayed 10+ seconds, saw 2+ pages, or converted.</p>
        <div className="dash-sheet__section">
          <h4>Over Time</h4>
          <VisitsChart daily={data.daily} range={cur} metric="engaged" height={180} />
        </div>
        <div className="dash-sheet__section">
          <h4>Least Engaging Google Landings</h4>
          <ul className="bee-list">
            {[...data.searchLanding]
              .sort((a, b) => a.engagedRate - b.engagedRate)
              .slice(0, 8)
              .map((s) => (
                <li key={s.landing} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen({ kind: 'page', key: s.landing })}>
                  <span className="bee-gsc__page">{pageLabel(s.landing)}</span>
                  <span className="bee-list__meta">
                    {pct(s.engagedRate)} engaged · {n0(s.sessions)} visits
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </DetailSheet>
    );
  }
  if (kind === 'social') {
    const social = data.platforms.filter((x) => x.social);
    const now = social.reduce((n, x) => n + x.sessions, 0);
    const prev = social.reduce((n, x) => n + x.prevSessions, 0);
    const months = data.monthly.filter((m, i) => i < data.monthly.length - 1 || m.days >= 20);
    return (
      <DetailSheet title="Visits From Social" sub={sub} onClose={onClose}>
        <Split
          items={[
            ['From Social', n0(now), `${n0(prev)} before`],
            ['Share', p.now.sessions ? pct(now / p.now.sessions) : '—', 'of all visits'],
          ]}
        />
        <p className="fin-dash__muted">Facebook and Instagram app visits often arrive without a referrer and count as Direct, so this is a floor.</p>
        <div className="dash-sheet__section">
          <h4>By Platform</h4>
          <PlatformList data={data} onOpen={onOpen} socialOnly />
        </div>
        {months.length > 1 && (
          <div className="dash-sheet__section">
            <h4>By Month (All History)</h4>
            <FinanceLineChart
              series={[
                { name: 'All Visits', color: TOTAL_COLOR, points: months.map((m) => ({ x: toMs(`${m.month}-15`), y: m.sessions })) },
                { name: 'From Social', color: SOCIAL_COLOR, points: months.map((m) => ({ x: toMs(`${m.month}-15`), y: m.social })) },
              ]}
              formatY={n0}
              formatX={fmtAxis}
              ariaLabel="Visits per month, all and from social"
              height={200}
            />
          </div>
        )}
      </DetailSheet>
    );
  }
  // local
  const lm = data.local.byMonth.filter((m) => m.total > 0);
  return (
    <DetailSheet title="Local Reach" sub={sub} onClose={onClose}>
      <Split
        items={[
          ['Local Share', pct(data.local.now.share), data.local.prev.share != null ? `${pct(data.local.prev.share)} before` : ''],
          ['Local Visits', n0(data.local.now.local), `of ${n0(data.local.now.total)}`],
        ]}
      />
      {lm.length > 1 && (
        <div className="dash-sheet__section">
          <h4>Local Share by Month</h4>
          <FinanceLineChart
            series={[{ name: 'Local share %', color: TOTAL_COLOR, points: lm.map((m) => ({ x: toMs(`${m.month}-15`), y: (m.local / m.total) * 100 })) }]}
            formatY={(v) => `${Math.round(v)}%`}
            formatX={fmtAxis}
            ariaLabel="Share of visits from Bedford-area towns by month"
            height={180}
          />
        </div>
      )}
      <div className="dash-sheet__section">
        <h4>Top Cities</h4>
        <ul className="bee-list">
          {data.cities.map((ct) => (
            <li key={`${ct.city}-${ct.region}`} className="bee-list__row">
              <span>
                {ct.city === '(not set)' ? 'Unknown' : ct.city}
                {ct.local && <span className="bee-badge bee-gsc__brand">Local</span>}
              </span>
              <span className="bee-list__meta">{n0(ct.sessions)}</span>
            </li>
          ))}
        </ul>
      </div>
    </DetailSheet>
  );
}

function AnalyticsDetailSheet({ kind, keyText, range, onClose, onOpen }: { kind: 'platform' | 'page'; keyText: string; range: { from: string; to: string }; onClose: () => void; onOpen: (s: Sheet) => void }) {
  const [d, setD] = useState<BeeAnalyticsDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api
      .getBeeAnalyticsDetail(kind, keyText, range)
      .then(setD)
      .catch((e: Error) => setErr(e.message));
  }, [kind, keyText, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <DetailSheet title={kind === 'page' ? pageLabel(keyText) : keyText} sub={`${kind === 'page' ? 'Page' : 'Source'} · ${rangeText(range)}`} onClose={onClose}>
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
              [kind === 'page' ? 'Landed Here' : 'Visits', n0(d.now.sessions), `${n0(d.prev.sessions)} before`],
              ['Engaged', pct(d.now.engagedRate), d.prev.engagedRate != null ? `${pct(d.prev.engagedRate)} before` : ''],
              ['Time / Visit', secs(d.now.secPerSession), ''],
              ...(kind === 'page' && d.now.pageViews != null ? ([['Page Views', n0(d.now.pageViews), 'incl. visits that started elsewhere']] as [string, string, string][]) : []),
            ]}
          />
          <div className="dash-sheet__section">
            <h4>Over Time</h4>
            <VisitsChart daily={d.daily} range={d.range.current} height={180} />
          </div>
          <div className="dash-sheet__section">
            <h4>{kind === 'platform' ? 'Landing Pages' : 'Where These Visits Came From'}</h4>
            {d.breakdown.length ? (
              <ul className="bee-list">
                {d.breakdown.map((b) => (
                  <li key={b.key} className="bee-list__row bee-list__row--click" role="button" tabIndex={0} onClick={() => onOpen({ kind: kind === 'platform' ? 'page' : 'platform', key: b.key })}>
                    <span className="bee-gsc__page">{kind === 'platform' ? pageLabel(b.key) : b.key}</span>
                    <span className="bee-list__meta">
                      {n0(b.sessions)} visits · {pct(b.engagedRate)} engaged
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fin-dash__muted">Nothing in this range.</p>
            )}
          </div>
        </>
      )}
    </DetailSheet>
  );
}
