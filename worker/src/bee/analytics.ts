import type { Env } from '../types';
import { pickRanges, type DayRange } from './search';
import { loadGsc } from './gsc';

/** GET /api/bee/analytics — the Website (GA4) part of the Bedford Bee
 * dashboard. Rule-based, with minimum floors for a small site:
 *  - Period = last 28 days of data vs the 28 before; visitors come from
 *    GA's de-duplicated snapshot.
 *  - Platform = source/medium grouped (Facebook = facebook.com,
 *    m./l./lm.facebook.com, fb; Instagram; X; Nextdoor; Reddit; LinkedIn;
 *    Threads; Substack; Email; Google; Other search; Direct; Other sites).
 *  - Stickiest pages (90 days, ≥ 25 views): engaged seconds per view.
 *  - Subscribe clicks: outbound clicks to *.substack.com per page (90 d),
 *    per 100 views (≥ 25 views).
 *  - Local reach: sessions from Bedford-area towns.
 *  - Search visitors: Organic Search landing pages (90 d, ≥ 10 sessions)
 *    with engaged-session rate — do Google visitors stay?
 *  - Best days/hours (90 days). */

const LOCAL_TOWNS = [
  'Bedford',
  'Bedford Hills',
  'Bedford Corners',
  'Katonah',
  'Pound Ridge',
  'Mount Kisco',
  'Cross River',
  'Goldens Bridge',
  'South Salem',
  'Lewisboro',
  'Armonk',
  'North Salem',
  'Chappaqua',
];
const LOCAL_SET = new Set(LOCAL_TOWNS.map((t) => t.toLowerCase()));

export function platformOf(source: string, medium: string, channel: string | null): string {
  const s = source.toLowerCase();
  const m = medium.toLowerCase();
  if (/facebook|^fb$|fb\.com|fb\.me/.test(s)) return 'Facebook';
  if (/instagram|^ig$/.test(s)) return 'Instagram';
  if (/^t\.co$|twitter|^x\.com|^x$/.test(s)) return 'X / Twitter';
  if (/nextdoor/.test(s)) return 'Nextdoor';
  if (/reddit/.test(s)) return 'Reddit';
  if (/linkedin|lnkd/.test(s)) return 'LinkedIn';
  if (/threads/.test(s)) return 'Threads';
  if (/substack/.test(s)) return 'Substack';
  if (m === 'email' || /mail/.test(s) || channel === 'Email') return 'Email';
  if (/google/.test(s) && (m === 'organic' || channel === 'Organic Search')) return 'Google Search';
  if (m === 'organic' || channel === 'Organic Search') return 'Other Search';
  if (s === '(direct)' || channel === 'Direct') return 'Direct';
  if (channel === 'Organic Social' || channel === 'Paid Social') return 'Other Social';
  return 'Other Sites';
}
const SOCIAL = new Set(['Facebook', 'Instagram', 'X / Twitter', 'Nextdoor', 'Reddit', 'LinkedIn', 'Threads', 'Other Social']);
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Totals {
  sessions: number;
  views: number;
  engaged: number;
  engagementSec: number;
}

