import type { Env } from '../types';
import { decryptField, encryptField } from '../cryptoField';

/** Bing Webmaster Tools for the Bedford Bee (2026-10-11). API key from
 * Bing Webmaster → Settings → API access, pasted in Settings → Bedford Bee
 * (encrypted). Nightly: searches + pages (weekly buckets, all history Bing
 * returns), site totals per day, crawl issues. Bing also feeds DuckDuckGo,
 * Yahoo and Copilot results. */

const BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const ENC = 'CLOUD_ACCOUNT_ENC_KEY';
const SITE_HINT = 'thebedfordbee.com';
const now = () => new Date().toISOString();

export interface BeeKeysRow {
  id: number;
  bing_key_enc: string | null;
  bing_site: string | null;
  bing_sites_json: string | null;
  bing_last_sync_at: string | null;
  bing_last_error: string | null;
  clarity_token_enc: string | null;
  clarity_last_sync_at: string | null;
  clarity_last_error: string | null;
  updated_at: string | null;
}

export async function loadKeys(env: Env): Promise<BeeKeysRow> {
  await env.DB.prepare('INSERT OR IGNORE INTO bee_keys (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM bee_keys WHERE id = 1').first<BeeKeysRow>())!;
}

/** "/Date(1690354800000-0700)/" → '2023-07-26' (UTC date of the instant). */
export function msDate(v: unknown): string | null {
  const m = String(v ?? '').match(/\/Date\((-?\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
}
const pos = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function call<T>(key: string, method: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ ...params, apikey: key });
  const r = await fetch(`${BASE}/${method}?${qs}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    throw new Error(r.status === 401 || /InvalidApiKey|NotAuthorized/i.test(body) ? 'Bing rejected the API key — generate a new one in Bing Webmaster → Settings → API access.' : `Bing ${method} ${r.status}: ${body}`);
  }
  return ((await r.json()) as { d: T }).d;
}

/** Saves the key after checking it works and finding the site. */
export async function saveBingKey(env: Env, key: string | null): Promise<{ site: string | null }> {
  if (!key) {
    await env.DB.prepare('UPDATE bee_keys SET bing_key_enc = NULL, bing_site = NULL, bing_last_error = NULL, updated_at = ? WHERE id = 1').bind(now()).run();
    return { site: null };
  }
  const sites = await call<{ Url: string; IsVerified?: boolean }[]>(key, 'GetUserSites');
  const ours = (sites ?? []).filter((s) => s.Url.toLowerCase().includes(SITE_HINT));
  const site = (ours.find((s) => s.IsVerified !== false) ?? ours[0])?.Url ?? null;
  if (!site) throw new Error(`That key works, but its Bing account has no verified ${SITE_HINT} site. Add the site in Bing Webmaster (Import from Google Search Console), then try again.`);
  await loadKeys(env);
  await env.DB.prepare('UPDATE bee_keys SET bing_key_enc = ?, bing_site = ?, bing_sites_json = ?, bing_last_error = NULL, updated_at = ? WHERE id = 1')
    .bind(await encryptField(env, key, ENC), site, JSON.stringify(sites), now())
    .run();
  return { site };
}

export interface BingSyncResult {
  weeks: number;
  queries: number;
  pages: number;
  days: number;
  issues: number;
}

export async function syncBing(env: Env): Promise<BingSyncResult> {
  const row = await loadKeys(env);
  if (!row.bing_key_enc || !row.bing_site) throw new Error('Bing isn’t connected.');
  const key = await decryptField(env, row.bing_key_enc, ENC);
  const siteUrl = row.bing_site;
  try {
    type Stat = { Query: string; Clicks: number; Impressions: number; AvgClickPosition: number; AvgImpressionPosition: number; Date: string };
    const [queries, pages, traffic, issues] = await Promise.all([
      call<Stat[]>(key, 'GetQueryStats', { siteUrl }),
      call<Stat[]>(key, 'GetPageStats', { siteUrl }),
      call<{ Clicks: number; Impressions: number; Date: string }[]>(key, 'GetRankAndTrafficStats', { siteUrl }),
      call<{ Url: string; Issues?: number | string; HttpCode?: number }[]>(key, 'GetCrawlIssues', { siteUrl }).catch(() => []),
    ]);
    const stmts: D1PreparedStatement[] = [];
    const weeks = new Set<string>();
    for (const [table, col, list] of [
      ['bee_bing_queries', 'query', queries],
      ['bee_bing_pages', 'page', pages],
    ] as const) {
      for (const q of list ?? []) {
        const week = msDate(q.Date);
        if (!week || !q.Query) continue;
        weeks.add(week);
        stmts.push(
          env.DB.prepare(`INSERT OR REPLACE INTO ${table} (week, ${col}, clicks, impressions, click_pos, impr_pos) VALUES (?, ?, ?, ?, ?, ?)`).bind(
            week,
            q.Query,
            q.Clicks ?? 0,
            q.Impressions ?? 0,
            pos(q.AvgClickPosition),
            pos(q.AvgImpressionPosition)
          )
        );
      }
    }
    let days = 0;
    for (const t of traffic ?? []) {
      const d = msDate(t.Date);
      if (!d) continue;
      days++;
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_bing_days (date, clicks, impressions) VALUES (?, ?, ?)').bind(d, t.Clicks ?? 0, t.Impressions ?? 0));
    }
    stmts.push(env.DB.prepare('DELETE FROM bee_bing_issues'));
    for (const i of issues ?? []) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_bing_issues (url, issue, http_code, seen_at) VALUES (?, ?, ?, ?)').bind(i.Url, issueText(i.Issues), i.HttpCode ?? null, now()));
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    await env.DB.prepare('UPDATE bee_keys SET bing_last_sync_at = ?, bing_last_error = NULL WHERE id = 1').bind(now()).run();
    return { weeks: weeks.size, queries: queries?.length ?? 0, pages: pages?.length ?? 0, days, issues: issues?.length ?? 0 };
  } catch (err) {
    await env.DB.prepare('UPDATE bee_keys SET bing_last_sync_at = ?, bing_last_error = ? WHERE id = 1').bind(now(), (err instanceof Error ? err.message : String(err)).slice(0, 500)).run();
    throw err;
  }
}

/** Bing's CrawlIssues is a bit flag set. */
const ISSUE_BITS: [number, string][] = [
  [1, 'HTTP error'],
  [2, 'Blocked by robots.txt'],
  [4, 'DNS error'],
  [8, 'Connection timeout'],
  [16, 'Content too long'],
  [32, 'Bad redirect'],
  [64, 'Malware'],
  [128, 'Important URL blocked'],
  [256, 'Blocked by noindex'],
  [512, 'Server error (5xx)'],
  [1024, 'Not found (404)'],
];
function issueText(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  const parts = ISSUE_BITS.filter(([b]) => n & b).map(([, t]) => t);
  return parts.join(', ') || `Issue ${n}`;
}

export async function bingSyncDue(env: Env, scheduledTime: number): Promise<boolean> {
  const row = await loadKeys(env);
  if (!row.bing_key_enc || !row.bing_site) return false;
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  return !row.bing_last_sync_at || row.bing_last_sync_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}

/** GET /api/bee/bing — Bing section of the Google Search tab. */
export async function bingDashboard(env: Env) {
  const row = await loadKeys(env);
  const connection = { connected: !!row.bing_key_enc, site: row.bing_site, lastSyncAt: row.bing_last_sync_at, lastError: row.bing_last_error };
  const db = env.DB;
  const span = await db.prepare('SELECT MIN(week) a, MAX(week) b, COUNT(DISTINCT week) n FROM bee_bing_queries').first<{ a: string | null; b: string | null; n: number }>();
  const dspan = await db.prepare('SELECT MIN(date) a, MAX(date) b FROM bee_bing_days').first<{ a: string | null; b: string | null }>();
  if (!span?.b && !dspan?.b) return { connection, empty: true as const };

  const { results: weeksList } = await db.prepare('SELECT DISTINCT week FROM bee_bing_queries ORDER BY week DESC LIMIT 8').all<{ week: string }>();
  const recent = (weeksList ?? []).map((w) => w.week);
  const last4 = recent.slice(0, 4);
  const prev4 = recent.slice(4, 8);
  const sumQ = async (weeks: string[]) => {
    if (!weeks.length) return { clicks: 0, impressions: 0 };
    const x = await db
      .prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i FROM bee_bing_queries WHERE week IN (${weeks.map(() => '?').join(',')})`)
      .bind(...weeks)
      .first<{ c: number; i: number }>();
    return { clicks: x?.c ?? 0, impressions: x?.i ?? 0 };
  };
  const [now4, prevSum] = await Promise.all([sumQ(last4), sumQ(prev4)]);

  const agg = async (table: string, col: string, weeks: string[]) => {
    if (!weeks.length) return [];
    return (
      (
        await db
          .prepare(
            `SELECT ${col} AS key, SUM(clicks) clicks, SUM(impressions) impressions, SUM(impr_pos * impressions) / NULLIF(SUM(CASE WHEN impr_pos IS NOT NULL THEN impressions END),0) position
             FROM ${table} WHERE week IN (${weeks.map(() => '?').join(',')}) GROUP BY ${col}`
          )
          .bind(...weeks)
          .all<{ key: string; clicks: number; impressions: number; position: number | null }>()
      ).results ?? []
    );
  };
  const { results: allWeeks } = await db.prepare('SELECT DISTINCT week FROM bee_bing_queries ORDER BY week DESC LIMIT 13').all<{ week: string }>();
  const q90 = await agg('bee_bing_queries', 'query', (allWeeks ?? []).map((w) => w.week));
  const q4 = await agg('bee_bing_queries', 'query', last4);
  const p4 = await agg('bee_bing_pages', 'page', last4);

  // Bing vs Google on the same search (last ~90 days).
  const gEnd = await db.prepare('SELECT MAX(date) d FROM bee_gsc_rows').first<{ d: string | null }>();
  let compare: { query: string; bingPos: number; googlePos: number; bingImpr: number; googleImpr: number }[] = [];
  if (gEnd?.d) {
    const from = new Date(new Date(`${gEnd.d}T12:00:00Z`).getTime() - 89 * 86400000).toISOString().slice(0, 10);
    const { results: g } = await db
      .prepare('SELECT query, SUM(impressions) i, SUM(position * impressions) / NULLIF(SUM(impressions),0) p FROM bee_gsc_rows WHERE date >= ? GROUP BY query')
      .bind(from)
      .all<{ query: string; i: number; p: number }>();
    const gm = new Map((g ?? []).map((r) => [r.query.toLowerCase(), r]));
    compare = q90
      .filter((b) => b.position && b.impressions >= 10)
      .map((b) => ({ b, g: gm.get(b.key.toLowerCase()) }))
      .filter((x) => x.g && x.g.i >= 10 && Math.abs(x.g.p - (x.b.position ?? 0)) >= 5)
      .map((x) => ({ query: x.b.key, bingPos: x.b.position!, googlePos: x.g!.p, bingImpr: x.b.impressions, googleImpr: x.g!.i }))
      .sort((a, b) => Math.abs(b.bingPos - b.googlePos) - Math.abs(a.bingPos - a.googlePos))
      .slice(0, 10);
  }

  const { results: months } = await db
    .prepare('SELECT substr(date,1,7) month, SUM(clicks) clicks, SUM(impressions) impressions, COUNT(*) days FROM bee_bing_days GROUP BY month ORDER BY month')
    .all<{ month: string; clicks: number; impressions: number; days: number }>();
  const { results: issues } = await db.prepare('SELECT url, issue, http_code FROM bee_bing_issues ORDER BY url LIMIT 25').all<{ url: string; issue: string; http_code: number | null }>();

  const ctr = (x: { clicks: number; impressions: number }) => (x.impressions ? x.clicks / x.impressions : 0);
  return {
    connection,
    empty: false as const,
    range: { from: span?.a ?? dspan?.a ?? null, to: span?.b ?? dspan?.b ?? null, weeks: span?.n ?? 0, last4 },
    period: { now: { ...now4, ctr: ctr(now4) }, prev: { ...prevSum, ctr: ctr(prevSum) } },
    monthly: months ?? [],
    topQueries: [...q4].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 15).map((q) => ({ query: q.key, clicks: q.clicks, impressions: q.impressions, position: q.position, ctr: ctr(q) })),
    topPages: [...p4].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10).map((p) => ({ page: p.key, clicks: p.clicks, impressions: p.impressions, position: p.position, ctr: ctr(p) })),
    strikingDistance: q90
      .filter((q) => q.position && q.position >= 8 && q.position <= 20 && q.impressions >= 10 && !/bedford\s*bee/i.test(q.key))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10)
      .map((q) => ({ query: q.key, clicks: q.clicks, impressions: q.impressions, position: q.position, ctr: ctr(q) })),
    compare,
    issues: issues ?? [],
  };
}
