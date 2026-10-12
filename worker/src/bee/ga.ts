import type { Env } from '../types';
import { accessToken, addDays, loadGsc } from './gsc';
import { pickRanges } from './search';

/** Google Analytics 4 for the Bedford Bee (2026-10-10). Same Google
 * connection as Search Console (one consent, `analytics.readonly`).
 *
 * First sync pulls every day back to the property's creation (standard
 * reports aren't limited by GA's 2/14-month data retention); nightly re-pulls
 * the last 3 days. Stored per day: site totals, sessions by landing page ×
 * source/medium, page views by host × path (website and Substack can share
 * the property), city, device, hour, and outbound link clicks. Plus a
 * de-duplicated visitor snapshot for recent periods (users don't add up
 * across days). */

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';
const SITE_HINT = 'thebedfordbee.com';
const WINDOW_DAYS = 31;
const REFETCH_DAYS = 3;
const now = () => new Date().toISOString();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function getJson<T>(token: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Google Analytics ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

export interface GaPropertyChoice {
  property: string;
  name: string;
  created: string | null;
  all: { property: string; name: string; uris: string[] }[];
}

/** Finds the GA4 property whose web stream is thebedfordbee.com (else the
 * only/first property the account can see). */
export async function discoverGaProperty(token: string): Promise<GaPropertyChoice | null> {
  const sums = await getJson<{ accountSummaries?: { propertySummaries?: { property: string; displayName: string }[] }[] }>(token, `${ADMIN}/accountSummaries?pageSize=200`);
  const props = (sums.accountSummaries ?? []).flatMap((a) => a.propertySummaries ?? []);
  if (!props.length) return null;
  const all: GaPropertyChoice['all'] = [];
  for (const p of props.slice(0, 20)) {
    let uris: string[] = [];
    try {
      const ds = await getJson<{ dataStreams?: { webStreamData?: { defaultUri?: string } }[] }>(token, `${ADMIN}/${p.property}/dataStreams`);
      uris = (ds.dataStreams ?? []).map((d) => d.webStreamData?.defaultUri ?? '').filter(Boolean);
    } catch {
      uris = [];
    }
    all.push({ property: p.property, name: p.displayName, uris });
  }
  const pick = all.find((p) => p.uris.some((u) => u.toLowerCase().includes(SITE_HINT))) ?? all.find((p) => /bedford\s*bee/i.test(p.name)) ?? (all.length === 1 ? all[0] : null);
  if (!pick) return null;
  let created: string | null = null;
  try {
    created = (await getJson<{ createTime?: string }>(token, `${ADMIN}/${pick.property}`)).createTime?.slice(0, 10) ?? null;
  } catch {
    created = null;
  }
  return { property: pick.property, name: pick.name, created, all };
}

interface ReportRow {
  d: string[];
  m: number[];
}

async function report(token: string, property: string, body: Record<string, unknown>): Promise<ReportRow[]> {
  const out: ReportRow[] = [];
  for (let offset = 0; ; offset += 100000) {
    const j = await getJson<{ rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[]; rowCount?: number }>(token, `${DATA}/${property}:runReport`, {
      ...body,
      limit: 100000,
      offset,
      keepEmptyRows: false,
    });
    for (const r of j.rows ?? []) out.push({ d: (r.dimensionValues ?? []).map((v) => v.value), m: (r.metricValues ?? []).map((v) => Number(v.value) || 0) });
    if (!j.rowCount || offset + 100000 >= j.rowCount) break;
  }
  return out;
}

const isoDate = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const dims = (...names: string[]) => names.map((name) => ({ name }));
const mets = (...names: string[]) => names.map((name) => ({ name }));

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

export interface GaSyncResult {
  from: string | null;
  to: string | null;
  days: number;
  remaining: boolean;
}

export async function syncGa(env: Env, maxWindows = 6): Promise<GaSyncResult> {
  const row = await loadGsc(env);
  if (!row?.refresh_token_enc) throw new Error('Google isn’t connected.');
  if (!row.ga_property) throw new Error('No Google Analytics property found — Reconnect in Settings → Bedford Bee and allow Analytics.');
  const token = await accessToken(env, row);
  const property = row.ga_property;
  const end = addDays(easternToday(), -1);
  const floor = row.ga_created && row.ga_created > '2015-08-14' ? row.ga_created : addDays(end, -3 * 365);
  let start = row.ga_last_date ? addDays(row.ga_last_date, -REFETCH_DAYS) : floor;
  if (start < floor) start = floor;
  const result: GaSyncResult = { from: start, to: null, days: 0, remaining: false };
  try {
    let windows = 0;
    while (start <= end) {
      if (windows >= maxWindows) {
        result.remaining = true;
        break;
      }
      const wEnd = addDays(start, WINDOW_DAYS - 1) < end ? addDays(start, WINDOW_DAYS - 1) : end;
      const dateRanges = [{ startDate: start, endDate: wEnd }];
      const [days, landing, pages, geo, devices, hours, clicks] = await Promise.all([
        report(token, property, { dateRanges, dimensions: dims('date'), metrics: mets('sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'engagedSessions', 'userEngagementDuration') }),
        report(token, property, {
          dateRanges,
          dimensions: dims('date', 'landingPage', 'sessionSource', 'sessionMedium', 'sessionDefaultChannelGroup'),
          metrics: mets('sessions', 'engagedSessions', 'userEngagementDuration', 'screenPageViews'),
        }),
        report(token, property, { dateRanges, dimensions: dims('date', 'hostName', 'pagePath', 'pageTitle'), metrics: mets('screenPageViews', 'userEngagementDuration') }),
        report(token, property, { dateRanges, dimensions: dims('date', 'city', 'region'), metrics: mets('sessions') }),
        report(token, property, { dateRanges, dimensions: dims('date', 'deviceCategory'), metrics: mets('sessions') }),
        report(token, property, { dateRanges, dimensions: dims('date', 'hour'), metrics: mets('sessions') }),
        report(token, property, {
          dateRanges,
          dimensions: dims('date', 'pagePath', 'linkDomain'),
          metrics: mets('eventCount'),
          dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'click' } } },
        }).catch(() => [] as ReportRow[]),
      ]);
      const stmts: D1PreparedStatement[] = ['bee_ga_days', 'bee_ga_landing', 'bee_ga_pages', 'bee_ga_geo', 'bee_ga_dims', 'bee_ga_clicks'].map((t) =>
        env.DB.prepare(`DELETE FROM ${t} WHERE date BETWEEN ? AND ?`).bind(start, wEnd)
      );
      for (const r of days)
        stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_ga_days (date, sessions, users, new_users, views, engaged, engagement_sec) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(isoDate(r.d[0]), ...r.m));
      for (const r of landing)
        stmts.push(
          env.DB.prepare(
            'INSERT OR REPLACE INTO bee_ga_landing (date, landing, source, medium, channel, sessions, engaged, engagement_sec, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(isoDate(r.d[0]), r.d[1] || '(not set)', r.d[2] || '(not set)', r.d[3] || '(not set)', r.d[4] || null, ...r.m)
        );
      // Same path can carry several titles over time — keep one row (last title).
      const pageMap = new Map<string, { date: string; host: string; path: string; title: string; views: number; eng: number }>();
      for (const r of pages) {
        const key = `${r.d[0]}|${r.d[1]}|${r.d[2]}`;
        const e = pageMap.get(key) ?? { date: isoDate(r.d[0]), host: r.d[1], path: r.d[2], title: r.d[3], views: 0, eng: 0 };
        e.views += r.m[0];
        e.eng += r.m[1];
        pageMap.set(key, e);
      }
      for (const e of pageMap.values())
        stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_ga_pages (date, host, path, title, views, engagement_sec) VALUES (?, ?, ?, ?, ?, ?)').bind(e.date, e.host, e.path, e.title, e.views, e.eng));
      for (const r of geo) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_ga_geo (date, city, region, sessions) VALUES (?, ?, ?, ?)').bind(isoDate(r.d[0]), r.d[1], r.d[2], r.m[0]));
      for (const [dim, list] of [['device', devices], ['hour', hours]] as const)
        for (const r of list) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_ga_dims (date, dim, value, sessions) VALUES (?, ?, ?, ?)').bind(isoDate(r.d[0]), dim, r.d[1], r.m[0]));
      for (const r of clicks)
        if (r.d[2] && r.d[2] !== '(not set)')
          stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_ga_clicks (date, path, domain, clicks) VALUES (?, ?, ?, ?)').bind(isoDate(r.d[0]), r.d[1], r.d[2].toLowerCase(), r.m[0]));
      await runBatches(env, stmts);
      result.days += days.length;
      const last = days.map((d) => isoDate(d.d[0])).sort().pop();
      if (last) result.to = last;
      windows++;
      start = addDays(wEnd, 1);
    }
    const span = await env.DB.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_ga_days').first<{ a: string | null; b: string | null }>();
    const lastDate = result.remaining ? addDays(start, -1 + REFETCH_DAYS) : span?.b ?? end;
    let snapshot = row.ga_snapshot_json;
    if (!result.remaining) {
      const snap = await visitorSnapshot(token, property, span?.b ?? end);
      // Unique visitors for every preset range (and the stretch before
      // each) so the Website tab's Visitors tile is instant; custom ranges
      // ask GA live and land in the same cache (rangeVisitors).
      snap.ranges = await presetVisitors(token, property, span?.a ?? end, span?.b ?? end);
      snapshot = JSON.stringify(snap);
    }
    await env.DB.prepare('UPDATE bee_gsc_account SET ga_first_date = ?, ga_last_date = ?, ga_last_sync_at = ?, ga_last_error = NULL, ga_snapshot_json = ? WHERE id = 1')
      .bind(span?.a ?? null, lastDate, now(), snapshot)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE bee_gsc_account SET ga_last_sync_at = ?, ga_last_error = ? WHERE id = 1').bind(now(), msg.slice(0, 500)).run();
    throw err;
  }
  return result;
}

/** Visitors don't add up across days — ask GA for the de-duplicated count
 * per period (last 28, prior 28, last 90, this year, last year). */
async function visitorSnapshot(token: string, property: string, end: string): Promise<Record<string, unknown>> {
  const y = end.slice(0, 4);
  const ranges: Record<string, { startDate: string; endDate: string }> = {
    last28: { startDate: addDays(end, -27), endDate: end },
    prev28: { startDate: addDays(end, -55), endDate: addDays(end, -28) },
    last90: { startDate: addDays(end, -89), endDate: end },
    thisYear: { startDate: `${y}-01-01`, endDate: end },
    lastYear: { startDate: `${Number(y) - 1}-01-01`, endDate: `${Number(y) - 1}-12-31` },
  };
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(ranges)) {
    try {
      const rows = await report(token, property, { dateRanges: [r], metrics: mets('totalUsers', 'newUsers') });
      out[k] = { users: rows[0]?.m[0] ?? 0, newUsers: rows[0]?.m[1] ?? 0, from: r.startDate, to: r.endDate };
    } catch (err) {
      out._error = err instanceof Error ? err.message : String(err);
    }
  }
  return out;
}

