import { Hono } from 'hono';
import type { Env } from '../types';
import { deriveBee, findBeeFolders, loadBeeSettings, scanBee } from './ingest';
import { linkBeeContacts } from './contacts';
import { loadSubscribers, spotlightFor, substackDashboard } from './summary';
import { isPaidType } from './engagement';
import { disconnectGsc, gscAuthUrl, syncGscAll } from './gsc';
import { searchDashboard } from './search';

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
