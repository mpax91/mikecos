import type { Env } from '../types';
import { decryptField, encryptField } from '../cryptoField';

/** Meta (Facebook Page + Instagram) for the Bedford Bee (2026-10-11).
 *
 * Mike's own Meta app (Development mode — no App Review needed for his own
 * Page). App ID + secret are pasted in Settings → Bedford Bee (secret
 * encrypted). Connect = Facebook Login → long-lived user token → the
 * Bee's Page token (doesn't expire) + its linked Instagram account.
 *
 * Sync:
 *  - full (nightly + on connect): every FB post and IG post/reel within the
 *    2 years Meta keeps — reactions, comments, shares, saves (field counts,
 *    stable) and views/reach (insights, which Meta keeps renaming — any
 *    metric Meta rejects is skipped, never fatal); account-level daily
 *    values in 90-day (FB) / 30-day (IG) windows.
 *  - recent (hourly): posts from the last 10 days, so the 24h / 3d / 7d
 *    snapshots land within an hour of those ages. */

export const META_STATE_PROVIDER = 'meta';
const V = 'v24.0';
const GRAPH = `https://graph.facebook.com/${V}`;
const ENC = 'CLOUD_ACCOUNT_ENC_KEY';
// pages_read_user_content: comment counts on the Page's own posts (Meta treats comments as user content).
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'read_insights', 'business_management', 'instagram_basic', 'instagram_manage_insights'];
const HISTORY_DAYS = 730;
const now = () => new Date().toISOString();
const DAY = 86400000;

export interface MetaAccountRow {
  id: number;
  app_id: string | null;
  app_secret_enc: string | null;
  user_name: string | null;
  user_token_enc: string | null;
  user_token_expires: string | null;
  page_id: string | null;
  page_name: string | null;
  page_token_enc: string | null;
  pages_json: string | null;
  ig_id: string | null;
  ig_username: string | null;
  scopes: string | null;
  status: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_recent_at: string | null;
  last_error: string | null;
}

export async function loadMeta(env: Env): Promise<MetaAccountRow> {
  await env.DB.prepare('INSERT OR IGNORE INTO bee_meta_account (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM bee_meta_account WHERE id = 1').first<MetaAccountRow>())!;
}

export async function saveMetaApp(env: Env, appId: string, secret: string | null): Promise<void> {
  await loadMeta(env);
  if (!/^\d{6,}$/.test(appId.trim())) throw new Error('That doesn’t look like an App ID (it’s a long number, from App settings → Basic).');
  if (secret) await env.DB.prepare('UPDATE bee_meta_account SET app_id = ?, app_secret_enc = ? WHERE id = 1').bind(appId.trim(), await encryptField(env, secret.trim(), ENC)).run();
  else await env.DB.prepare('UPDATE bee_meta_account SET app_id = ? WHERE id = 1').bind(appId.trim()).run();
}

// ---- Graph helpers ------------------------------------------------------

class GraphError extends Error {
  constructor(
    message: string,
    public code: number | null
  ) {
    super(message);
  }
}

async function graph<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const url = path.startsWith('http') ? new URL(path) : new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const r = await fetch(url.toString());
  const j = (await r.json().catch(() => ({}))) as { error?: { message: string; code?: number } } & T;
  if (!r.ok || j.error) throw new GraphError(`Meta: ${j.error?.message ?? r.status}`, j.error?.code ?? null);
  return j;
}

/** Follows paging.next until done (or `max` pages). */
async function graphAll<T>(path: string, params: Record<string, string>, token: string, max = 60): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  let first = true;
  for (let i = 0; i < max; i++) {
    const j: { data?: T[]; paging?: { next?: string } } = first ? await graph(path, params, token) : await graph(next!, {}, token);
    first = false;
    out.push(...(j.data ?? []));
    next = j.paging?.next ?? null;
    if (!next) break;
  }
  return out;
}

// ---- OAuth -------------------------------------------------------------