export async function syncGaAll(env: Env): Promise<GaSyncResult> {
  let total: GaSyncResult | null = null;
  for (let pass = 0; pass < 8; pass++) {
    const r = await syncGa(env);
    total = total ? { ...r, from: total.from, days: total.days + r.days } : r;
    if (!r.remaining) break;
  }
  return total!;
}

export async function gaSyncDue(env: Env, scheduledTime: number): Promise<boolean> {
  const row = await loadGsc(env);
  if (!row?.refresh_token_enc || !row.ga_property) return false;
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  return !row.ga_last_sync_at || row.ga_last_sync_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}

// ---- Unique visitors for any date range (Mike, 2026-10-11) -------------

type VisitorCount = { users: number; newUsers: number; at: string };
const PRESET_DAYS: Record<string, number> = { '7d': 7, '28d': 28, '90d': 90, '1y': 365 };

/** The same preset ranges the dashboard's RangePicker sends (resolved on
 * today's New York date, then clipped to the data like pickRanges). */
function presetRanges(first: string, end: string) {
  const today = easternToday();
  const asked: { from: string; to: string }[] = Object.values(PRESET_DAYS).map((n) => ({ from: addDays(today, -(n - 1)), to: today }));
  asked.push({ from: `${today.slice(0, 4)}-01-01`, to: today }, { from: first, to: today });
  const out: { from: string; to: string }[] = [];
  for (const a of asked) {
    const { cur, prev } = pickRanges(a, first, end);
    out.push(cur, prev);
  }
  return out;
}

