import type { Env } from '../types';
import { addDays, loadGsc } from './gsc';

/** GET /api/bee/search — the Google Search part of the Bedford Bee
 * dashboard, computed from stored Search Console days. Every rule is
 * plain arithmetic with minimum-impression floors (the site gets ~50
 * clicks a month, so single days are noise):
 *  - Period = last 28 days of data vs the 28 before.
 *  - Brand = queries mentioning the Bee by name.
 *  - Striking distance (90 days): avg position 8–20, ≥ 20 impressions.
 *  - Titles not earning clicks (90 days): avg position ≤ 10, ≥ 30
 *    impressions, CTR under half the typical CTR for that position.
 *  - New searches: first seen in the last 14 days (never before).
 *  - Content gaps (90 days): ≥ 20 impressions, avg position > 20.
 *  - Competing pages (90 days): ≥ 2 of your pages each with ≥ 20% of a
 *    query's impressions (≥ 20 impressions).
 *  - Rising / falling pages: clicks, last 28 vs previous 28 days. */

const BRAND_RE = /bedford\s*bee|bedfordbee|\bthe bee\b/i;
/** Rough typical organic CTR by position (industry curves, rounded). */
const EXPECTED_CTR = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
const expectedCtr = (pos: number) => EXPECTED_CTR[Math.min(9, Math.max(0, Math.round(pos) - 1))];

interface Agg {
  clicks: number;
  impressions: number;
  position: number | null; // impression-weighted
}

export interface DayRange {
  from: string;
  to: string;
}
const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1;
/** The range a dashboard asked for (or the last `fallbackDays` of data),
 * clipped to the data, plus the same-length stretch before it. */
export function pickRanges(asked: DayRange | null, first: string, end: string, fallbackDays = 28) {
  const to = asked ? (asked.to < end ? asked.to : end) : end;
  let from = asked ? asked.from : addDays(end, -(fallbackDays - 1));
  if (from < first) from = first;
  if (from > to) from = to;
  const len = dayCount(from, to);
  return { cur: { from, to }, prev: { from: addDays(from, -len), to: addDays(from, -1) } };
}