export async function metaAuthUrl(env: Env, apiOrigin: string, returnOrigin: string): Promise<string> {
  const row = await loadMeta(env);
  if (!row.app_id || !row.app_secret_enc) throw new Error('Paste the Meta App ID and App Secret first.');
  const state = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO cloud_oauth_states (state, provider, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, META_STATE_PROVIDER, `Meta\u0000${returnOrigin}`, now())
    .run();
  const p = new URLSearchParams({ client_id: row.app_id, redirect_uri: `${apiOrigin}/api/cloud/oauth/callback`, state, scope: SCOPES.join(','), response_type: 'code' });
  return `https://www.facebook.com/${V}/dialog/oauth?${p}`;
}

interface PageAcct {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

export async function finishMetaOAuth(env: Env, code: string, redirectUri: string): Promise<void> {
  const row = await loadMeta(env);
  if (!row.app_id || !row.app_secret_enc) throw new Error('Meta app isn’t set up.');
  const secret = await decryptField(env, row.app_secret_enc, ENC);
  const short = await graph<{ access_token: string }>('oauth/access_token', { client_id: row.app_id, client_secret: secret, redirect_uri: redirectUri, code }, '');
  const long = await graph<{ access_token: string; expires_in?: number }>(
    'oauth/access_token',
    { grant_type: 'fb_exchange_token', client_id: row.app_id, client_secret: secret, fb_exchange_token: short.access_token },
    ''
  );
  const userToken = long.access_token;
  const me = await graph<{ name?: string }>('me', { fields: 'name' }, userToken).catch(() => ({ name: undefined }));
  const perms = await graph<{ data: { permission: string; status: string }[] }>('me/permissions', {}, userToken).catch(() => ({ data: [] }));
  const granted = perms.data.filter((p) => p.status === 'granted').map((p) => p.permission);
  const pages = await graphAll<PageAcct>('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' }, userToken);
  const page = pages.find((p) => /bedford\s*bee/i.test(p.name)) ?? (pages.length === 1 ? pages[0] : null);
  if (!page)
    throw new Error(
      pages.length
        ? `Found ${pages.map((p) => p.name).join(', ')} but not The Bedford Bee — reconnect and tick the Bee's Page on Meta's "choose Pages" step.`
        : 'Meta returned no Pages — reconnect and tick The Bedford Bee on the "choose Pages" step.'
    );
  await env.DB.prepare(
    `UPDATE bee_meta_account SET user_name = ?, user_token_enc = ?, user_token_expires = ?, page_id = ?, page_name = ?, page_token_enc = ?, pages_json = ?,
       ig_id = ?, ig_username = ?, scopes = ?, status = 'connected', connected_at = ?, last_error = NULL WHERE id = 1`
  )
    .bind(
      me.name ?? null,
      await encryptField(env, userToken, ENC),
      long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
      page.id,
      page.name,
      await encryptField(env, page.access_token, ENC),
      JSON.stringify(pages.map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account?.username ?? null }))),
      page.instagram_business_account?.id ?? null,
      page.instagram_business_account?.username ?? null,
      granted.join(','),
      now()
    )
    .run();
}