async function countVisitors(token: string, property: string, r: { from: string; to: string }): Promise<VisitorCount> {
  const rows = await report(token, property, { dateRanges: [{ startDate: r.from, endDate: r.to }], metrics: mets('totalUsers', 'newUsers') });
  return { users: rows[0]?.m[0] ?? 0, newUsers: rows[0]?.m[1] ?? 0, at: easternToday() };
}

async function presetVisitors(token: string, property: string, first: string, end: string) {
  const out: Record<string, VisitorCount> = {};
  for (const r of presetRanges(first, end)) {
    const key = `${r.from}_${r.to}`;
    if (out[key]) continue;
    try {
      out[key] = await countVisitors(token, property, r);
    } catch {
      /* leave it to the live path */
    }
  }
  return out;
}

/** GET /api/bee/analytics/visitors — de-duplicated visitors for a range and
 * the stretch before it. Cached in ga_snapshot_json.ranges (presets filled
 * nightly; others asked live once a day, ~40 kept). */
export async function rangeVisitors(env: Env, asked: { from: string; to: string } | null) {
  const row = await loadGsc(env);
  const span = await env.DB.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_ga_days').first<{ a: string | null; b: string | null }>();
  if (!row?.refresh_token_enc || !row.ga_property || !span?.b) return { now: null, prev: null, live: false };
  const { cur, prev } = pickRanges(asked, span.a ?? span.b, span.b);
  const snap = (row.ga_snapshot_json ? JSON.parse(row.ga_snapshot_json) : {}) as { ranges?: Record<string, VisitorCount> };
  const cache = snap.ranges ?? {};
  const today = easternToday();
  let token: string | null = null;
  let live = false;
  const get = async (r: { from: string; to: string }) => {
    const key = `${r.from}_${r.to}`;
    const hit = cache[key];
    if (hit && hit.at === today) return hit;
    try {
      token ??= await accessToken(env, row);
      cache[key] = await countVisitors(token, row.ga_property!, r);
      live = true;
      return cache[key];
    } catch {
      return hit ?? null; // yesterday's count beats nothing
    }
  };
  const [a, b] = await Promise.all([get(cur), get(prev)]);
  if (live) {
    const keys = Object.keys(cache).sort((x, y) => (cache[y].at ?? '').localeCompare(cache[x].at ?? ''));
    const kept = Object.fromEntries(keys.slice(0, 60).map((k) => [k, cache[k]]));
    const fresh = await env.DB.prepare('SELECT ga_snapshot_json FROM bee_gsc_account WHERE id = 1').first<{ ga_snapshot_json: string | null }>();
    const base = fresh?.ga_snapshot_json ? JSON.parse(fresh.ga_snapshot_json) : {};
    base.ranges = { ...(base.ranges ?? {}), ...kept };
    await env.DB.prepare('UPDATE bee_gsc_account SET ga_snapshot_json = ? WHERE id = 1').bind(JSON.stringify(base)).run();
  }
  return { now: a ? { users: a.users, newUsers: a.newUsers } : null, prev: b ? { users: b.users, newUsers: b.newUsers } : null, live, range: { current: cur, previous: prev } };
}