export async function analyticsDashboard(env: Env, asked: DayRange | null = null) {
  const acct = await loadGsc(env);
  const connection = {
    connected: !!acct?.refresh_token_enc,
    hasScope: !!acct?.scopes?.includes('analytics'),
    property: acct?.ga_property ?? null,
    propertyName: acct?.ga_property_name ?? null,
    email: acct?.account_email ?? null,
    lastSyncAt: acct?.ga_last_sync_at ?? null,
    lastError: acct?.ga_last_error ?? (acct?.ga_snapshot_json?.includes('"_error"') ? `Visitor counts: ${JSON.parse(acct.ga_snapshot_json)._error}` : null),
    firstDate: acct?.ga_first_date ?? null,
    lastDate: acct?.ga_last_date ?? null,
  };
  const db = env.DB;
  const span = await db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_ga_days').first<{ a: string | null; b: string | null }>();
  if (!span?.b) return { connection, empty: true as const };
  const end = span.b;
  // Everything below follows the asked range (default last 28 days),
  // compared with the same length before (Mike, 2026-10-11).
  const { cur, prev } = pickRanges(asked, span.a ?? end, end);

  const totals = async (r: { from: string; to: string }): Promise<Totals> => {
    const x = await db
      .prepare('SELECT COALESCE(SUM(sessions),0) s, COALESCE(SUM(views),0) v, COALESCE(SUM(engaged),0) e, COALESCE(SUM(engagement_sec),0) t FROM bee_ga_days WHERE date BETWEEN ? AND ?')
      .bind(r.from, r.to)
      .first<{ s: number; v: number; e: number; t: number }>();
    return { sessions: x?.s ?? 0, views: x?.v ?? 0, engaged: x?.e ?? 0, engagementSec: x?.t ?? 0 };
  };
  const [now28, prev28] = await Promise.all([totals(cur), totals(prev)]);
  const snapshot = acct?.ga_snapshot_json ? (JSON.parse(acct.ga_snapshot_json) as Record<string, { users: number; newUsers: number }>) : {};

  // Monthly: all visits + social visits.
  const { results: monthRows } = await db
    .prepare(`SELECT substr(date,1,7) AS month, SUM(sessions) s, SUM(views) v, SUM(engaged) e, COUNT(*) days FROM bee_ga_days GROUP BY month ORDER BY month`)
    .all<{ month: string; s: number; v: number; e: number; days: number }>();
  const { results: srcMonth } = await db
    .prepare('SELECT substr(date,1,7) AS month, source, medium, channel, SUM(sessions) s FROM bee_ga_landing GROUP BY month, source, medium, channel')
    .all<{ month: string; source: string; medium: string; channel: string | null; s: number }>();
  const socialByMonth = new Map<string, number>();
  for (const r of srcMonth ?? []) if (SOCIAL.has(platformOf(r.source, r.medium, r.channel))) socialByMonth.set(r.month, (socialByMonth.get(r.month) ?? 0) + r.s);
  const monthly = (monthRows ?? []).map((m) => ({ month: m.month, sessions: m.s, views: m.v, engaged: m.e, days: m.days, social: socialByMonth.get(m.month) ?? 0 }));

  // Platform scorecard (28 d vs prior 28 d) + top landing pages per platform (90 d).
  const landingRows = async (from: string, to: string) =>
    (
      await db
        .prepare(
          'SELECT landing, source, medium, channel, SUM(sessions) s, SUM(engaged) e, SUM(engagement_sec) t, SUM(views) v FROM bee_ga_landing WHERE date BETWEEN ? AND ? GROUP BY landing, source, medium, channel'
        )
        .bind(from, to)
        .all<{ landing: string; source: string; medium: string; channel: string | null; s: number; e: number; t: number; v: number }>()
    ).results ?? [];
  const [l28, lPrev, l90] = await Promise.all([landingRows(cur.from, cur.to), landingRows(prev.from, prev.to), landingRows(cur.from, cur.to)]);
  const byPlatform = (rows: typeof l28) => {
    const m = new Map<string, Totals>();
    for (const r of rows) {
      const p = platformOf(r.source, r.medium, r.channel);
      const t = m.get(p) ?? (m.set(p, { sessions: 0, views: 0, engaged: 0, engagementSec: 0 }), m.get(p)!);
      t.sessions += r.s;
      t.views += r.v;
      t.engaged += r.e;
      t.engagementSec += r.t;
    }
    return m;
  };
  const p28 = byPlatform(l28);
  const pPrev = byPlatform(lPrev);
  const landingByPlatform = new Map<string, Map<string, { sessions: number; engaged: number }>>();
  for (const r of l90) {
    const p = platformOf(r.source, r.medium, r.channel);
    const m = landingByPlatform.get(p) ?? (landingByPlatform.set(p, new Map()), landingByPlatform.get(p)!);
    const e = m.get(r.landing) ?? { sessions: 0, engaged: 0 };
    e.sessions += r.s;
    e.engaged += r.e;
    m.set(r.landing, e);
  }
  const platforms = [...new Set([...p28.keys(), ...pPrev.keys()])]
    .map((name) => {
      const a = p28.get(name) ?? { sessions: 0, views: 0, engaged: 0, engagementSec: 0 };
      const b = pPrev.get(name) ?? { sessions: 0, views: 0, engaged: 0, engagementSec: 0 };
      const lp = [...(landingByPlatform.get(name) ?? new Map()).entries()].sort((x, y) => y[1].sessions - x[1].sessions).slice(0, 5);
      return {
        name,
        social: SOCIAL.has(name),
        sessions: a.sessions,
        prevSessions: b.sessions,
        engagedRate: a.sessions ? a.engaged / a.sessions : null,
        secPerSession: a.sessions ? a.engagementSec / a.sessions : null,
        viewsPerSession: a.sessions ? a.views / a.sessions : null,
        topLanding: lp.map(([landing, x]) => ({ landing, sessions: x.sessions })),
      };
    })
    .filter((p) => p.sessions || p.prevSessions)
    .sort((x, y) => y.sessions - x.sessions || y.prevSessions - x.prevSessions);

  // Search visitors: do Google visitors stay? (90 d)
  const organic = new Map<string, { sessions: number; engaged: number; sec: number }>();
  for (const r of l90)
    if (platformOf(r.source, r.medium, r.channel) === 'Google Search') {
      const e = organic.get(r.landing) ?? { sessions: 0, engaged: 0, sec: 0 };
      e.sessions += r.s;
      e.engaged += r.e;
      e.sec += r.t;
      organic.set(r.landing, e);
    }
  const searchLanding = [...organic.entries()]
    .filter(([, x]) => x.sessions >= 10)
    .map(([landing, x]) => ({ landing, sessions: x.sessions, engagedRate: x.engaged / x.sessions, secPerSession: x.sec / x.sessions }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 12);

  // Pages (90 d): top + stickiest; website vs Substack host split.
  const { results: pageRows } = await db
    .prepare('SELECT host, path, MAX(title) title, SUM(views) v, SUM(engagement_sec) t FROM bee_ga_pages WHERE date BETWEEN ? AND ? GROUP BY host, path')
    .bind(cur.from, cur.to)
    .all<{ host: string; path: string; title: string | null; v: number; t: number }>();
  const pages = (pageRows ?? []).map((p) => ({ host: p.host, path: p.path, title: p.title, views: p.v, secPerView: p.v ? p.t / p.v : 0 }));
  const topPages = [...pages].sort((a, b) => b.views - a.views).slice(0, 15);
  const stickiest = pages
    .filter((p) => p.views >= 25)
    .sort((a, b) => b.secPerView - a.secPerView)
    .slice(0, 10);
  const hosts = new Map<string, number>();
  for (const p of pages) hosts.set(p.host, (hosts.get(p.host) ?? 0) + p.views);

  // Subscribe clicks (outbound to Substack), 90 d.
  const { results: clickRows } = await db
    .prepare('SELECT path, domain, SUM(clicks) c FROM bee_ga_clicks WHERE date BETWEEN ? AND ? GROUP BY path, domain')
    .bind(cur.from, cur.to)
    .all<{ path: string; domain: string; c: number }>();
  const viewsByPath = new Map<string, number>();
  for (const p of pages) viewsByPath.set(p.path, (viewsByPath.get(p.path) ?? 0) + p.views);
  const subscribeByPage = new Map<string, number>();
  const outboundDomains = new Map<string, number>();
  for (const r of clickRows ?? []) {
    outboundDomains.set(r.domain, (outboundDomains.get(r.domain) ?? 0) + r.c);
    if (r.domain.includes('substack')) subscribeByPage.set(r.path, (subscribeByPage.get(r.path) ?? 0) + r.c);
  }
  const subscribeClicks = [...subscribeByPage.entries()]
    .map(([path, clicks]) => {
      const views = viewsByPath.get(path) ?? 0;
      return { path, clicks, views, per100: views >= 25 ? (clicks / views) * 100 : null };
    })
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 12);
  const { results: subMonth } = await db
    .prepare("SELECT substr(date,1,7) AS month, SUM(clicks) c FROM bee_ga_clicks WHERE domain LIKE '%substack%' GROUP BY month ORDER BY month")
    .all<{ month: string; c: number }>();

  // Local reach (28 d vs prior) + top cities.
  const geo = async (r: { from: string; to: string }) =>
    (await db.prepare('SELECT city, region, SUM(sessions) s FROM bee_ga_geo WHERE date BETWEEN ? AND ? GROUP BY city, region ORDER BY s DESC').bind(r.from, r.to).all<{ city: string; region: string; s: number }>()).results ?? [];
  const [g28, gPrev] = await Promise.all([geo(cur), geo(prev)]);
  const localShare = (rows: typeof g28) => {
    const tot = rows.reduce((n, r) => n + r.s, 0);
    const loc = rows.filter((r) => LOCAL_SET.has(r.city.toLowerCase()) && /new york/i.test(r.region)).reduce((n, r) => n + r.s, 0);
    return { local: loc, total: tot, share: tot ? loc / tot : null };
  };
  const { results: localMonth } = await db
    .prepare('SELECT substr(date,1,7) AS month, city, region, SUM(sessions) s FROM bee_ga_geo GROUP BY month, city, region')
    .all<{ month: string; city: string; region: string; s: number }>();
  const lm = new Map<string, { local: number; total: number }>();
  for (const r of localMonth ?? []) {
    const e = lm.get(r.month) ?? (lm.set(r.month, { local: 0, total: 0 }), lm.get(r.month)!);
    e.total += r.s;
    if (LOCAL_SET.has(r.city.toLowerCase()) && /new york/i.test(r.region)) e.local += r.s;
  }

  // Best days & hours (90 d).
  const { results: hourRows } = await db.prepare(`SELECT date, value, sessions FROM bee_ga_dims WHERE dim = 'hour' AND date BETWEEN ? AND ?`).bind(cur.from, cur.to).all<{ date: string; value: string; sessions: number }>();
  const byDow = Array(7).fill(0) as number[];
  const byHour = Array(24).fill(0) as number[];
  for (const r of hourRows ?? []) {
    const dow = new Date(`${r.date}T12:00:00Z`).getUTCDay();
    byDow[dow] += r.sessions;
    byHour[Number(r.value) || 0] += r.sessions;
  }
  const { results: devices } = await db
    .prepare(`SELECT value, SUM(sessions) s FROM bee_ga_dims WHERE dim = 'device' AND date BETWEEN ? AND ? GROUP BY value ORDER BY s DESC`)
    .bind(cur.from, cur.to)
    .all<{ value: string; s: number }>();

  const { results: daily } = await db
    .prepare('SELECT date, sessions, views, engaged FROM bee_ga_days WHERE date BETWEEN ? AND ? ORDER BY date')
    .bind(cur.from, cur.to)
    .all<{ date: string; sessions: number; views: number; engaged: number }>();

  const { results: years } = await db
    .prepare('SELECT substr(date,1,4) AS year, SUM(sessions) s, SUM(views) v, MIN(date) first, MAX(date) last FROM bee_ga_days GROUP BY year ORDER BY year DESC')
    .all<{ year: string; s: number; v: number; first: string; last: string }>();

  return {
    connection,
    empty: false as const,
    range: { from: span.a, to: end, current: cur, previous: prev },
    period: { now: now28, prev: prev28, visitors: snapshot.last28 ?? null, prevVisitors: snapshot.prev28 ?? null, visitorsThisYear: snapshot.thisYear ?? null, visitorsLastYear: snapshot.lastYear ?? null },
    monthly,
    daily: daily ?? [],
    platforms,
    searchLanding,
    topPages,
    stickiest,
    hosts: [...hosts.entries()].map(([host, views]) => ({ host, views })).sort((a, b) => b.views - a.views),
    subscribeClicks,
    subscribeByMonth: subMonth ?? [],
    outboundDomains: [...outboundDomains.entries()].map(([domain, clicks]) => ({ domain, clicks })).sort((a, b) => b.clicks - a.clicks).slice(0, 8),
    local: { now: localShare(g28), prev: localShare(gPrev), towns: LOCAL_TOWNS, byMonth: [...lm.entries()].map(([month, x]) => ({ month, ...x })).sort((a, b) => a.month.localeCompare(b.month)) },
    cities: g28.slice(0, 12).map((r) => ({ city: r.city, region: r.region, sessions: r.s, local: LOCAL_SET.has(r.city.toLowerCase()) && /new york/i.test(r.region) })),
    bestDays: byDow.map((sessions, i) => ({ day: DOW[i], sessions })),
    bestHours: byHour.map((sessions, hour) => ({ hour, sessions })),
    devices: (devices ?? []).map((d) => ({ device: d.value, sessions: d.s })),
    years: (years ?? []).map((y) => ({ year: y.year, sessions: y.s, views: y.v, first: y.first, last: y.last })),
  };
}

