import type { Env } from '../types';
import { decryptField, encryptField } from '../cryptoField';

/** Google Search Console for the Bedford Bee (2026-10-10).
 *
 * Connect: Settings → Bedford Bee → Connect Search Console → Google consent
 * (read-only `webmasters.readonly` + email) with the Bee's Google account,
 * through the same "MikeOS" OAuth app and redirect URI as Drive — the cloud
 * callback hands states with provider 'gsc' to `finishGscOAuth`.
 *
 * Sync: the first run pulls all 16 months Google still has; after that the
 * nightly run re-pulls the last few days (Google finalizes data ~2–3 days
 * late) and adds new ones. Stored per day: site totals, query × page,
 * page totals, device and country. GSC forgets after 16 months — MikeOS
 * doesn't. Also an indexing watch: URL Inspection for pages in the site's
 * sitemaps changed in the last 30 days. */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WM = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/userinfo.email';
const ENC_KEY = 'CLOUD_ACCOUNT_ENC_KEY';
const BACKFILL_DAYS = 486; // ~16 months, Google's limit
const REFETCH_DAYS = 5;
const WINDOW_DAYS = 31;
const SITE_HINT = 'thebedfordbee.com';
export const GSC_STATE_PROVIDER = 'gsc';

const now = () => new Date().toISOString();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface GscAccountRow {
  id: number;
  account_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  site_url: string | null;
  sites_json: string | null;
  status: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  first_date: string | null;
  last_date: string | null;
  connected_at: string | null;
}

export async function loadGsc(env: Env): Promise<GscAccountRow | null> {
  return env.DB.prepare('SELECT * FROM bee_gsc_account WHERE id = 1').first<GscAccountRow>();
}

// ---- OAuth -------------------------------------------------------------

/** URL to send the browser to. State rides the cloud OAuth states table;
 * the callback is the existing /api/cloud/oauth/callback. */
export async function gscAuthUrl(env: Env, apiOrigin: string, returnOrigin: string): Promise<string> {
  if (!env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET) throw new Error('The MikeOS Google OAuth app isn’t configured (GOOGLE_DRIVE_CLIENT_ID / SECRET).');
  const state = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO cloud_oauth_states (state, provider, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, GSC_STATE_PROVIDER, `Search Console\u0000${returnOrigin}`, now())
    .run();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_DRIVE_CLIENT_ID,
    redirect_uri: `${apiOrigin}/api/cloud/oauth/callback`,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(env: Env, params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_DRIVE_CLIENT_ID!, client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET!, ...params }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: new Date(Date.now() + j.expires_in * 1000).toISOString(), scope: j.scope ?? '' };
}