export async function disconnectMeta(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE bee_meta_account SET user_token_enc = NULL, page_token_enc = NULL, status = 'disconnected' WHERE id = 1`).run();
}

// ---- Sync --------------------------------------------------------------

interface PostRow {
  platform: 'fb' | 'ig';
  id: string;
  created_at: string;
  text: string | null;
  permalink: string | null;
  format: string;
  link_url: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  views: number | null;
  reach: number | null;
  raw: unknown;
}

const insightValue = (ins: { data?: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] } | undefined, name: string): number | null => {
  const m = ins?.data?.find((d) => d.name === name);
  const v = m?.total_value?.value ?? m?.values?.[0]?.value;
  return typeof v === 'number' ? v : v && typeof v === 'object' ? Object.values(v as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0) : null;
};

/** Insights for many objects via ?ids=, trying metric sets until Meta accepts one. */
async function batchInsights(ids: string[], metricSets: string[][], token: string): Promise<Map<string, Record<string, number | null>>> {
  const out = new Map<string, Record<string, number | null>>();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    for (const metrics of metricSets) {
      try {
        const j = await graph<Record<string, { insights?: Parameters<typeof insightValue>[0] }>>('', { ids: chunk.join(','), fields: `insights.metric(${metrics.join(',')})` }, token);
        for (const id of chunk) {
          const rec: Record<string, number | null> = {};
          for (const m of metrics) rec[m] = insightValue(j[id]?.insights, m);
          out.set(id, { ...(out.get(id) ?? {}), ...rec });
        }
        break;
      } catch {
        continue; // a metric Meta no longer accepts — try the next, smaller set
      }
    }
  }
  return out;
}

function fbFormat(p: { status_type?: string; attachments?: { data?: { media_type?: string; type?: string }[] } }): string {
  const a = p.attachments?.data?.[0];
  const t = `${a?.media_type ?? ''} ${a?.type ?? ''} ${p.status_type ?? ''}`.toLowerCase();
  if (/reel/.test(t)) return 'reel';
  if (/video/.test(t)) return 'video';
  if (/album|carousel/.test(t)) return 'carousel';
  if (/photo|image/.test(t)) return 'photo';
  if (/link|share|article/.test(t)) return 'link';
  if (!a) return 'text';
  return 'other';
}

async function fetchFbPosts(pageId: string, token: string, sinceDays: number): Promise<PostRow[]> {
  const since = Math.floor((Date.now() - sinceDays * DAY) / 1000);
  type P = {
    id: string;
    created_time: string;
    message?: string;
    permalink_url?: string;
    status_type?: string;
    attachments?: { data?: { media_type?: string; type?: string; unshimmed_url?: string; url?: string; title?: string }[] };
    shares?: { count: number };
    reactions?: { summary?: { total_count: number } };
    comments?: { summary?: { total_count: number } };
  };
  const base = 'id,created_time,message,permalink_url,status_type,attachments{media_type,type,unshimmed_url,url,title},shares,reactions.summary(total_count).limit(0)';
  let withComments = true;
  let posts: P[];
  try {
    posts = await graphAll<P>(`${pageId}/posts`, { fields: `${base},comments.summary(total_count).limit(0)`, since: String(since), limit: '100' }, token);
  } catch (err) {
    // Comments need pages_read_user_content (error #10) — pull everything else meanwhile.
    if (!(err instanceof GraphError) || err.code !== 10) throw err;
    withComments = false;
    posts = await graphAll<P>(`${pageId}/posts`, { fields: base, since: String(since), limit: '100' }, token);
  }
  const ins = await batchInsights(
    posts.map((p) => p.id),
    [['post_media_view'], ['post_impressions'], []].filter((s) => s.length),
    token
  );
  return posts.map((p) => {
    const a = p.attachments?.data?.[0];
    const i = ins.get(p.id) ?? {};
    return {
      platform: 'fb',
      id: p.id,
      created_at: new Date(p.created_time).toISOString(),
      text: p.message ?? a?.title ?? null,
      permalink: p.permalink_url ?? null,
      format: fbFormat(p),
      link_url: a?.unshimmed_url ?? (a?.url && !/facebook\.com/.test(a.url) ? a.url : null),
      likes: p.reactions?.summary?.total_count ?? 0,
      comments: withComments ? (p.comments?.summary?.total_count ?? 0) : null,
      shares: p.shares?.count ?? 0,
      saves: null,
      views: i.post_media_view ?? i.post_impressions ?? null,
      reach: null,
      raw: { status_type: p.status_type, attachment: a?.type ?? null },
    };
  });
}

async function fetchIgPosts(igId: string, token: string, max: number): Promise<PostRow[]> {
  type M = { id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp: string; like_count?: number; comments_count?: number };
  const media = await graphAll<M>(`${igId}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count', limit: '100' }, token, max);
  const cutoff = new Date(Date.now() - HISTORY_DAYS * DAY).toISOString();
  const ins = await batchInsights(
    media.map((m) => m.id),
    [
      ['views', 'reach', 'saved', 'shares'],
      ['reach', 'saved', 'shares'],
      ['reach', 'saved'],
    ],
    token
  );
  return media
    .filter((m) => new Date(m.timestamp).toISOString() >= cutoff || max <= 2)
    .map((m) => {
      const i = ins.get(m.id) ?? {};
      const fmt = m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : m.media_type === 'IMAGE' ? 'photo' : 'other';
      return {
        platform: 'ig',
        id: m.id,
        created_at: new Date(m.timestamp).toISOString(),
        text: m.caption ?? null,
        permalink: m.permalink ?? null,
        format: fmt,
        link_url: null,
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0,
        shares: i.shares ?? null,
        saves: i.saved ?? null,
        views: i.views ?? null,
        reach: i.reach ?? null,
        raw: { media_type: m.media_type, product: m.media_product_type },
      };
    });
}

