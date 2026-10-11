import { Hono } from 'hono';
import type { Env } from '../types';
import { deriveBee, findBeeFolders, loadBeeSettings, scanBee } from './ingest';
import { linkBeeContacts } from './contacts';
import { loadSubscribers, spotlightFor, substackDashboard } from './summary';
import { isPaidType } from './engagement';
import { disconnectGsc, gscAuthUrl, syncGscAll } from './gsc';
import { searchDashboard } from './search';
import { syncGaAll } from './ga';
import { analyticsDashboard } from './analytics';
import { bingDashboard, saveBingKey, syncBing } from './bing';
import { clarityDashboard, saveClarityToken, syncClarity } from './clarity';
import { disconnectMeta, metaAuthUrl, metaDebug, saveMetaApp, syncMeta } from './meta';
import { socialDashboard } from './social';

/** /api/bee — Bedford Bee dashboard. Substack + Stripe come from CSV
 * exports in the Drive "Bedford Bee" folder; more sources (Search
 * Console, GA4, Meta) will hang off this router later. */
export const beeRouter = new Hono<{ Bindings: Env }>();

beeRouter.get('/substack', async (c) => c.json(await substackDashboard(c.env)));

// ---- Google Search Console ----
beeRouter.get('/search', async (c) => c.json(await searchDashboard(c.env)));