/** Called by the cloud OAuth callback for 'gsc' states. */
export async function finishGscOAuth(env: Env, code: string, redirectUri: string): Promise<void> {
  const t = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!t.scope.includes('webmasters')) throw new Error('Google didn’t grant Search Console access — tick “View Search Console data” on the consent screen.');
  let email: string | null = null;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${t.accessToken}` } });
    if (r.ok) email = ((await r.json()) as { email?: string }).email ?? null;
  } catch {
    email = null;
  }
  const sites = await listSites(t.accessToken);
  const site = pickSite(sites);
  if (!site) throw new Error(`${email ?? 'That account'} has no Search Console property for ${SITE_HINT}. Connect the account that owns it.`);
  const existing = await loadGsc(env);
  const accessEnc = await encryptField(env, t.accessToken, ENC_KEY);
  const refreshEnc = t.refreshToken ? await encryptField(env, t.refreshToken, ENC_KEY) : existing?.refresh_token_enc ?? null;
  await env.DB.prepare(
    `INSERT INTO bee_gsc_account (id, account_email, access_token_enc, refresh_token_enc, token_expires_at, site_url, sites_json, status, last_error, connected_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, 'connected', NULL, ?)
     ON CONFLICT(id) DO UPDATE SET account_email = excluded.account_email, access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc, token_expires_at = excluded.token_expires_at, site_url = excluded.site_url,
       sites_json = excluded.sites_json, status = 'connected', last_error = NULL, connected_at = excluded.connected_at`
  )
    .bind(email, accessEnc, refreshEnc, t.expiresAt, site, JSON.stringify(sites), now())
    .run();
}

interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

async function listSites(token: string): Promise<SiteEntry[]> {
  const r = await fetch(`${WM}/sites`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Search Console sites failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return (((await r.json()) as { siteEntry?: SiteEntry[] }).siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

/** Prefer the Domain property (covers http/https/www), else any URL-prefix one. */
export function pickSite(sites: SiteEntry[]): string | null {
  const ours = sites.filter((s) => s.siteUrl.toLowerCase().includes(SITE_HINT));
  return (ours.find((s) => s.siteUrl.startsWith('sc-domain:')) ?? ours.find((s) => s.siteUrl.startsWith('https://')) ?? ours[0])?.siteUrl ?? null;
}

async function accessToken(env: Env, row: GscAccountRow): Promise<string> {
  if (row.access_token_enc && row.token_expires_at && Date.now() < new Date(row.token_expires_at).getTime() - 120_000) {
    return decryptField(env, row.access_token_enc, ENC_KEY);
  }
  if (!row.refresh_token_enc) throw new Error('Search Console access expired — reconnect it in Settings → Bedford Bee.');
  try {
    const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await decryptField(env, row.refresh_token_enc, ENC_KEY) });
    await env.DB.prepare('UPDATE bee_gsc_account SET access_token_enc = ?, token_expires_at = ?, status = ? WHERE id = 1')
      .bind(await encryptField(env, t.accessToken, ENC_KEY), t.expiresAt, 'connected')
      .run();
    return t.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE bee_gsc_account SET status = ?, last_error = ? WHERE id = 1').bind('error', `Reconnect needed: ${msg}`.slice(0, 500), ).run();
    throw err;
  }
}

export async function disconnectGsc(env: Env): Promise<void> {
  // Keeps every stored day (history GSC itself no longer has); only drops the tokens.
  await env.DB.prepare(`UPDATE bee_gsc_account SET access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, status = 'disconnected' WHERE id = 1`).run();
}

// ---- Sync --------------------------------------------------------------

interface ApiRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

async function query(token: string, site: string, body: Record<string, unknown>): Promise<ApiRow[]> {
  const out: ApiRow[] = [];
  for (let startRow = 0; ; startRow += 25000) {
    const r = await fetch(`${WM}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'web', rowLimit: 25000, startRow, ...body }),
    });
    if (!r.ok) throw new Error(`Search Console query failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const rows = ((await r.json()) as { rows?: ApiRow[] }).rows ?? [];
    out.push(...rows);
    if (rows.length < 25000) break;
  }
  return out;
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

export interface GscSyncResult {
  from: string | null;
  to: string | null;
  days: number;
  rows: number;
  remaining: boolean;
  indexChecked: number;
}

/** One pass: up to `maxWindows` 31-day windows (the first backfill takes a
 * few passes; `syncGscAll` loops). */
export async function syncGsc(env: Env, maxWindows = 6): Promise<GscSyncResult> {
  const row = await loadGsc(env);
  if (!row?.site_url || !row.refresh_token_enc) throw new Error('Search Console isn’t connected.');
  const token = await accessToken(env, row);
  const today = easternToday();
  const end = addDays(today, -1);
  const earliest = addDays(today, -BACKFILL_DAYS);
  // Backfill runs oldest → newest; once caught up, re-pull the last few days.
  let start = row.last_date ? addDays(row.last_date, -REFETCH_DAYS) : earliest;
  if (start < earliest) start = earliest;
  const result: GscSyncResult = { from: start, to: null, days: 0, rows: 0, remaining: false, indexChecked: 0 };
  try {
    let windows = 0;
    while (start <= end) {
      if (windows >= maxWindows) {
        result.remaining = true;
        break;
      }
      const wEnd = addDays(start, WINDOW_DAYS - 1) < end ? addDays(start, WINDOW_DAYS - 1) : end;
      const range = { startDate: start, endDate: wEnd };
      const [days, detail, pages, devices, countries] = await Promise.all([
        query(token, row.site_url, { ...range, dimensions: ['date'] }),
        query(token, row.site_url, { ...range, dimensions: ['date', 'query', 'page'] }),
        query(token, row.site_url, { ...range, dimensions: ['date', 'page'] }),
        query(token, row.site_url, { ...range, dimensions: ['date', 'device'] }),
        query(token, row.site_url, { ...range, dimensions: ['date', 'country'] }),
      ]);
      const stmts: D1PreparedStatement[] = [
        env.DB.prepare('DELETE FROM bee_gsc_days WHERE date BETWEEN ? AND ?').bind(start, wEnd),
        env.DB.prepare('DELETE FROM bee_gsc_rows WHERE date BETWEEN ? AND ?').bind(start, wEnd),
        env.DB.prepare('DELETE FROM bee_gsc_pages WHERE date BETWEEN ? AND ?').bind(start, wEnd),
        env.DB.prepare('DELETE FROM bee_gsc_dims WHERE date BETWEEN ? AND ?').bind(start, wEnd),
      ];
      for (const r of days) stmts.push(env.DB.prepare('INSERT INTO bee_gsc_days (date, clicks, impressions, position) VALUES (?, ?, ?, ?)').bind(r.keys[0], r.clicks, r.impressions, r.position));
      for (const r of detail)
        stmts.push(
          env.DB.prepare('INSERT OR REPLACE INTO bee_gsc_rows (date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)').bind(r.keys[0], r.keys[1], r.keys[2], r.clicks, r.impressions, r.position)
        );
      for (const r of pages) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_gsc_pages (date, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?)').bind(r.keys[0], r.keys[1], r.clicks, r.impressions, r.position));
      for (const [dim, list] of [['device', devices], ['country', countries]] as const)
        for (const r of list)
          stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_gsc_dims (date, dim, value, clicks, impressions) VALUES (?, ?, ?, ?, ?)').bind(r.keys[0], dim, r.keys[1].toLowerCase(), r.clicks, r.impressions));
      await runBatches(env, stmts);
      result.days += days.length;
      result.rows += detail.length;
      const lastWithData = days.map((d) => d.keys[0]).sort().pop();
      if (lastWithData) result.to = lastWithData;
      windows++;
      start = addDays(wEnd, 1);
    }
    const span = await env.DB.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM bee_gsc_days').first<{ a: string | null; b: string | null }>();
    // Until the backfill reaches today, last_date marks how far it got.
    const lastDate = result.remaining ? addDays(start, -1 + REFETCH_DAYS) : span?.b ?? null;
    await env.DB.prepare('UPDATE bee_gsc_account SET first_date = ?, last_date = ?, last_sync_at = ?, last_error = NULL, status = ? WHERE id = 1')
      .bind(span?.a ?? null, lastDate, now(), 'connected')
      .run();
    if (!result.remaining) result.indexChecked = await checkIndexing(env, token, row.site_url).catch((err) => {
      console.error('GSC indexing check failed', err);
      return 0;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE bee_gsc_account SET last_sync_at = ?, last_error = ? WHERE id = 1').bind(now(), msg.slice(0, 500)).run();
    throw err;
  }
  return result;
}

/** Loops passes until caught up (first connect / Sync Now / nightly). */
export async function syncGscAll(env: Env): Promise<GscSyncResult> {
  let total: GscSyncResult | null = null;
  for (let pass = 0; pass < 6; pass++) {
    const r = await syncGsc(env);
    total = total ? { ...r, from: total.from, days: total.days + r.days, rows: total.rows + r.rows } : r;
    if (!r.remaining) break;
  }
  return total!;
}

// ---- Indexing watch ----------------------------------------------------

/** Inspects pages from the site's sitemaps changed in the last 30 days that
 * aren't confirmed indexed yet (re-checks unindexed ones after 2 days). */
async function checkIndexing(env: Env, token: string, site: string): Promise<number> {
  const r = await fetch(`${WM}/sites/${encodeURIComponent(site)}/sitemaps`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return 0;
  const maps = (((await r.json()) as { sitemap?: { path: string }[] }).sitemap ?? []).map((s) => s.path);
  const origin = site.startsWith('sc-domain:') ? `https://${site.slice(10)}` : site.replace(/\/$/, '');
  if (!maps.length) maps.push(`${origin}/sitemap.xml`);
  const urls = new Map<string, string | null>();
  const seen = new Set<string>();
  const queue = [...maps];
  while (queue.length && seen.size < 10) {
    const m = queue.shift()!;
    if (seen.has(m)) continue;
    seen.add(m);
    try {
      const res = await fetch(m, { headers: { 'User-Agent': 'MikeOS/1.0 (+indexing watch)' } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const block of xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) ?? []) {
        const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
        if (loc) queue.push(loc);
      }
      for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
        const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
        if (loc) urls.set(loc.replace(/&amp;/g, '&'), block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1]?.slice(0, 10) ?? null);
      }
    } catch {
      continue;
    }
  }
  const since = addDays(easternToday(), -30);
  const recheck = new Date(Date.now() - 2 * 86400000).toISOString();
  const { results } = await env.DB.prepare('SELECT url, verdict, checked_at FROM bee_gsc_index').all<{ url: string; verdict: string | null; checked_at: string | null }>();
  const known = new Map((results ?? []).map((k) => [k.url, k]));
  const todo = [...urls.entries()]
    .filter(([u, lastmod]) => lastmod && lastmod >= since && (() => {
      const k = known.get(u);
      return !k || (k.verdict !== 'PASS' && (k.checked_at ?? '') < recheck);
    })())
    .sort((a, b) => (b[1] ?? '').localeCompare(a[1] ?? ''))
    .slice(0, 40);
  let n = 0;
  for (const [url, lastmod] of todo) {
    const res = await fetch(INSPECT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: site }),
    });
    if (!res.ok) break; // quota or permission — try again tomorrow
    const ir = ((await res.json()) as { inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } }).inspectionResult?.indexStatusResult;
    await env.DB.prepare(
      `INSERT INTO bee_gsc_index (url, lastmod, verdict, coverage, last_crawl, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET lastmod = excluded.lastmod, verdict = excluded.verdict, coverage = excluded.coverage, last_crawl = excluded.last_crawl, checked_at = excluded.checked_at`
    )
      .bind(url, lastmod, ir?.verdict ?? null, ir?.coverageState ?? null, ir?.lastCrawlTime ?? null, now())
      .run();
    n++;
  }
  return n;
}

/** Nightly at 07:20 UTC with the other Bee jobs, or any later :20 if the
 * last sync is over 20h old — only while connected. */
export async function gscSyncDue(env: Env, scheduledTime: number): Promise<boolean> {
  const row = await loadGsc(env);
  if (!row?.refresh_token_enc || !row.site_url) return false;
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  return !row.last_sync_at || row.last_sync_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}
