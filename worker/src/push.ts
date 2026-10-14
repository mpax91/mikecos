import { Hono } from 'hono';
import type { Env } from './types';
import { decryptField, encryptField } from './cryptoField';

/**
 * Task reminders as push notifications (migration 0128, Mike 2026-10-14).
 *
 * Standard Web Push, done by hand with WebCrypto so there's no npm
 * dependency and no third-party service:
 *  - VAPID (RFC 8292): an ES256 JWT signed with the app's own key pair,
 *    made on first use and kept in `push_settings` (private half encrypted
 *    with CLOUD_ACCOUNT_ENC_KEY — no new Worker secret).
 *  - Payload encryption (RFC 8291, aes128gcm / RFC 8188): ephemeral ECDH
 *    with the browser's p256dh key + its auth secret.
 * Chrome on Windows shows these as Windows notifications (Chrome just has
 * to be running); an installed Android PWA shows Android notifications.
 *
 * The every-2-minutes cron calls `sendDueTaskPushes`: open tasks due today (Eastern)
 * whose due_time has arrived, not sent yet for that date+time, at most
 * LATE_LIMIT_MIN old (so a deploy, or a time set in the past, doesn't
 * fire a burst of stale pings).
 */

const HOME_TZ = 'America/New_York';
const LATE_LIMIT_MIN = 30;
const VAPID_SUBJECT = 'mailto:michaelpalladino@gmail.com';

export const pushRouter = new Hono<{ Bindings: Env }>();

// ---------- base64url helpers ----------
function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const enc = new TextEncoder();

// ---------- VAPID keys ----------
type Vapid = { publicKey: string; privateKey: CryptoKey };
let cachedVapid: Vapid | null = null;