/** GET /api/bee/analytics/detail?kind=platform|page&key=…&from&to — one
 * traffic source (platform, as grouped by platformOf) or one page: daily
 * visits in the range, totals vs before, and its landing pages (platform)
 * or the sources sending visits to it (page). */
export async function analyticsDetail(env: Env, kind: 'platform' | 'page', key: string, asked: DayRange | null) {
  const db = env.DB;
  const span = await db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_ga_days').first<{ a: string | null; b: string | null }>();
  if (!span?.b) return { empty: true as const };
  const { cur, prev } = pickRanges(asked, span.a ?? span.b, span.b);
  const rows = async (r: DayRange) =>
    (
      await db
        .prepare(
          kind === 'page'
            ? 'SELECT date, landing, source, medium, channel, sessions s, engaged e, engagement_sec t, views v FROM bee_ga_landing WHERE landing = ? AND date BETWEEN ? AND ?'
            : 'SELECT date, landing, source, medium, channel, sessions s, engaged e, engagement_sec t, views v FROM bee_ga_landing WHERE date BETWEEN ? AND ?'
        )
        .bind(...(kind === 'page' ? [key, r.from, r.to] : [r.from, r.to]))
        .all<{ date: string; landing: string; source: string; medium: string; channel: string | null; s: number; e: number; t: number; v: number }>()
    ).results ?? [];
  const pick = (list: Awaited<ReturnType<typeof rows>>) => (kind === 'platform' ? list.filter((r) => platformOf(r.source, r.medium, r.channel) === key) : list);
  const [a, b] = await Promise.all([rows(cur).then(pick), rows(prev).then(pick)]);
  const tot = (list: typeof a) => {
    const sessions = list.reduce((n, r) => n + r.s, 0);
    const engaged = list.reduce((n, r) => n + r.e, 0);
    const sec = list.reduce((n, r) => n + r.t, 0);
    return { sessions, engagedRate: sessions ? engaged / sessions : null, secPerSession: sessions ? sec / sessions : null };
  };
  const byDate = new Map<string, number>();
  for (const r of a) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.s);
  const group = new Map<string, { sessions: number; engaged: number }>();
  for (const r of a) {
    const k = kind === 'platform' ? r.landing : platformOf(r.source, r.medium, r.channel);
    const g = group.get(k) ?? { sessions: 0, engaged: 0 };
    g.sessions += r.s;
    g.engaged += r.e;
    group.set(k, g);
  }
  let pageViews: number | null = null;
  if (kind === 'page') {
    const x = await db.prepare('SELECT COALESCE(SUM(views),0) v FROM bee_ga_pages WHERE path = ? AND date BETWEEN ? AND ?').bind(key, cur.from, cur.to).first<{ v: number }>();
    pageViews = x?.v ?? 0;
  }
  return {
    empty: false as const,
    kind,
    key,
    range: { current: cur, previous: prev },
    now: { ...tot(a), pageViews },
    prev: tot(b),
    daily: [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, sessions]) => ({ date, sessions })),
    breakdown: [...group.entries()]
      .map(([k, g]) => ({ key: k, sessions: g.sessions, engagedRate: g.sessions ? g.engaged / g.sessions : null }))
      .sort((x, y) => y.sessions - x.sessions)
      .slice(0, 20),
  };
}