const BUCKETS: { bucket: string; hours: number; until: number }[] = [
  { bucket: '24h', hours: 24, until: 40 },
  { bucket: '3d', hours: 72, until: 110 },
  { bucket: '7d', hours: 168, until: 240 },
];

async function storePosts(env: Env, posts: PostRow[]): Promise<void> {
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  for (const p of posts) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO bee_meta_posts (platform, id, created_at, text, permalink, format, link_url, likes, comments, shares, saves, views, reach, raw_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, id) DO UPDATE SET text = excluded.text, permalink = excluded.permalink, format = excluded.format, link_url = excluded.link_url,
           likes = excluded.likes, comments = COALESCE(excluded.comments, bee_meta_posts.comments), shares = COALESCE(excluded.shares, bee_meta_posts.shares), saves = COALESCE(excluded.saves, bee_meta_posts.saves),
           views = COALESCE(excluded.views, bee_meta_posts.views), reach = COALESCE(excluded.reach, bee_meta_posts.reach), raw_json = excluded.raw_json, updated_at = excluded.updated_at`
      ).bind(p.platform, p.id, p.created_at, p.text, p.permalink, p.format, p.link_url, p.likes, p.comments, p.shares, p.saves, p.views, p.reach, JSON.stringify(p.raw), ts)
    );
    // Early-read snapshots: first sync after each age, within its window.
    const age = (Date.now() - new Date(p.created_at).getTime()) / 3600000;
    for (const b of BUCKETS) {
      if (age >= b.hours && age < b.until)
        stmts.push(
          env.DB.prepare(
            'INSERT OR IGNORE INTO bee_meta_snaps (platform, id, bucket, age_hours, likes, comments, shares, saves, views, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(p.platform, p.id, b.bucket, Math.round(age * 10) / 10, p.likes, p.comments, p.shares, p.saves, p.views, ts)
        );
    }
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

const isoDay = (t: string) => t.slice(0, 10);

async function syncFbDays(env: Env, pageId: string, token: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const end = Date.now();
  for (const metric of ['page_media_view', 'page_post_engagements', 'page_follows', 'page_daily_follows_unique', 'page_daily_unfollows_unique']) {
    for (let from = end - HISTORY_DAYS * DAY; from < end; from += 89 * DAY) {
      try {
        const j = await graph<{ data?: { name: string; values?: { value: unknown; end_time: string }[] }[] }>(
          `${pageId}/insights`,
          { metric, period: 'day', since: String(Math.floor(from / 1000)), until: String(Math.floor(Math.min(end, from + 89 * DAY) / 1000)) },
          token
        );
        for (const v of j.data?.[0]?.values ?? []) {
          const n = typeof v.value === 'number' ? v.value : null;
          // end_time is the end of the day (next midnight Pacific) — the day before it.
          if (n !== null) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_meta_days (platform, date, metric, value) VALUES (?, ?, ?, ?)').bind('fb', isoDay(new Date(new Date(v.end_time).getTime() - DAY).toISOString()), metric, n));
        }
      } catch {
        break; // Meta rejects this metric (renamed/retired) — skip it
      }
    }
  }
  try {
    const p = await graph<{ followers_count?: number; fan_count?: number }>(pageId, { fields: 'followers_count,fan_count' }, token);
    const today = new Date().toISOString().slice(0, 10);
    if (p.followers_count != null) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_meta_days (platform, date, metric, value) VALUES (?, ?, ?, ?)').bind('fb', today, 'followers', p.followers_count));
  } catch {
    /* optional */
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

async function syncIgDays(env: Env, igId: string, token: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const end = Date.now();
  const put = (date: string, metric: string, value: number) => stmts.push(env.DB.prepare('INSERT OR REPLACE INTO bee_meta_days (platform, date, metric, value) VALUES (?, ?, ?, ?)').bind('ig', date, metric, value));
  for (let from = end - HISTORY_DAYS * DAY; from < end; from += 29 * DAY) {
    try {
      const j = await graph<{ data?: { name: string; values?: { value: number; end_time: string }[] }[] }>(
        `${igId}/insights`,
        { metric: 'reach', period: 'day', since: String(Math.floor(from / 1000)), until: String(Math.floor(Math.min(end, from + 29 * DAY) / 1000)) },
        token
      );
      for (const v of j.data?.[0]?.values ?? []) put(isoDay(new Date(new Date(v.end_time).getTime() - DAY).toISOString()), 'reach', v.value);
    } catch {
      continue; // older than Instagram keeps
    }
  }
  try {
    const j = await graph<{ data?: { values?: { value: number; end_time: string }[] }[] }>(
      `${igId}/insights`,
      { metric: 'follower_count', period: 'day', since: String(Math.floor((end - 29 * DAY) / 1000)), until: String(Math.floor(end / 1000)) },
      token
    );
    for (const v of j.data?.[0]?.values ?? []) put(isoDay(new Date(new Date(v.end_time).getTime() - DAY).toISOString()), 'follower_count', v.value);
  } catch {
    /* needs 100+ followers on Instagram */
  }
  try {
    const p = await graph<{ followers_count?: number }>(igId, { fields: 'followers_count' }, token);
    if (p.followers_count != null) put(new Date().toISOString().slice(0, 10), 'followers', p.followers_count);
  } catch {
    /* optional */
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}

export interface MetaSyncResult {
  fbPosts: number;
  igPosts: number;
  full: boolean;
}

export async function syncMeta(env: Env, full: boolean): Promise<MetaSyncResult> {
  const row = await loadMeta(env);
  if (!row.page_token_enc || !row.page_id) throw new Error('Meta isn’t connected.');
  const token = await decryptField(env, row.page_token_enc, ENC);
  try {
    const fb = await fetchFbPosts(row.page_id, token, full ? HISTORY_DAYS : 10);
    const ig = row.ig_id ? await fetchIgPosts(row.ig_id, token, full ? 40 : 1) : [];
    await storePosts(env, [...fb, ...ig]);
    if (full) {
      await syncFbDays(env, row.page_id, token);
      if (row.ig_id) await syncIgDays(env, row.ig_id, token);
    }
    const note = fb.some((p) => p.comments === null)
      ? 'Comment counts are missing: add pages_read_user_content to the Meta app (Manage everything on your Page → Permissions and features), then Reconnect Meta.'
      : null;
    await env.DB.prepare(`UPDATE bee_meta_account SET ${full ? 'last_sync_at' : 'last_recent_at'} = ?, last_error = ?, status = 'connected' WHERE id = 1`).bind(now(), note).run();
    return { fbPosts: fb.length, igPosts: ig.length, full };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const expired = err instanceof GraphError && (err.code === 190 || err.code === 102);
    await env.DB.prepare('UPDATE bee_meta_account SET last_error = ?, status = ? WHERE id = 1')
      .bind((expired ? `Reconnect needed — ${msg}` : msg).slice(0, 500), expired ? 'error' : 'connected')
      .run();
    throw err;
  }
}

/** Nightly full sync at 07 UTC; a recent-posts refresh every other hour
 * (each :20 slot), so early-read snapshots land close to 24h / 3d / 7d. */
export async function metaSyncDue(env: Env, scheduledTime: number): Promise<'full' | 'recent' | null> {
  const row = await loadMeta(env);
  if (!row.page_token_enc) return null;
  const h = new Date(scheduledTime).getUTCHours();
  if (h === 7 || !row.last_sync_at || row.last_sync_at < new Date(scheduledTime - 26 * 3600000).toISOString()) return 'full';
  return 'recent';
}