export async function searchDashboard(env: Env, asked: DayRange | null = null) {
  const acct = await loadGsc(env);
  const connection = acct
    ? {
        connected: !!acct.refresh_token_enc,
        status: acct.status,
        email: acct.account_email,
        site: acct.site_url,
        lastSyncAt: acct.last_sync_at,
        lastError: acct.last_error,
        firstDate: acct.first_date,
        lastDate: acct.last_date,
      }
    : { connected: false, status: null, email: null, site: null, lastSyncAt: null, lastError: null, firstDate: null, lastDate: null };
  const span = await env.DB.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_gsc_days').first<{ a: string | null; b: string | null }>();
  if (!span?.b) return { connection, empty: true as const };

  const end = span.b;
  const { cur, prev } = pickRanges(asked, span.a ?? end, end);
  const q90 = addDays(end, -89);
  const db = env.DB;

  const total = async (r: { from: string; to: string }): Promise<Agg> => {
    const x = await db
      .prepare('SELECT COALESCE(SUM(clicks),0) AS c, COALESCE(SUM(impressions),0) AS i, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS p FROM bee_gsc_days WHERE date BETWEEN ? AND ?')
      .bind(r.from, r.to)
      .first<{ c: number; i: number; p: number | null }>();
    return { clicks: x?.c ?? 0, impressions: x?.i ?? 0, position: x?.p ?? null };
  };
  const [now28, prev28] = await Promise.all([total(cur), total(prev)]);

  // Daily totals in the range (tile drill-downs chart these).
  const { results: daily } = await db
    .prepare('SELECT date, clicks, impressions, position FROM bee_gsc_days WHERE date BETWEEN ? AND ? ORDER BY date')
    .bind(cur.from, cur.to)
    .all<{ date: string; clicks: number; impressions: number; position: number | null }>();

  // Monthly series (whole history) + brand share by month.
  const { results: months } = await db
    .prepare(
      `SELECT substr(date,1,7) AS month, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position, COUNT(*) AS days
       FROM bee_gsc_days GROUP BY month ORDER BY month`
    )
    .all<{ month: string; clicks: number; impressions: number; position: number | null; days: number }>();
  const { results: qMonths } = await db
    .prepare('SELECT substr(date,1,7) AS month, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM bee_gsc_rows GROUP BY month, query')
    .all<{ month: string; query: string; clicks: number; impressions: number }>();
  const brandByMonth = new Map<string, { brand: number; other: number; brandImpr: number; otherImpr: number }>();
  for (const r of qMonths ?? []) {
    const m = brandByMonth.get(r.month) ?? (brandByMonth.set(r.month, { brand: 0, other: 0, brandImpr: 0, otherImpr: 0 }), brandByMonth.get(r.month)!);
    if (BRAND_RE.test(r.query)) {
      m.brand += r.clicks;
      m.brandImpr += r.impressions;
    } else {
      m.other += r.clicks;
      m.otherImpr += r.impressions;
    }
  }
  const monthly = (months ?? []).map((m) => ({ ...m, brandClicks: brandByMonth.get(m.month)?.brand ?? 0, discoveryClicks: brandByMonth.get(m.month)?.other ?? 0 }));

  // Query aggregates.
  const queryAgg = async (from: string, to: string) =>
    (
      await db
        .prepare(
          `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position
           FROM bee_gsc_rows WHERE date BETWEEN ? AND ? GROUP BY query`
        )
        .bind(from, to)
        .all<{ query: string; clicks: number; impressions: number; position: number }>()
    ).results ?? [];
  const q28 = await queryAgg(cur.from, cur.to);
  const q28prev = new Map((await queryAgg(prev.from, prev.to)).map((q) => [q.query, q]));
  const q90rows = await queryAgg(q90, end);

  const brand28 = q28.filter((q) => BRAND_RE.test(q.query)).reduce((n, q) => n + q.clicks, 0);
  const named28 = q28.reduce((n, q) => n + q.clicks, 0);

  const topQueries = [...q28]
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 50)
    .map((q) => ({ ...q, ctr: q.impressions ? q.clicks / q.impressions : 0, brand: BRAND_RE.test(q.query), prevClicks: q28prev.get(q.query)?.clicks ?? 0 }));

  // Best page per query (90 days) for the action lists.
  const { results: qp } = await db
    .prepare(
      `SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position
       FROM bee_gsc_rows WHERE date >= ? GROUP BY query, page`
    )
    .bind(q90)
    .all<{ query: string; page: string; clicks: number; impressions: number; position: number }>();
  const pagesByQuery = new Map<string, { page: string; clicks: number; impressions: number; position: number }[]>();
  for (const r of qp ?? []) pagesByQuery.set(r.query, [...(pagesByQuery.get(r.query) ?? []), r]);
  const bestPage = (q: string) => (pagesByQuery.get(q) ?? []).sort((a, b) => b.impressions - a.impressions)[0]?.page ?? null;

  const withCtr = <T extends { clicks: number; impressions: number }>(x: T) => ({ ...x, ctr: x.impressions ? x.clicks / x.impressions : 0 });
  const nonBrand90 = q90rows.filter((q) => !BRAND_RE.test(q.query));

  const strikingDistance = nonBrand90
    .filter((q) => q.position >= 8 && q.position <= 20 && q.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20)
    .map((q) => ({ ...withCtr(q), page: bestPage(q.query) }));

  const lowCtr = q90rows
    .filter((q) => q.position <= 10 && q.impressions >= 30 && q.clicks / q.impressions < expectedCtr(q.position) * 0.5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((q) => ({ ...withCtr(q), expectedCtr: expectedCtr(q.position), page: bestPage(q.query) }));

  const contentGaps = nonBrand90
    .filter((q) => q.position > 20 && q.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((q) => ({ ...withCtr(q), page: bestPage(q.query) }));

  const competing = [...pagesByQuery.entries()]
    .map(([query, pages]) => {
      const impr = pages.reduce((n, p) => n + p.impressions, 0);
      const strong = pages.filter((p) => impr > 0 && p.impressions / impr >= 0.2);
      return { query, impressions: impr, pages: strong.sort((a, b) => b.impressions - a.impressions).map((p) => ({ page: p.page, impressions: p.impressions, clicks: p.clicks, position: p.position })) };
    })
    .filter((x) => x.impressions >= 20 && x.pages.length >= 2)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  // New searches: first ever seen in the last 14 days.
  const { results: firsts } = await db
    .prepare(
      `SELECT query, MIN(date) AS first, SUM(CASE WHEN date >= ? THEN impressions ELSE 0 END) AS impressions, SUM(CASE WHEN date >= ? THEN clicks ELSE 0 END) AS clicks,
         SUM(CASE WHEN date >= ? THEN position * impressions ELSE 0 END) / NULLIF(SUM(CASE WHEN date >= ? THEN impressions ELSE 0 END),0) AS position
       FROM bee_gsc_rows GROUP BY query HAVING first >= ?`
    )
    .bind(addDays(end, -13), addDays(end, -13), addDays(end, -13), addDays(end, -13), addDays(end, -13))
    .all<{ query: string; first: string; impressions: number; clicks: number; position: number | null }>();
  const newQueries = (firsts ?? [])
    .filter((q) => q.impressions >= 3)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20)
    .map((q) => ({ ...q, page: bestPage(q.query) }));

  // Pages.
  const pageAgg = async (from: string, to: string) =>
    (
      await db
        .prepare(
          `SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position
           FROM bee_gsc_pages WHERE date BETWEEN ? AND ? GROUP BY page`
        )
        .bind(from, to)
        .all<{ page: string; clicks: number; impressions: number; position: number }>()
    ).results ?? [];
  const p28 = await pageAgg(cur.from, cur.to);
  const p28prev = new Map((await pageAgg(prev.from, prev.to)).map((p) => [p.page, p]));
  const topPages = [...p28]
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 40)
    .map((p) => ({ ...withCtr(p), prevClicks: p28prev.get(p.page)?.clicks ?? 0 }));
  const movers = [...new Set([...p28.map((p) => p.page), ...p28prev.keys()])]
    .map((page) => {
      const a = p28.find((p) => p.page === page);
      const b = p28prev.get(page);
      return { page, clicks: a?.clicks ?? 0, prevClicks: b?.clicks ?? 0, impressions: a?.impressions ?? 0, prevImpressions: b?.impressions ?? 0 };
    })
    .filter((m) => Math.abs(m.clicks - m.prevClicks) >= 3 || Math.abs(m.impressions - m.prevImpressions) >= 50);
  const rising = movers.filter((m) => m.clicks > m.prevClicks || (m.clicks === m.prevClicks && m.impressions > m.prevImpressions)).sort((a, b) => b.clicks - b.prevClicks - (a.clicks - a.prevClicks)).slice(0, 8);
  const falling = movers.filter((m) => m.prevClicks >= 3 && m.clicks < m.prevClicks).sort((a, b) => a.clicks - a.prevClicks - (b.clicks - b.prevClicks)).slice(0, 8);

  // Devices / countries (28 days).
  const { results: dims } = await db
    .prepare('SELECT dim, value, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM bee_gsc_dims WHERE date BETWEEN ? AND ? GROUP BY dim, value ORDER BY clicks DESC, impressions DESC')
    .bind(cur.from, cur.to)
    .all<{ dim: string; value: string; clicks: number; impressions: number }>();

  // Years.
  const { results: years } = await db
    .prepare(
      `SELECT substr(date,1,4) AS year, SUM(clicks) AS clicks, SUM(impressions) AS impressions, MIN(date) AS first, MAX(date) AS last FROM bee_gsc_days GROUP BY year ORDER BY year DESC`
    )
    .all<{ year: string; clicks: number; impressions: number; first: string; last: string }>();

  // Indexing watch.
  const { results: idx } = await db.prepare('SELECT * FROM bee_gsc_index ORDER BY lastmod DESC').all<{
    url: string;
    lastmod: string | null;
    verdict: string | null;
    coverage: string | null;
    last_crawl: string | null;
    checked_at: string | null;
  }>();
  const indexing = (idx ?? []).map((r) => ({ url: r.url, lastmod: r.lastmod, indexed: r.verdict === 'PASS', coverage: r.coverage, lastCrawl: r.last_crawl, checkedAt: r.checked_at }));

  return {
    connection,
    empty: false as const,
    range: { from: span.a, to: end, current: cur, previous: prev },
    period: {
      now: { ...now28, ctr: now28.impressions ? now28.clicks / now28.impressions : 0 },
      prev: { ...prev28, ctr: prev28.impressions ? prev28.clicks / prev28.impressions : 0 },
      brandClicks: brand28,
      namedClicks: named28,
    },
    monthly,
    daily: daily ?? [],
    topQueries,
    topPages,
    rising,
    falling,
    strikingDistance,
    lowCtr,
    newQueries,
    contentGaps,
    competing,
    devices: (dims ?? []).filter((d) => d.dim === 'device'),
    countries: (dims ?? []).filter((d) => d.dim === 'country').slice(0, 8),
    years: years ?? [],
    indexing,
  };
}

