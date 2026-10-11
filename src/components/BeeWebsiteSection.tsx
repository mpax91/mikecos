import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeAnalytics } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

/** Bedford Bee → Website (Google Analytics 4). Rules live in
 * worker/src/bee/analytics.ts; this renders them. */

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
function change(now: number, prev: number): { text: string; tone: '' | 'up' | 'down' } {
  if (!prev && !now) return { text: 'no change', tone: '' };
  if (!prev) return { text: 'new', tone: 'up' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: 'about the same', tone: '' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs prior 28 days`, tone: d > 0 ? 'up' : 'down' };
}

export function BeeWebsiteSection() {
  const [data, setData] = useState<BeeAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.getBeeAnalytics().then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
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
              <p>
                Google Analytics is connected ({c.propertyName}). Pull its history:
              </p>
              <button type="button" className="btn btn--sm" onClick={sync} disabled={syncing}>
                {syncing ? 'Syncing… (a minute or two the first time)' : 'Sync Now'}
              </button>
            </>
          ) : c.connected && !c.hasScope ? (
            <p>
              Your Google connection was made before Analytics was added. Click <strong>Reconnect</strong> in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> and allow “See and download your Google
              Analytics data.”
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
  return <WebsiteBody data={data} onSync={sync} syncing={syncing} msg={msg} />;
}

type Loaded = Extract<BeeAnalytics, { empty: false }>;

function WebsiteBody({ data, onSync, syncing, msg }: { data: Loaded; onSync: () => void; syncing: boolean; msg: string | null }) {
  const p = data.period;
  const months = data.monthly.filter((m, i) => i < data.monthly.length - 1 || m.days >= 20);
  const series = useMemo<LineSeries[]>(
    () => [
      { name: 'All Visits', color: TOTAL_COLOR, points: months.map((m) => ({ x: toMs(`${m.month}-15`), y: m.sessions })) },
      { name: 'From Social', color: SOCIAL_COLOR, points: months.map((m) => ({ x: toMs(`${m.month}-15`), y: m.social })) },
    ],
    [months]
  );
  const visitsCh = change(p.now.sessions, p.prev.sessions);
  const visitorsCh = p.visitors && p.prevVisitors ? change(p.visitors.users, p.prevVisitors.users) : { text: '', tone: '' as const };
  const engagedRate = p.now.sessions ? p.now.engaged / p.now.sessions : null;
  const prevEngaged = p.prev.sessions ? p.prev.engaged / p.prev.sessions : null;
  const social = data.platforms.filter((x) => x.social);
  const socialNow = social.reduce((n, x) => n + x.sessions, 0);
  const maxDow = Math.max(1, ...data.bestDays.map((d) => d.sessions));
  const blocks = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ from: h, sessions: data.bestHours.slice(h, h + 3).reduce((n, x) => n + x.sessions, 0) }));
  const maxBlock = Math.max(1, ...blocks.map((b) => b.sessions));
  const local = data.local;
  const multiHost = data.hosts.length > 1;

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Website</h2>
        <span className="fin-dash__muted">
          Last 28 days: {fmtShort(data.range.current.from)} – {fmtDate(data.range.current.to)} · history since {fmtDate(data.range.from)}
        </span>
      </div>

      <div className="fin-dash__stats">
        <Stat label="Visits" value={n0(p.now.sessions)} sub={visitsCh.text} tone={visitsCh.tone} swatch={TOTAL_COLOR} />
        <Stat label="Visitors" value={p.visitors ? n0(p.visitors.users) : '—'} sub={p.visitors ? `${n0(p.visitors.newUsers)} new · ${visitorsCh.text}` : undefined} tone={visitorsCh.tone} />
        <Stat
          label="Engaged Visits"
          value={pct(engagedRate)}
          sub={`${secs(p.now.sessions ? p.now.engagementSec / p.now.sessions : null)} avg per visit${prevEngaged !== null ? ` · was ${pct(prevEngaged)}` : ''}`}
        />
        <Stat label="From Social" value={n0(socialNow)} sub={p.now.sessions ? `${pct(socialNow / p.now.sessions)} of visits` : undefined} swatch={SOCIAL_COLOR} />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Visits by Month</h3>
          <FinanceLineChart series={series} formatY={n0} formatX={fmtAxis} ariaLabel="Website visits per month, all and from social media" />
          <p className="fin-dash__note">A visit = a GA4 session. The current month joins the chart once it has 20 days of data.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Local Reach</h3>
          <div className="bee-big">{pct(local.now.share)}</div>
          <p className="fin-dash__muted">
            of visits from Bedford-area towns in the last 28 days ({n0(local.now.local)} of {n0(local.now.total)}){local.prev.share !== null ? ` · prior 28 days ${pct(local.prev.share)}` : ''}.
          </p>
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
          <p className="fin-dash__note">Towns counted: {local.towns.join(', ')}. GA guesses city from the internet provider, so some locals show as nearby hubs (White Plains, New York).</p>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Where Visitors Come From</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Visits</th>
                  <th className="num">Prior 28 Days</th>
                  <th className="num" title="Visits lasting 10s+, with 2+ pages, or a conversion">
                    Engaged
                  </th>
                  <th className="num bee-hide-sm">Time / Visit</th>
                  <th className="num bee-hide-sm">Pages / Visit</th>
                  <th className="bee-hide-sm">Top Landing Pages (90 Days)</th>
                </tr>
              </thead>
              <tbody>
                {data.platforms.map((x) => (
                  <tr key={x.name}>
                    <td>
                      {x.name}
                      {x.social && <span className="bee-badge bee-badge--fwd bee-gsc__brand">Social</span>}
                    </td>
                    <td className="num">{n0(x.sessions)}</td>
                    <td className={`num ${x.sessions > x.prevSessions * 1.1 ? 'bee-delta--up' : x.sessions < x.prevSessions * 0.9 ? 'bee-delta--down' : 'fin-dash__muted'}`}>{n0(x.prevSessions)}</td>
                    <td className="num">{pct(x.engagedRate)}</td>
                    <td className="num bee-hide-sm">{secs(x.secPerSession)}</td>
                    <td className="num bee-hide-sm">{x.viewsPerSession === null ? '—' : x.viewsPerSession.toFixed(1)}</td>
                    <td className="bee-hide-sm bee-web__landing">{x.topLanding.map((l) => `${pageLabel(l.landing)} (${l.sessions})`).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fin-dash__note">
            Facebook and Instagram app visits often arrive without a referrer and land in Direct. Tag the links you post (for example <code>?utm_source=facebook&amp;utm_medium=social</code>) to count them exactly.
          </p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Clicks to Your Substack</h3>
          <p className="fin-dash__muted bee-spot__explain">Outbound clicks from the website to Substack (last 90 days) — which pages send readers toward subscribing.</p>
          {data.subscribeClicks.length ? (
            <ul className="bee-list">
              {data.subscribeClicks.map((s) => (
                <li key={s.path} className="bee-list__row">
                  <span className="bee-gsc__page">{pageLabel(s.path)}</span>
                  <span className="bee-list__meta">
                    {n0(s.clicks)} clicks{s.per100 !== null ? ` · ${s.per100.toFixed(1)} per 100 views` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">No clicks to Substack recorded. GA4’s “Outbound clicks” (Enhanced measurement, on by default) records them.</p>
          )}
          {data.outboundDomains.length > 0 && <p className="fin-dash__note">All outbound clicks: {data.outboundDomains.map((d) => `${d.domain} ${d.clicks}`).join(' · ')}.</p>}
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Do Google Visitors Stay?</h3>
          <p className="fin-dash__muted bee-spot__explain">Pages people land on from Google Search (last 90 days, 10+ visits). A low engaged share means the page doesn’t deliver what the search promised.</p>
          {data.searchLanding.length ? (
            <ul className="bee-list">
              {data.searchLanding.map((s) => (
                <li key={s.landing} className="bee-list__row">
                  <span className="bee-gsc__page">{pageLabel(s.landing)}</span>
                  <span className={`bee-list__meta${s.engagedRate < 0.4 ? ' fin-dash__neg' : ''}`}>
                    {n0(s.sessions)} visits · {pct(s.engagedRate)} engaged · {secs(s.secPerSession)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-dash__muted">Not enough Google visits per page yet.</p>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Pages (Last 90 Days)</h3>
          <div className="bee-year__tops">
            <div>
              <h4 className="fin-dash__subtitle">Most Viewed</h4>
              <ol className="bee-tops">
                {data.topPages.map((pg) => (
                  <li key={`${pg.host}${pg.path}`}>
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
              <h4 className="fin-dash__subtitle">Stickiest (Time per View, 25+ Views)</h4>
              <ol className="bee-tops">
                {data.stickiest.map((pg) => (
                  <li key={`${pg.host}${pg.path}`}>
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
          <h3 className="fin-dash__card-title">Best Days &amp; Times (90 Days)</h3>
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
          <p className="fin-dash__note">In the GA property’s time zone.</p>
        </section>

        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">By Year &amp; Device</h3>
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
                <span className="bee-list__meta">{n0(d.sessions)} visits (28 days)</span>
              </li>
            ))}
          </ul>
          {p.visitorsThisYear && (
            <p className="fin-dash__note">
              Unique visitors this year: {n0(p.visitorsThisYear.users)}
              {p.visitorsLastYear?.users ? ` · last year: ${n0(p.visitorsLastYear.users)}` : ''}.
            </p>
          )}
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Google Analytics Connection</h3>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <p className="fin-dash__muted">
            {data.connection.propertyName ?? data.connection.property} via {data.connection.email} · data through {fmtDate(data.connection.lastDate)} · syncs nightly
            {data.connection.lastSyncAt ? `, last ${new Date(data.connection.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.
          </p>
          {(msg || data.connection.lastError) && <p className="fin-dash__note">{msg ?? data.connection.lastError}</p>}
        </section>
      </div>
    </section>
  );
}

function Stat({ label, value, sub, tone, swatch }: { label: string; value: string; sub?: string; tone?: '' | 'up' | 'down'; swatch?: string }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">
        {swatch && <span className="bee-swatch" style={{ background: swatch }} />}
        {label}
      </span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className={`fin-dash__stat-sub${tone === 'up' ? ' bee-delta--up' : tone === 'down' ? ' bee-delta--down' : ''}`}>{sub}</span>}
    </div>
  );
}
