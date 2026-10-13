import { useEffect, useState } from 'react';
import { DashTitle, InfoTip } from './dash/InfoTip';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BeeBing, BeeClarity, BeeClarityRow } from '../api/types';

/** Bing (on the Google Search tab) and Clarity (on the Website tab) panels
 * for the Bedford Bee dashboard. Rules: worker/src/bee/bing.ts, clarity.ts. */

const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number | null | undefined, d = 1) => (n == null ? '—' : `${(n * 100).toFixed(d)}%`);
const pctRaw = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(n < 10 ? 1 : 0)}%`);
const pos = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));
const toMs = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const STALE_MS = 2 * 24 * 60 * 60 * 1000;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDate = (iso: string | null) =>
  iso
    ? new Date(toMs(iso)).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';
const path = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? 'Home Page' : decodeURIComponent(u.pathname);
  } catch {
    return url;
  }
};
const secs = (n: number | null | undefined) => {
  if (n == null) return '—';
  const s = Math.round(n);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
export const apiError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.match(/\{.*\}$/);
  try {
    return j ? ((JSON.parse(j[0]).error as string) ?? m) : m;
  } catch {
    return m;
  }
};

export function BeeBingSection({ range }: { range?: { from: string; to: string } }) {
  const [data, setData] = useState<BeeBing | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api
      .getBeeBing(range ? { from: range.from, to: range.to } : undefined)
      .then(setData)
      .catch(() => setData(null));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.from, range?.to]);
  if (!data) return null;
  async function sync() {
    setBusy(true);
    try {
      const r = await api.syncBeeBing();
      setMsg(`Synced ${r.weeks} weeks · ${n0(r.queries)} search rows.`);
      await load();
    } catch (e) {
      setMsg(apiError(e));
    } finally {
      setBusy(false);
    }
  }
  if (data.empty) {
    return (
      <section className="bee-section">
        <div className="bee-section__head">
          <h2 className="bee-section__title">Bing</h2>
        </div>
        <div className="fin-dash__card">
          {data.connection.connected ? (
            <>
              <p>
                {data.connection.site
                  ? `Bing is connected (${data.connection.site}) but has no search data yet — new sites can take a few days.`
                  : 'Your Bing key is saved. Bing is rate-limiting the shared network MikeOS runs on, so MikeOS retries every couple of hours until it gets through.'}
              </p>
              <button type="button" className="btn btn--sm" onClick={sync} disabled={busy}>
                {busy ? 'Syncing…' : 'Sync Now'}
              </button>
            </>
          ) : (
            <p>
              Bing also powers DuckDuckGo, Yahoo and Copilot results. Paste a Bing Webmaster API key in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link>.
            </p>
          )}
          {(msg || data.connection.lastError) && <p className="fin-dash__note">{msg ?? data.connection.lastError}</p>}
        </div>
      </section>
    );
  }
  const p = data.period;
  const c = data.connection;
  // Bing throttles Cloudflare's shared IPs, so a sync can fail for days —
  // say how fresh the numbers are, and flag it once the last good pull is
  // more than 2 days old (it should land nightly).
  const stale = c.lastOkAt ? Date.now() - new Date(c.lastOkAt).getTime() > STALE_MS : !!c.lastError;
  const ch = p.prev.clicks ? (p.now.clicks - p.prev.clicks) / p.prev.clicks : null;
  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Bing</h2>
        <InfoTip label="About Bing">
          <p>Bing also powers DuckDuckGo, Yahoo and Copilot results. Bing only reports by week, so the range uses the {data.range.last4.length} week{data.range.last4.length === 1 ? '' : 's'} starting inside it, compared with the same number of weeks before. History since {fmtDate(data.range.from)}.</p>
        </InfoTip>
        {c.dataThrough && <span className={stale ? 'fin-dash__neg' : 'fin-dash__muted'}>Data through {fmtDate(c.dataThrough)}{stale ? ' · Bing hasn’t synced lately' : ''}</span>}
      </div>
      <div className="fin-dash__stats">
        <Stat label="Clicks" value={n0(p.now.clicks)} sub={ch === null ? `${data.range.last4.length} weeks` : `${ch >= 0 ? '+' : '−'}${Math.abs(ch * 100).toFixed(0)}% vs weeks before`} />
        <Stat label="Impressions" value={n0(p.now.impressions)} />
        <Stat label="Click Rate" value={pct(p.now.ctr)} />
        <Stat label="Crawl Issues" value={n0(data.issues.length)} sub={data.issues.length ? 'see below' : 'none reported'} />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Top Searches on Bing</h3>
          <Rows
            rows={data.topQueries.map((q) => ({
              key: q.query!,
              main: q.query!,
              stats: `${n0(q.clicks)} clicks · ${n0(q.impressions)} impr · pos ${pos(q.position)}`,
            }))}
            empty="No searches yet."
          />
        </section>
        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">Top Pages on Bing</h3>
          <Rows
            rows={data.topPages.map((q) => ({
              key: q.page!,
              main: path(q.page!),
              stats: `${n0(q.clicks)} clicks · ${n0(q.impressions)} impr`,
            }))}
            empty="No pages yet."
          />
        </section>
        <section className="fin-dash__card">
          <DashTitle info={<p>Average position 8–20 over the last ~3 months, 10+ impressions.</p>}>Almost on Page One (Bing)</DashTitle>
          <Rows
            rows={data.strikingDistance.map((q) => ({
              key: q.query!,
              main: q.query!,
              stats: `pos ${pos(q.position)} · ${n0(q.impressions)} impr`,
            }))}
            empty="Nothing in striking distance yet."
          />
        </section>
        <section className="fin-dash__card">
          <DashTitle info={<p>Same search, 5+ positions apart. Ranking well on one engine but not the other usually means a title or page that one engine reads differently.</p>}>
            Bing vs Google
          </DashTitle>
          <Rows
            rows={data.compare.map((c) => ({
              key: c.query,
              main: c.query,
              stats: `Bing ${pos(c.bingPos)} · Google ${pos(c.googlePos)}`,
              tone: c.bingPos < c.googlePos ? 'up' : 'down',
            }))}
            empty="No big differences (needs both connected and 10+ impressions on each)."
          />
        </section>
        {data.issues.length > 0 && (
          <section className="fin-dash__card fin-dash__card--full">
            <h3 className="fin-dash__card-title">Crawl Issues Bing Reports</h3>
            <Rows
              rows={data.issues.map((i) => ({
                key: i.url,
                main: path(i.url),
                stats: `${i.issue}${i.http_code ? ` · HTTP ${i.http_code}` : ''}`,
              }))}
              empty=""
            />
          </section>
        )}
        <section className="fin-dash__card fin-dash__card--full">
          <div className="fin-dash__card-head">
            <h3 className="fin-dash__card-title">Bing Connection</h3>
            <button type="button" className="btn btn--ghost btn--sm" onClick={sync} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
          <p className="fin-dash__muted">
            {c.site} · {data.range.weeks} weeks of searches · data through {fmtDate(c.dataThrough)}
          </p>
          <p className={stale ? 'fin-dash__neg' : 'fin-dash__muted'}>
            Last successful sync: {c.lastOkAt ? when(c.lastOkAt) : 'not recorded yet'}
            {c.lastError && c.lastSyncAt ? ` · last try ${when(c.lastSyncAt)} failed` : ''}
          </p>
          {(msg || c.lastError) && <p className="fin-dash__note">{msg ?? c.lastError}</p>}
        </section>
      </div>
    </section>
  );
}

export function BeeClaritySection({ range }: { range?: { from: string; to: string } }) {
  const [data, setData] = useState<BeeClarity | null>(null);
  useEffect(() => {
    api
      .getBeeClarity(range ? { from: range.from, to: range.to } : undefined)
      .then(setData)
      .catch(() => setData(null));
  }, [range?.from, range?.to]);
  if (!data) return null;
  if (data.empty) {
    return (
      <section className="bee-section">
        <div className="bee-section__head">
          <h2 className="bee-section__title">Reading Behavior (Microsoft Clarity)</h2>
        </div>
        <div className="fin-dash__card">
          {data.connection.connected ? (
            <p>Clarity is connected — the first daily snapshot arrives tonight.</p>
          ) : (
            <p>
              Paste a Clarity API token in <Link to="/settings?cat=bee">Settings → Bedford Bee</Link> to see scroll depth, rage and dead clicks per page.
            </p>
          )}
          {data.connection.lastError && <p className="fin-dash__note">{data.connection.lastError}</p>}
        </div>
      </section>
    );
  }
  const s = data.site;
  return (
    <section className="bee-section">
      <div className="bee-section__head">
        <h2 className="bee-section__title">Reading Behavior (Microsoft Clarity)</h2>
        <span className="fin-dash__muted">
          {data.range.windowDays} day{data.range.windowDays === 1 ? '' : 's'} of snapshots in this range · collecting since {fmtDate(data.range.from)}
        </span>
      </div>
      <div className="fin-dash__stats">
        <Stat label="Scroll Depth" value={pctRaw(s?.scrollDepth)} sub="how far down the page, on average" />
        <Stat label="Active Time" value={secs(s?.activeTime)} sub="per session, on average" />
        <Stat label="Rage Clicks" value={pctRaw(s?.rageClicks)} sub="of sessions" />
        <Stat label="Bot Sessions" value={s ? n0(s.bots) : '—'} sub={s ? `vs ${n0(s.sessions)} real sessions` : undefined} />
      </div>
      <div className="fin-dash__grid">
        <section className="fin-dash__card fin-dash__card--full">
          <DashTitle info={<p>Average scroll depth per page (5+ sessions). Low depth on a long post means readers stop early — look at its heatmap in Clarity to see where.</p>}>
            How Far People Read
          </DashTitle>
          <ClarityTable rows={data.readDepth} />
        </section>
        <section className="fin-dash__card">
          <DashTitle info={<p>Rage clicks (repeated clicking) + dead clicks (clicking something that isn’t a link) in 5%+ of sessions.</p>}>Pages Frustrating Readers</DashTitle>
          <Rows
            rows={data.frustrated.map((p) => ({
              key: p.key,
              main: path(p.key),
              stats: `rage ${pctRaw(p.rageClicks)} · dead ${pctRaw(p.deadClicks)} · ${n0(p.sessions)} sessions`,
            }))}
            empty="Nothing frustrating readers."
          />
        </section>
        <section className="fin-dash__card">
          <h3 className="fin-dash__card-title">By Source &amp; Device</h3>
          <Rows
            rows={[...data.sources, ...data.devices].map((p, i) => ({
              key: `${i}-${p.key}`,
              main: p.key,
              stats: `${n0(p.sessions)} sessions · scroll ${pctRaw(p.scrollDepth)} · ${secs(p.activeTime)}`,
            }))}
            empty="No data yet."
          />
        </section>
        <section className="fin-dash__card fin-dash__card--full">
          <p className="fin-dash__muted">
            Clarity’s API only gives the last day, so MikeOS saves a snapshot every night — history grows from the day it was connected. Recordings and heatmaps:{' '}
            <a href={data.projectUrl} target="_blank" rel="noopener noreferrer">
              open Clarity
            </a>
            .{data.connection.lastError ? ` Last error: ${data.connection.lastError}` : ''}
          </p>
        </section>
      </div>
    </section>
  );
}

function ClarityTable({ rows }: { rows: BeeClarityRow[] }) {
  if (!rows.length) return <p className="fin-dash__muted">Not enough sessions per page yet.</p>;
  return (
    <div className="fin-dash__table-wrap">
      <table className="fin-dash__table bee-posts">
        <thead>
          <tr>
            <th>Page</th>
            <th className="num">Sessions</th>
            <th className="num">Scroll Depth</th>
            <th className="num bee-hide-sm">Active Time</th>
            <th className="num bee-hide-sm">Quick Backs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key}>
              <td className="bee-posts__title">{path(p.key)}</td>
              <td className="num">{n0(p.sessions)}</td>
              <td className={`num${p.scrollDepth !== null && p.scrollDepth < 35 ? ' bee-delta--down' : ''}`}>{pctRaw(p.scrollDepth)}</td>
              <td className="num bee-hide-sm">{secs(p.activeTime)}</td>
              <td className="num bee-hide-sm">{pctRaw(p.quickBacks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rows({ rows, empty }: { rows: { key: string; main: string; stats: string; tone?: 'up' | 'down' }[]; empty: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return empty ? <p className="fin-dash__muted">{empty}</p> : null;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <>
      <ul className="bee-list">
        {shown.map((r) => (
          <li key={r.key} className="bee-list__row bee-gsc__row">
            <span className="bee-gsc__page">{r.main}</span>
            <span className={`bee-list__meta${r.tone === 'up' ? ' bee-delta--up' : r.tone === 'down' ? ' bee-delta--down' : ''}`}>{r.stats}</span>
          </li>
        ))}
      </ul>
      {rows.length > 8 && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show Fewer' : `Show All ${rows.length}`}
        </button>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="fin-dash__stat">
      <span className="fin-dash__stat-label">{label}</span>
      <span className="fin-dash__stat-value">{value}</span>
      {sub && <span className="fin-dash__stat-sub">{sub}</span>}
    </div>
  );
}