/** GET /api/bee/search/detail?kind=query|page&key=…&from&to — one search or
 * one page: daily trend in the range, totals vs the period before, and the
 * pages that rank for the search (or the searches that bring people to the
 * page). Searches Google hides for privacy aren't in the page breakdown. */
export async function searchDetail(env: Env, kind: 'query' | 'page', key: string, asked: DayRange | null) {
  const db = env.DB;
  const span = await db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_gsc_days').first<{ a: string | null; b: string | null }>();
  if (!span?.b) return { empty: true as const };
  const { cur, prev } = pickRanges(asked, span.a ?? span.b, span.b);
  const table = kind === 'query' ? 'bee_gsc_rows' : 'bee_gsc_pages';
  const col = kind === 'query' ? 'query' : 'page';
  const totals = async (r: DayRange) => {
    const x = await db
      .prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i, SUM(position * impressions) / NULLIF(SUM(impressions),0) p FROM ${table} WHERE ${col} = ? AND date BETWEEN ? AND ?`)
      .bind(key, r.from, r.to)
      .first<{ c: number; i: number; p: number | null }>();
    return { clicks: x?.c ?? 0, impressions: x?.i ?? 0, position: x?.p ?? null, ctr: x?.i ? (x.c ?? 0) / x.i : 0 };
  };
  const [now, before] = await Promise.all([totals(cur), totals(prev)]);
  const { results: daily } = await db
    .prepare(`SELECT date, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) position FROM ${table} WHERE ${col} = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`)
    .bind(key, cur.from, cur.to)
    .all<{ date: string; clicks: number; impressions: number; position: number | null }>();
  const other = kind === 'query' ? 'page' : 'query';
  const { results: parts } = await db
    .prepare(
      `SELECT ${other} AS key, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) position
       FROM bee_gsc_rows WHERE ${col} = ? AND date BETWEEN ? AND ? GROUP BY ${other} ORDER BY clicks DESC, impressions DESC LIMIT 25`
    )
    .bind(key, cur.from, cur.to)
    .all<{ key: string; clicks: number; impressions: number; position: number | null }>();
  return { empty: false as const, kind, key, range: { current: cur, previous: prev }, now, prev: before, daily: daily ?? [], breakdown: parts ?? [] };
}