// Browser navigation → Google consent (callback: /api/cloud/oauth/callback).
beeRouter.get('/gsc/connect', async (c) => {
  const returnOrigin = c.req.query('returnOrigin') || c.env.ALLOWED_ORIGINS.split(',')[0];
  try {
    return c.redirect(await gscAuthUrl(c.env, new URL(c.req.url).origin, returnOrigin));
  } catch (err) {
    return c.redirect(`${returnOrigin}/settings?cat=bee&gscError=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
});

beeRouter.post('/gsc/sync', async (c) => {
  try {
    return c.json(await syncGscAll(c.env));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---- Google Analytics (same Google connection) ----
beeRouter.get('/analytics', async (c) => c.json(await analyticsDashboard(c.env)));

beeRouter.post('/ga/sync', async (c) => {
  try {
    return c.json(await syncGaAll(c.env));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---- Bing Webmaster Tools + Microsoft Clarity (pasted keys) ----
const fail = (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) });
beeRouter.get('/bing', async (c) => c.json(await bingDashboard(c.env)));
beeRouter.get('/clarity', async (c) => c.json(await clarityDashboard(c.env)));

beeRouter.put('/bing/key', async (c) => {
  const { key } = await c.req.json<{ key: string | null }>();
  try {
    const r = await saveBingKey(c.env, key?.trim() || null);
    // Only the key check runs here — the full pull (4 more Bing calls with
    // backoff) happens on Sync Now / the scheduled run.
    if (r.site) c.executionCtx.waitUntil(syncBing(c.env).catch(() => null));
    return c.json(r);
  } catch (err) {
    return c.json(fail(err), 400);
  }
});
beeRouter.post('/bing/sync', async (c) => {
  try {
    return c.json(await syncBing(c.env));
  } catch (err) {
    return c.json(fail(err), 502);
  }
});
beeRouter.put('/clarity/token', async (c) => {
  const { token } = await c.req.json<{ token: string | null }>();
  try {
    await saveClarityToken(c.env, token?.trim() || null);
    if (token?.trim()) await syncClarity(c.env).catch(() => null);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(fail(err), 400);
  }
});
beeRouter.post('/clarity/sync', async (c) => {
  try {
    return c.json(await syncClarity(c.env));
  } catch (err) {
    return c.json(fail(err), 502);
  }
});

// ---- Meta (Facebook Page + Instagram) ----
beeRouter.get('/social', async (c) => c.json(await socialDashboard(c.env)));
beeRouter.put('/meta/app', async (c) => {
  const { appId, appSecret } = await c.req.json<{ appId: string; appSecret?: string | null }>();
  try {
    await saveMetaApp(c.env, appId ?? '', appSecret?.trim() || null);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(fail(err), 400);
  }
});
beeRouter.get('/meta/connect', async (c) => {
  const returnOrigin = c.req.query('returnOrigin') || c.env.ALLOWED_ORIGINS.split(',')[0];
  try {
    return c.redirect(await metaAuthUrl(c.env, new URL(c.req.url).origin, returnOrigin));
  } catch (err) {
    return c.redirect(`${returnOrigin}/settings?cat=bee&metaError=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
});
beeRouter.post('/meta/sync', async (c) => {
  try {
    return c.json(await syncMeta(c.env, c.req.query('recent') !== '1'));
  } catch (err) {
    return c.json(fail(err), 502);
  }
});
// Diagnostic: raw Meta answers for one FB post + one IG media insights call.
beeRouter.get('/meta/debug', async (c) => c.json(await metaDebug(c.env)));
beeRouter.post('/meta/disconnect', async (c) => {
  await disconnectMeta(c.env);
  return c.json({ ok: true });
});
// Manual tags on a post (overrides nothing — adds to the rule tags).
beeRouter.put('/meta/posts/:platform/:id/tags', async (c) => {
  const { tags } = await c.req.json<{ tags: string[] }>();
  const clean = [...new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  await c.env.DB.prepare('UPDATE bee_meta_posts SET manual_tags = ? WHERE platform = ? AND id = ?').bind(JSON.stringify(clean), c.req.param('platform'), c.req.param('id')).run();
  return c.json({ tags: clean });
});
// Topic rules: [{ topic, keywords }] replaces the list.
beeRouter.put('/topic-rules', async (c) => {
  const { rules } = await c.req.json<{ rules: { topic: string; keywords: string }[] }>();
  const clean = (rules ?? []).map((r) => ({ topic: r.topic.trim(), keywords: r.keywords.trim() })).filter((r) => r.topic && r.keywords);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM bee_topic_rules'),
    ...clean.map((r, i) => c.env.DB.prepare('INSERT OR REPLACE INTO bee_topic_rules (topic, keywords, position) VALUES (?, ?, ?)').bind(r.topic, r.keywords, i)),
  ]);
  return c.json({ rules: clean });
});

beeRouter.post('/gsc/disconnect', async (c) => {
  await disconnectGsc(c.env);
  return c.json({ ok: true });
});

beeRouter.post('/scan', async (c) => {
  try {
    return c.json(await scanBee(c.env));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

beeRouter.get('/settings', async (c) => {
  const s = await loadBeeSettings(c.env);
  return c.json({ cloudAccountId: s.cloud_account_id, folderId: s.folder_id, folderName: s.folder_name, folderUrl: s.folder_url, lastScanAt: s.last_scan_at, lastError: s.last_error });
});

// Candidate "Bedford Bee" folders across connected Google Drives.
beeRouter.get('/folders', async (c) => c.json(await findBeeFolders(c.env)));

beeRouter.patch('/settings', async (c) => {
  const body = await c.req.json<{ cloudAccountId?: string; folderId?: string; folderName?: string; folderUrl?: string | null }>();
  if (!body.cloudAccountId || !body.folderId) return c.json({ error: 'cloudAccountId and folderId are required' }, 400);
  await c.env.DB.prepare('UPDATE bee_settings SET cloud_account_id = ?, folder_id = ?, folder_name = ?, folder_url = ?, updated_at = ? WHERE id = 1')
    .bind(body.cloudAccountId, body.folderId, body.folderName ?? null, body.folderUrl ?? null, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// Re-run derived outputs (contacts, reminder, Tax Packet) without Drive.
beeRouter.post('/derive', async (c) => {
  await deriveBee(c.env);
  return c.json({ ok: true });
});

beeRouter.post('/link-contacts', async (c) => c.json(await linkBeeContacts(c.env)));

/** The Bee section on a contact card (null when not a subscriber). */
export async function beeForContact(env: Env, contactId: string) {
  const subs = await loadSubscribers(env);
  const mine = subs.filter((s) => s.contact_id === contactId && !/^author$/i.test(s.type ?? ''));
  if (!mine.length) return null;
  const s = mine.find((x) => x.active) ?? mine[0];
  if (!s.active) return null; // the Bee label/section disappears once they leave
  const { people } = spotlightFor(subs);
  const p = people.get(s.email) ?? null;
  return {
    email: s.email,
    type: s.type,
    paid: isPaidType(s.type),
    startDate: s.start_date,
    firstPaidDate: s.first_paid_date,
    expires: s.expiration_date,
    cancelled: !!s.cancel_date,
    plan: s.stripe_plan,
    revenue: s.revenue,
    source: s.source_paid ?? s.source_free,
    engagement: p,
  };
}
