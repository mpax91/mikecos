import { useEffect, useMemo, useState } from 'react';
import { DashTitle } from './dash/InfoTip';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeSearch } from '../api/types';
import { FinanceLineChart } from './FinanceLineChart';
import type { LineSeries } from './FinanceLineChart';

/** Bedford Bee → Google Search (Search Console). Rules live in
 * worker/src/bee/search.ts; this only renders them. */

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
function change(now: number, prev: number, invert = false): { text: string; tone: '' | 'up' | 'down' } {
  if (!prev && !now) return { text: 'no change', tone: '' };
  if (!prev) return { text: 'new', tone: invert ? 'down' : 'up' };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.05) return { text: 'about the same', tone: '' };
  const better = invert ? d < 0 : d > 0;
  return {
    text: `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}% vs prior 28 days`,
    tone: better ? 'up' : 'down',
  };
}

export function BeeSearchSection() {
  const [data, setData] = useState<BeeSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api
      .getBeeSearch()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

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

  return <SearchBody data={data} onSync={sync} syncing={syncing} msg={msg} />;
}

type Loaded = Extract<BeeSearch, { empty: false }>;

function SearchBody({ data, onSync, syncing, msg }: { data: Loaded; onSync: () => void; syncing: boolean; msg: string | null }) {
  const p = data.period;
  // A month with under 20 days of data (the current one) would read as a crash.
  const fullMonths = data.monthly.filter((m, i) => i < data.monthly.length - 1 || m.days >= 20);
  const discovery = p.namedClicks - p.brandClicks;
  const series = useMemo<LineSeries[]>(
    () => [
      {
        name: 'All Clicks',
        color: TOTAL_COLOR,
        points: fullMonths.map((m) => ({
          x: toMs(`${m.month}-15`),
          y: m.clicks,
        })),
      },
      {
        name: 'Discovery (Non-Brand)',
        color: DISCOVERY_COLOR,
        points: fullMonths.map((m) => ({
          x: toMs(`${m.month}-15`),
          y: m.discoveryClicks,
        })),
      },
    ],
    [fullMonths],
  );
  const impr = useMemo<LineSeries[]>(
    () => [
      {
        name: 'Impressions',
        color: TOTAL_COLOR,
        points: fullMonths.map((m) => ({
          x: toMs(`${m.month}-15`),
          y: m.impressions,
        })),
      },
    ],
    [fullMonths],
  );
  const clicksCh = change(p.now.clicks, p.prev.clicks);
  const imprCh = change(p.now.impressions, p.prev.impressions);
  const posCh = p.now.position && p.prev.position ? change(p.now.position, p.prev.position, true) : { text: '', tone: '' as const };
  const notIndexed = data.indexing.filter((i) => !i.indexed);

  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Google Search</h2>
        <span className="fin-dash__muted">
          Last 28 days: {fmtShort(data.range.current.from)} – {fmtDate(data.range.current.to)} · history since {fmtDate(data.range.from)}
        </span>
      </div>

      <div className="fin-dash__stats">
        <Stat label="Clicks" value={n0(p.now.clicks)} sub={clicksCh.text} tone={clicksCh.tone} />
        <Stat label="Impressions" value={n0(p.now.impressions)} sub={imprCh.text} tone={imprCh.tone} />
        <Stat label="Click Rate" value={pct(p.now.ctr)} sub={`Avg position ${pos(p.now.position)}${posCh.text ? ` · ${posCh.text.replace(' vs prior 28 days', '')}` : ''}`} />
        <Stat
          label="Discovery Clicks"
          value={n0(discovery)}
          sub={p.namedClicks ? `${pct(discovery / p.namedClicks, 0)} of clicks from people not searching “Bedford Bee”` : 'Searches that aren’t for the Bee by name'}
          swatch={DISCOVERY_COLOR}
        />
      </div>

      <div className="fin-dash__grid">
        <section className="fin-dash__card">
          <DashTitle
            info={
              <p>
                Discovery = searches that don’t name the Bee — the SEO growth number. Brand searches (“bedford bee”) are people who already know you. The current month joins the chart once it has 20
                days of data.
              </p>
            }
          >
            Clicks by Month
          </DashTitle>
          <FinanceLineChart series={series} formatY={n0} formatX={fmtAxis} ariaLabel="Google search clicks per month, all and non-brand" />
        </section>
        <section className="fin-dash__card">
          <DashTitle info={<p>How often a Bee page showed up in Google results at all.</p>}>Impressions by Month</DashTitle>
          <FinanceLineChart series={impr} formatY={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : n0(v))} formatX={fmtAxis} ariaLabel="Google search impressions per month" />
        </section>

        <ActionCard
          title="Almost on Page One"
          hint="Searches where you average position 8–20 (last 90 days). A sharper title, more depth, or a link from a related post can move these onto page one."
          empty="Nothing in striking distance yet (needs 20+ impressions)."
          rows={data.strikingDistance.map((q) => ({
            key: q.query,
            main: q.query,
            sub: path(q.page),
            stats: `pos ${pos(q.position)} · ${n0(q.impressions)} impr · ${n0(q.clicks)} clicks`,
          }))}
        />
        <ActionCard
          title="Titles Not Earning Clicks"
          hint="On page one but clicked less than half as often as that position usually gets — rewrite the title or meta description."
          empty="No under-performing titles (needs 30+ impressions)."
          rows={data.lowCtr.map((q) => ({
            key: q.query,
            main: q.query,
            sub: path(q.page),
            stats: `pos ${pos(q.position)} · ${pct(q.ctr)} vs ~${pct(q.expectedCtr, 0)} typical`,
          }))}
        />
        <ActionCard
          title="New Searches"
          hint="Seen for the first time in the last 14 days — early signs of what Bedford is looking for. Post into it while it’s live."
          empty="No brand-new searches in the last 14 days."
          rows={data.newQueries.map((q) => ({
            key: q.query,
            main: q.query,
            sub: q.page ? path(q.page) : undefined,
            stats: `first ${fmtShort(q.first)} · ${n0(q.impressions)} impr · pos ${pos(q.position)}`,
          }))}
        />
        <ActionCard
          title="Content Gaps"
          hint="Searches you appear for but rank past page two (last 90 days) — nothing answers them well yet. Candidates for a dedicated post or evergreen page."
          empty="No gaps with 20+ impressions."
          rows={data.contentGaps.map((q) => ({
            key: q.query,
            main: q.query,
            sub: path(q.page),
            stats: `pos ${pos(q.position)} · ${n0(q.impressions)} impr`,
          }))}
        />
        <ActionCard
          title="Pages Competing With Each Other"
          hint="Two or more of your pages splitting the same search. Link them, or fold one into the other, so Google has one clear answer."
          empty="No competing pages."
          rows={data.competing.map((q) => ({
            key: q.query,
            main: q.query,
            sub: q.pages.map((pg) => `${path(pg.page)} (${n0(pg.impressions)})`).join(' · '),
            stats: `${n0(q.impressions)} impr`,
          }))}
        />
        <section className="fin-dash__card">
          <DashTitle info={<p>Clicks (or impressions, when clicks didn’t move), last 28 days vs the 28 before.</p>}>Rising &amp; Falling Pages</DashTitle>
          {data.rising.length || data.falling.length ? (
            <ul className="bee-list">
              {[...data.rising.map((m) => ({ ...m, up: true })), ...data.falling.map((m) => ({ ...m, up: false }))].map((m) => (
                <li key={`${m.up}-${m.page}`} className="bee-list__row">
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

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Pages in your sitemap changed in the last 30 days, checked with Google’s URL Inspection. Re-checked every couple of days until indexed.</p>}>Indexing Watch</DashTitle>
          {data.indexing.length ? (
            <>
              <p className="bee-gsc__index-summary">
                {data.indexing.length - notIndexed.length} of {data.indexing.length} indexed
                {notIndexed.length ? <span className="fin-dash__neg"> · {notIndexed.length} not yet</span> : null}
              </p>
              <ul className="bee-list">
                {[...notIndexed, ...data.indexing.filter((i) => i.indexed)].slice(0, 15).map((i) => (
                  <li key={i.url} className="bee-list__row">
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="bee-gsc__page">
                      {path(i.url)}
                    </a>
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

        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Google hides rare searches for privacy, so these add up to less than the total clicks.</p>}>Top Searches (Last 28 Days)</DashTitle>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>Search</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impressions</th>
                  <th className="num">Click Rate</th>
                  <th className="num">Position</th>
                  <th className="num bee-hide-sm">Prior 28 Days</th>
                </tr>
              </thead>
              <tbody>
                {data.topQueries.map((q) => (
                  <tr key={q.query}>
                    <td className="bee-posts__title">
                      {q.query}
                      {q.brand && <span className="bee-badge bee-badge--muted bee-gsc__brand">Brand</span>}
                    </td>
                    <td className="num">{n0(q.clicks)}</td>
                    <td className="num">{n0(q.impressions)}</td>
                    <td className="num">{pct(q.ctr)}</td>
                    <td className="num">{pos(q.position)}</td>
                    <td className="num bee-hide-sm">{n0(q.prevClicks)} clicks</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card fin-dash__card--full">
          <h3 className="fin-dash__card-title">Top Pages (Last 28 Days)</h3>
          <div className="fin-dash__table-wrap">
            <table className="fin-dash__table bee-posts">
              <thead>
                <tr>
                  <th>Page</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impressions</th>
                  <th className="num">Click Rate</th>
                  <th className="num">Position</th>
                  <th className="num bee-hide-sm">Prior 28 Days</th>
                </tr>
              </thead>
              <tbody>
                {data.topPages.map((pg) => (
                  <tr key={pg.page}>
                    <td className="bee-posts__title">
                      <a href={pg.page} target="_blank" rel="noopener noreferrer">
                        {path(pg.page)}
                      </a>
                    </td>
                    <td className="num">{n0(pg.clicks)}</td>
                    <td className="num">{n0(pg.impressions)}</td>
                    <td className="num">{pct(pg.ctr)}</td>
                    <td className="num">{pos(pg.position)}</td>
                    <td className="num bee-hide-sm">{n0(pg.prevClicks)} clicks</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="fin-dash__card">
          <DashTitle info={<p>Google keeps 16 months; MikeOS keeps every day it has pulled, so this grows from here.</p>}>By Year</DashTitle>
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
        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Devices &amp; Countries (28 Days)</h3>
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

        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Search Console Connection</h3>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <p className="fin-dash__muted">
            {data.connection.connected ? `${data.connection.site} via ${data.connection.email}` : 'Disconnected — history is kept.'} · data through {fmtDate(data.connection.lastDate)} (Google runs
            ~2–3 days behind) · syncs nightly
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

function ActionCard({ title, hint, empty, rows }: { title: string; hint: string; empty: string; rows: { key: string; main: string; sub?: string; stats: string }[] }) {
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
            <li key={r.key} className="bee-list__row bee-gsc__row">
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