export async function getVapid(env: Env): Promise<Vapid> {
  if (cachedVapid) return cachedVapid;
  let row = await env.DB.prepare('SELECT vapid_public, vapid_private_enc FROM push_settings WHERE id = 1').first<{
    vapid_public: string;
    vapid_private_enc: string;
  }>();
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64u((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    const privEnc = await encryptField(env, jwk, 'CLOUD_ACCOUNT_ENC_KEY');
    // INSERT OR IGNORE: two first calls racing keep whichever landed first.
    await env.DB.prepare('INSERT OR IGNORE INTO push_settings (id, vapid_public, vapid_private_enc, created_at) VALUES (1, ?, ?, ?)').bind(pub, privEnc, new Date().toISOString()).run();
    row = await env.DB.prepare('SELECT vapid_public, vapid_private_enc FROM push_settings WHERE id = 1').first();
  }
  const jwk = JSON.parse(await decryptField(env, row!.vapid_private_enc, 'CLOUD_ACCOUNT_ENC_KEY'));
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cachedVapid = { publicKey: row!.vapid_public, privateKey };
  return cachedVapid;
}

async function vapidAuthHeader(vapid: Vapid, endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already raw r||s (what JWS ES256 wants).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---------- RFC 8291 payload encryption ----------
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(p256dh: string, authSecret: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// ---------- sending ----------
export type PushMessage = { title: string; body?: string; url?: string; tag?: string; taskId?: string };
type SubRow = { id: string; endpoint: string; p256dh: string; auth: string; label: string | null };

/** Sends one message to one device. Returns 'ok' | 'gone' (subscription
 * expired — caller deletes it) | an error string. */
async function sendOne(env: Env, vapid: Vapid, sub: SubRow, msg: PushMessage, fetcher: typeof fetch = fetch): Promise<'ok' | 'gone' | string> {
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(msg)));
    const res = await fetcher(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthHeader(vapid, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '3600',
        Urgency: 'high',
        ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return 'ok';
  } catch (err) {
    return String(err instanceof Error ? err.message : err).slice(0, 200);
  }
}

/** Sends to every subscribed device; drops expired subscriptions. Returns
 * how many devices accepted it. */
export async function pushToAll(env: Env, msg: PushMessage, fetcher: typeof fetch = fetch): Promise<{ sent: number; failed: number; removed: number }> {
  const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions').all<SubRow>();
  const subs = results ?? [];
  if (!subs.length) return { sent: 0, failed: 0, removed: 0 };
  const vapid = await getVapid(env);
  const ts = new Date().toISOString();
  let sent = 0,
    failed = 0,
    removed = 0;
  for (const sub of subs) {
    const r = await sendOne(env, vapid, sub, msg, fetcher);
    if (r === 'ok') {
      sent++;
      await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?').bind(ts, sub.id).run();
    } else if (r === 'gone') {
      removed++;
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    } else {
      failed++;
      await env.DB.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').bind(r, sub.id).run();
    }
  }
  return { sent, failed, removed };
}

// ---------- the cron job ----------
function easternNow(at: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HOME_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Called from the every-2-minutes cron tick. `at` is the tick's scheduled time. */
export async function sendDueTaskPushes(env: Env, at: Date = new Date(), fetcher: typeof fetch = fetch): Promise<{ due: number; sent: number }> {
  const anyDevice = await env.DB.prepare('SELECT 1 AS x FROM push_subscriptions LIMIT 1').first();
  if (!anyDevice) return { due: 0, sent: 0 };
  const { date, time } = easternNow(at);
  const nowMin = minutesOf(time);
  // due_time is 'HH:MM' (zero-padded) so string comparison is time order.
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE archived_tree(id) AS (
       SELECT id FROM entities WHERE is_top_level = 1 AND status = 'archived'
       UNION ALL
       SELECT e.id FROM entities e JOIN archived_tree a ON e.parent_id = a.id
     )
     SELECT e.id, e.title, e.due_date, e.due_time FROM entities e
     WHERE e.type = 'task' AND e.status = 'open' AND e.due_date = ? AND e.due_time IS NOT NULL AND e.due_time <= ?
       AND e.id NOT IN (SELECT id FROM archived_tree)
       AND NOT EXISTS (SELECT 1 FROM task_push_log l WHERE l.entity_id = e.id AND l.fire_key = e.due_date || ' ' || e.due_time)`,
  )
    .bind(date, time)
    .all<{ id: string; title: string; due_date: string; due_time: string }>();

  let sent = 0;
  let due = 0;
  for (const t of results ?? []) {
    const fireKey = `${t.due_date} ${t.due_time}`;
    const late = nowMin - minutesOf(t.due_time);
    // Claim it first so an overlapping tick can't double-send.
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO task_push_log (entity_id, fire_key, sent_at, devices) VALUES (?, ?, ?, 0)').bind(t.id, fireKey, new Date().toISOString()).run();
    if (!claim.meta.changes) continue;
    if (late > LATE_LIMIT_MIN) continue; // logged as handled, never sent
    due++;
    const r = await pushToAll(env, { title: t.title || 'Task', body: `Due now · ${formatTime12(t.due_time)}`, url: `/today?task=${t.id}`, tag: `task-${t.id}`, taskId: t.id }, fetcher);
    sent += r.sent;
    await env.DB.prepare('UPDATE task_push_log SET devices = ? WHERE entity_id = ? AND fire_key = ?').bind(r.sent, t.id, fireKey).run();
  }
  return { due, sent };
}

// ---------- routes (/api/push) ----------
pushRouter.get('/key', async (c) => {
  try {
    return c.json({ publicKey: (await getVapid(c.env)).publicKey });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

pushRouter.get('/devices', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, endpoint, label, created_at, last_ok_at, last_error FROM push_subscriptions ORDER BY created_at ASC').all();
  const { results: recent } = await c.env.DB.prepare(
    `SELECT l.entity_id, l.fire_key, l.sent_at, l.devices, e.title FROM task_push_log l LEFT JOIN entities e ON e.id = l.entity_id
     ORDER BY l.sent_at DESC LIMIT 10`,
  ).all();
  return c.json({ devices: results ?? [], recent: recent ?? [] });
});

pushRouter.post('/subscribe', async (c) => {
  const body = await c.req.json<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; label?: string }>();
  const s = body.subscription;
  if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) {
    return c.json({ error: 'subscription with endpoint + keys.p256dh + keys.auth is required' }, 400);
  }
  const label = (body.label ?? '').trim().slice(0, 80) || null;
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = COALESCE(excluded.label, push_subscriptions.label), last_error = NULL`,
  )
    .bind(crypto.randomUUID(), s.endpoint, s.keys.p256dh, s.keys.auth, label, ts)
    .run();
  const row = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).first<{ id: string }>();
  return c.json({ ok: true, id: row?.id });
});

pushRouter.post('/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: string; id?: string }>();
  if (body.id) await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(body.id).run();
  else if (body.endpoint) await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  else return c.json({ error: 'endpoint or id is required' }, 400);
  return c.json({ ok: true });
});

pushRouter.post('/test', async (c) => {
  const r = await pushToAll(c.env, { title: 'MikeOS', body: 'Test notification — reminders will look like this.', url: '/today', tag: 'test' });
  return c.json(r);
});
