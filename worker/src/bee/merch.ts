import type { Env } from '../types';
import { decryptField, encryptField } from '../cryptoField';
import { appOrigin } from '../statements/engine';
import { syncTaxPacketSection } from '../statements/taxPacket';
import { bold, bullets, para, text } from '../statements/vaultDoc';
import { loadKeys } from './bing';

/** Bedford Bee merch store on Fourthwall (Mike, 2026-10-12).
 *
 * Orders arrive two ways, both into `bee_fw_orders` keyed by Fourthwall's
 * order id:
 *   - the Open API: an API user (Fourthwall → Settings → For Developers →
 *     Open API → Create API User) pasted in Settings → Bedford Bee,
 *     encrypted; first sync pulls every order, then every hour at the Bee
 *     :20 slot only orders updated since the last sync (status changes,
 *     cancellations). API rows carry items, item costs and UTM tags.
 *   - the orders CSV export ("Bee-orders_export-….csv") dropped in the Drive
 *     "Bedford Bee" folder — told apart by its header row. No items or
 *     costs, but it does carry refunds. An API row wins; a CSV only adds its
 *     refunded amount to it.
 *
 * Buyers are linked to Contacts the same way as Substack subscribers
 * (email → one personal card with the same full name → new contact), and
 * carry an automatic "Merch" label. Mike's own orders (any email of a
 * connected Google/Drive account) count as sales but aren't linked.
 *
 * Money rules: Sales = merchandise − discounts − refunds (cancelled orders
 * count for nothing). Profit = Sales − item costs (Fourthwall's base cost
 * per item, from the API) + tips. Shipping and sales tax are charged to the
 * buyer and pass through to Fourthwall — shown, never counted as income. */

const ENC = 'CLOUD_ACCOUNT_ENC_KEY';
const API = 'https://api.fourthwall.com/open-api/v1.0';
const now = () => new Date().toISOString();
const easternDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const r2 = (n: number) => Math.round(n * 100) / 100;
const uid = () => crypto.randomUUID();

export const MERCH_TAX_KEY = 'bee:merch';

// ---------------------------------------------------------------- model

export interface MerchItem {
  name: string;
  variant: string | null;
  sku: string | null;
  qty: number;
  price: number | null; // per unit
  cost: number | null; // per unit (Fourthwall base cost)
}

interface OrderRow {
  id: string;
  friendly_id: string | null;
  type: string | null;
  created_at: string;
  day: string;
  status: string | null;
  email: string | null;
  name: string | null;
  ship_name: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ship_city: string | null;
  ship_state: string | null;
  marketing_opt_in: number | null;
  merchandise: number;
  discount: number;
  refunded: number;
  shipping: number;
  tax: number;
  donation: number;
  gift_cards: number;
  total: number;
  items_cost: number | null;
  items_json: string | null;
  promo_code: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  source: 'api' | 'csv';
  contact_id: string | null;
  updated_at: string | null;
}

type NewOrder = Omit<OrderRow, 'contact_id' | 'updated_at'>;

const COLS: (keyof NewOrder)[] = [
  'id',
  'friendly_id',
  'type',
  'created_at',
  'day',
  'status',
  'email',
  'name',
  'ship_name',
  'phone',
  'address',
  'city',
  'state',
  'zip',
  'ship_city',
  'ship_state',
  'marketing_opt_in',
  'merchandise',
  'discount',
  'refunded',
  'shipping',
  'tax',
  'donation',
  'gift_cards',
  'total',
  'items_cost',
  'items_json',
  'promo_code',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'source',
];

const isCancelled = (status: string | null) => /CANCEL/i.test(status ?? '');
const clean = (s: unknown): string | null => {
  const t = String(s ?? '').trim();
  return t ? t : null;
};
const money = (s: unknown): number => {
  const n = Number(String(s ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const statusOf = (s: unknown) => clean(s)?.toUpperCase().replace(/\s+/g, '_') ?? null;

// ---------------------------------------------------------------- API

interface FwMoney {
  value: number;
  currency?: string;
}
interface FwAddress {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
}
interface FwOrder {
  id: string;
  friendlyId?: string;
  status?: string;
  email?: string;
  emailMarketingOptIn?: boolean;
  promotionId?: string;
  amounts?: { subtotal?: FwMoney; shipping?: FwMoney; tax?: FwMoney; donation?: FwMoney; discount?: FwMoney; total?: FwMoney; giftCards?: { amountUsed?: FwMoney }[] };
  billing?: { address?: FwAddress };
  shipping?: { address?: FwAddress };
  offers?: {
    name?: string;
    variant?: { name?: string; sku?: string; quantity?: number; unitPrice?: FwMoney; price?: FwMoney; unitCost?: FwMoney; cost?: FwMoney; attributes?: { description?: string } };
  }[];
  source?: { type?: string };
  trackingParams?: { utm_source?: string; utm_medium?: string; utm_campaign?: string };
  createdAt: string;
}

export function orderFromApi(o: FwOrder): NewOrder {
  const m = (x?: FwMoney) => (x && Number.isFinite(Number(x.value)) ? Number(x.value) : 0);
  const items: MerchItem[] = (o.offers ?? []).map((of) => {
    const v = of.variant ?? {};
    const qty = Number(v.quantity) || 1;
    const price = v.unitPrice ? m(v.unitPrice) : v.price ? m(v.price) : null;
    const cost = v.unitCost ? m(v.unitCost) : v.cost ? m(v.cost) : null;
    return { name: of.name ?? v.name ?? 'Item', variant: clean(v.attributes?.description) ?? null, sku: clean(v.sku), qty, price, cost };
  });
  const costKnown = items.length > 0 && items.every((i) => i.cost !== null);
  const b = o.billing?.address ?? {};
  const s = o.shipping?.address ?? {};
  const street = (a: FwAddress) => [a.address1, a.address2].map(clean).filter(Boolean).join(', ') || null;
  return {
    id: o.id,
    friendly_id: clean(o.friendlyId),
    type: o.source?.type === 'SAMPLES_ORDER' ? 'Sample' : o.source?.type === 'GIVEAWAY_LINKS' ? 'Giveaway' : 'Order',
    created_at: o.createdAt,
    day: easternDay(o.createdAt),
    status: statusOf(o.status),
    email: clean(o.email)?.toLowerCase() ?? null,
    name: clean(b.name) ?? clean(s.name),
    ship_name: clean(s.name),
    phone: clean(b.phone) ?? clean(s.phone),
    address: street(b) ?? street(s),
    city: clean(b.city) ?? clean(s.city),
    state: clean(b.state) ?? clean(s.state),
    zip: clean(b.zip) ?? clean(s.zip),
    ship_city: clean(s.city),
    ship_state: clean(s.state),
    marketing_opt_in: o.emailMarketingOptIn == null ? null : o.emailMarketingOptIn ? 1 : 0,
    merchandise: m(o.amounts?.subtotal),
    discount: m(o.amounts?.discount),
    refunded: 0,
    shipping: m(o.amounts?.shipping),
    tax: m(o.amounts?.tax),
    donation: m(o.amounts?.donation),
    gift_cards: (o.amounts?.giftCards ?? []).reduce((n, g) => n + m(g.amountUsed), 0),
    total: m(o.amounts?.total),
    items_cost: costKnown ? r2(items.reduce((n, i) => n + (i.cost ?? 0) * i.qty, 0)) : null,
    items_json: JSON.stringify(items),
    promo_code: clean(o.promotionId),
    utm_source: clean(o.trackingParams?.utm_source),
    utm_medium: clean(o.trackingParams?.utm_medium),
    utm_campaign: clean(o.trackingParams?.utm_campaign),
    source: 'api',
  };
}

/** One CSV row of Fourthwall's orders export. */
export function orderFromCsv(r: Record<string, string>): NewOrder | null {
  const id = clean(r.id);
  const created = clean(r.date);
  if (!id || !created || isNaN(Date.parse(created))) return null;
  const merchandise = money(r.merchandise);
  const shipping = money(r.shipping);
  const tax = money(r.taxes);
  const donation = money(r.donation);
  const discount = Math.abs(money(r.discount));
  const billName = [clean(r.billing_first_name), clean(r.billing_last_name)].filter(Boolean).join(' ') || null;
  return {
    id,
    friendly_id: clean(r.friendly_id),
    type: clean(r.type) ?? 'Order',
    created_at: new Date(created).toISOString(),
    day: easternDay(created),
    status: statusOf(r.status),
    email: clean(r.customer_email)?.toLowerCase() ?? null,
    name: billName ?? clean(r.shipping_name),
    ship_name: clean(r.shipping_name),
    phone: clean(r.customer_phone) ?? clean(r.shipping_phone_number),
    address: clean(r.billing_address) ?? clean(r.shipping_address),
    city: clean(r.billing_city) ?? clean(r.shipping_city),
    state: clean(r.billing_state) ?? clean(r.shipping_state),
    zip: clean(r.billing_zip) ?? clean(r.shipping_zip),
    ship_city: clean(r.shipping_city),
    ship_state: clean(r.shipping_state),
    marketing_opt_in: /^true$/i.test(r.marketing_opt_in ?? '') ? 1 : /^false$/i.test(r.marketing_opt_in ?? '') ? 0 : null,
    merchandise,
    discount,
    refunded: Math.abs(money(r.refunded)),
    shipping,
    tax,
    donation,
    gift_cards: 0,
    total: r2(merchandise + shipping + tax + donation - discount),
    items_cost: null,
    items_json: null,
    promo_code: clean(r.promotion_code),
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    source: 'csv',
  };
}

export const isFourthwallCsv = (headers: string[]) => {
  const h = new Set(headers.map((x) => x.toLowerCase()));
  return h.has('friendly_id') && h.has('merchandise') && h.has('customer_email');
};

async function upsert(env: Env, orders: NewOrder[]) {
  if (!orders.length) return;
  const ts = now();
  const ids = orders.map((o) => o.id);
  const api = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT id FROM bee_fw_orders WHERE source = 'api' AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of results ?? []) api.add(r.id);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const o of orders) {
    if (o.source === 'csv' && api.has(o.id)) {
      // The API row is richer — the export only adds what the API lacks.
      stmts.push(env.DB.prepare('UPDATE bee_fw_orders SET refunded = ?, updated_at = ? WHERE id = ?').bind(o.refunded, ts, o.id));
      continue;
    }
    const keep = o.source === 'api' ? ', refunded = MAX(excluded.refunded, bee_fw_orders.refunded)' : '';
    const set = COLS.filter((c) => c !== 'id' && !(o.source === 'api' && c === 'refunded'))
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    stmts.push(
      env.DB.prepare(
        `INSERT INTO bee_fw_orders (${COLS.join(', ')}, updated_at) VALUES (${COLS.map(() => '?').join(', ')}, ?)
         ON CONFLICT(id) DO UPDATE SET ${set}${keep}, updated_at = excluded.updated_at`,
      ).bind(...COLS.map((c) => o[c] ?? null), ts),
    );
  }
  for (let i = 0; i < stmts.length; i += 60) await env.DB.batch(stmts.slice(i, i + 60));
}

export async function ingestFourthwallCsv(env: Env, records: Record<string, string>[]): Promise<number> {
  const orders = records.map(orderFromCsv).filter((o): o is NewOrder => !!o);
  await upsert(env, orders);
  return orders.length;
}

// ---- Credentials + sync

interface FwKeys {
  fw_user_enc: string | null;
  fw_pass_enc: string | null;
  fw_shop_json: string | null;
  fw_last_sync_at: string | null;
  fw_last_full_at: string | null;
  fw_last_error: string | null;
}
async function fwKeys(env: Env): Promise<FwKeys> {
  await loadKeys(env); // makes sure the row exists
  return (await env.DB.prepare('SELECT fw_user_enc, fw_pass_enc, fw_shop_json, fw_last_sync_at, fw_last_full_at, fw_last_error FROM bee_keys WHERE id = 1').first<FwKeys>())!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fwGet<T>(auth: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'User-Agent': 'MikeOS/1.0 (Bedford Bee dashboard)' } });
    if (r.ok) return (await r.json()) as T;
    if (r.status === 429 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const body = (await r.text()).slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new Error('Fourthwall rejected the API user — check the username and password (Fourthwall → Settings → For Developers → Open API).');
    throw new Error(`Fourthwall ${path.split('?')[0]} ${r.status}: ${body}`);
  }
}

const basic = (user: string, pass: string) => btoa(`${user}:${pass}`);

/** Checks the API user against the shop, then saves it (null disconnects;
 * orders already pulled are kept). */
export async function saveFourthwall(env: Env, creds: { username: string; password: string } | null): Promise<{ shop: string | null }> {
  await loadKeys(env);
  if (!creds) {
    await env.DB.prepare('UPDATE bee_keys SET fw_user_enc = NULL, fw_pass_enc = NULL, fw_last_error = NULL, updated_at = ? WHERE id = 1').bind(now()).run();
    return { shop: null };
  }
  const shop = await fwGet<{ id: string; name?: string; domain?: string; publicDomain?: string; currency?: string }>(basic(creds.username, creds.password), '/shops/current');
  await env.DB.prepare('UPDATE bee_keys SET fw_user_enc = ?, fw_pass_enc = ?, fw_shop_json = ?, fw_last_sync_at = NULL, fw_last_full_at = NULL, fw_last_error = NULL, updated_at = ? WHERE id = 1')
    .bind(await encryptField(env, creds.username, ENC), await encryptField(env, creds.password, ENC), JSON.stringify(shop), now())
    .run();
  return { shop: shop.name ?? shop.id };
}

export interface FwSyncResult {
  pages: number;
  orders: number;
  full: boolean;
}

/** Full pull on the first run and weekly (catches anything an updatedAt
 * window could miss); otherwise orders updated since the last sync − 2 days. */
export async function syncFourthwall(env: Env, forceFull = false): Promise<FwSyncResult> {
  const k = await fwKeys(env);
  if (!k.fw_user_enc || !k.fw_pass_enc) throw new Error('Fourthwall isn’t connected.');
  const auth = basic(await decryptField(env, k.fw_user_enc, ENC), await decryptField(env, k.fw_pass_enc, ENC));
  const full = forceFull || !k.fw_last_full_at || Date.now() - Date.parse(k.fw_last_full_at) > 7 * 86400000 || !k.fw_last_sync_at;
  const since = !full && k.fw_last_sync_at ? new Date(Date.parse(k.fw_last_sync_at) - 2 * 86400000).toISOString() : null;
  const started = now();
  const out: FwSyncResult = { pages: 0, orders: 0, full };
  try {
    for (let page = 0; page < 200; page++) {
      const qs = new URLSearchParams({ page: String(page), size: '100' });
      if (since) qs.set('updatedAt[gt]', since);
      const r = await fwGet<{ results: FwOrder[]; totalPages?: number }>(auth, `/order?${qs}`);
      out.pages++;
      const orders = (r.results ?? []).filter((o) => o?.id && o.createdAt).map(orderFromApi);
      await upsert(env, orders);
      out.orders += orders.length;
      if (!r.results?.length || (r.totalPages != null && page >= r.totalPages - 1)) break;
    }
    await env.DB.prepare(`UPDATE bee_keys SET fw_last_sync_at = ?, fw_last_error = NULL${full ? ', fw_last_full_at = ?' : ''} WHERE id = 1`)
      .bind(...(full ? [started, started] : [started]))
      .run();
  } catch (err) {
    await env.DB.prepare('UPDATE bee_keys SET fw_last_error = ? WHERE id = 1')
      .bind(err instanceof Error ? err.message : String(err))
      .run();
    throw err;
  }
  await deriveMerch(env);
  return out;
}

/** Hourly at the Bee :20 slot (one cheap API call when nothing changed). */
export async function fwSyncDue(env: Env): Promise<boolean> {
  const k = await fwKeys(env);
  if (!k.fw_user_enc) return false;
  return !k.fw_last_sync_at || Date.now() - Date.parse(k.fw_last_sync_at) > 50 * 60000;
}

export async function deriveMerch(env: Env): Promise<void> {
  await linkMerchContacts(env);
  await syncMerchTaxPackets(env);
}

// ---------------------------------------------------------------- contacts

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function emailsOf(json: string | null): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? (x.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()) : [])) : [];
  } catch {
    return [];
  }
}
const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Contacts' tidyNameCase rule: only all-lowercase names are Title-Cased. */
function tidyName(name: string): string {
  const t = name.trim();
  if (!/[a-z]/.test(t) || /[@\d]/.test(t) || t !== t.toLowerCase()) return t;
  return t
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/(^|['-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()))
    .join(' ');
}

/** Mike's own addresses: every connected cloud account's email. */
export async function myEmails(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare('SELECT account_email FROM cloud_accounts WHERE account_email IS NOT NULL').all<{ account_email: string }>();
  return new Set((results ?? []).map((r) => r.account_email.trim().toLowerCase()));
}

export interface MerchLinkResult {
  buyers: number;
  matchedEmail: number;
  matchedName: number;
  created: number;
}

/** Same rules as Bee subscribers: (1) a contact with the email (Mike's own
 * cards first, then the voter roll); (2) exactly one of Mike's cards with
 * the buyer's full name — email (and a phone, if the card has none) added
 * to fill blanks; (3) a new contact with name, email, phone and address.
 * Nothing on an existing card is overwritten. One contact per email;
 * Mike's own orders are never linked. */
export async function linkMerchContacts(env: Env): Promise<MerchLinkResult> {
  const out: MerchLinkResult = { buyers: 0, matchedEmail: 0, matchedName: 0, created: 0 };
  const { results: orders } = await env.DB.prepare(`SELECT * FROM bee_fw_orders WHERE email IS NOT NULL ORDER BY created_at DESC`).all<OrderRow>();
  if (!orders?.length) return out;
  const mine = await myEmails(env);
  // Newest order per email (its name/address is the freshest).
  const byBuyer = new Map<string, OrderRow[]>();
  for (const o of orders) if (!mine.has(o.email!)) byBuyer.set(o.email!, [...(byBuyer.get(o.email!) ?? []), o]);

  const { results: contacts } = await env.DB.prepare(`SELECT id, name, emails, phones, source FROM contacts`).all<{ id: string; name: string; emails: string; phones: string; source: string }>();
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));
  const byEmail = new Map<string, { id: string; personal: boolean }>();
  const byName = new Map<string, string[]>();
  for (const c of contacts ?? []) {
    const personal = c.source !== 'voter_file';
    for (const e of emailsOf(c.emails)) {
      const cur = byEmail.get(e);
      if (!cur || (personal && !cur.personal)) byEmail.set(e, { id: c.id, personal });
    }
    if (personal) {
      const k = normName(c.name);
      if (k.includes(' ')) byName.set(k, [...(byName.get(k) ?? []), c.id]);
    }
  }

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [email, list] of byBuyer) {
    // Only cancelled orders: not a buyer — no contact is made for them.
    if (list.every((o) => isCancelled(o.status)) && !list.some((o) => o.contact_id)) continue;
    out.buyers++;
    if (list.some((o) => o.contact_id === 'none')) continue; // Mike deleted that contact — leave it deleted
    const linked = list.find((o) => o.contact_id && byId.has(o.contact_id))?.contact_id;
    if (linked) {
      if (list.some((o) => o.contact_id !== linked)) stmts.push(env.DB.prepare('UPDATE bee_fw_orders SET contact_id = ? WHERE email = ?').bind(linked, email));
      continue;
    }
    const o = list[0];
    let contactId: string | null = byEmail.get(email)?.id ?? null;
    if (contactId) out.matchedEmail++;
    else {
      for (const n of [o.name, o.ship_name]) {
        if (!n) continue;
        const same = byName.get(normName(n)) ?? [];
        if (same.length === 1) {
          contactId = same[0];
          out.matchedName++;
          const c = byId.get(contactId)!;
          if (!emailsOf(c.emails).length) stmts.push(env.DB.prepare('UPDATE contacts SET emails = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([email]), ts, c.id));
          let phones: unknown[] = [];
          try {
            phones = JSON.parse(c.phones || '[]');
          } catch {
            /* keep [] */
          }
          if (o.phone && !phones.length) stmts.push(env.DB.prepare('UPDATE contacts SET phones = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([o.phone]), ts, c.id));
          break;
        }
      }
    }
    if (!contactId) {
      contactId = uid();
      out.created++;
      const name = o.name && normName(o.name).includes(' ') ? o.name : (o.ship_name ?? o.name ?? email);
      const address = o.address ? [o.address, o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO contacts (id, name, circle, emails, phones, address, city, pinned, source, created_at, updated_at, labels) VALUES (?, ?, 'other', ?, ?, ?, ?, 0, 'merch', ?, ?, '[]')`,
        ).bind(contactId, tidyName(name), JSON.stringify([email]), JSON.stringify(o.phone ? [o.phone] : []), address, o.city, ts, ts),
      );
      byEmail.set(email, { id: contactId, personal: true });
    }
    stmts.push(env.DB.prepare('UPDATE bee_fw_orders SET contact_id = ? WHERE email = ?').bind(contactId, email));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return out;
}

// ---------------------------------------------------------------- reading

export interface MerchOrder {
  id: string;
  friendlyId: string | null;
  type: string;
  createdAt: string;
  day: string;
  status: string | null;
  cancelled: boolean;
  email: string | null;
  name: string | null;
  shipName: string | null;
  city: string | null;
  state: string | null;
  shipCity: string | null;
  contactId: string | null;
  isMe: boolean;
  merchandise: number;
  discount: number;
  refunded: number;
  shipping: number;
  tax: number;
  donation: number;
  total: number;
  /** Merchandise − discount − refunds (0 when cancelled). */
  sales: number;
  /** Fourthwall's item costs (null when unknown). */
  cost: number | null;
  /** sales − cost + tips (null when cost unknown). */
  profit: number | null;
  items: MerchItem[];
  units: number | null;
  promo: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  via: 'api' | 'csv';
}

function toOrder(r: OrderRow, mine: Set<string>): MerchOrder {
  const cancelled = isCancelled(r.status);
  const items: MerchItem[] = r.items_json ? JSON.parse(r.items_json) : [];
  const sales = cancelled ? 0 : r2(r.merchandise - r.discount - r.refunded);
  const tips = cancelled ? 0 : r.donation;
  const cost = cancelled ? 0 : r.items_cost;
  return {
    id: r.id,
    friendlyId: r.friendly_id,
    type: r.type ?? 'Order',
    createdAt: r.created_at,
    day: r.day,
    status: r.status,
    cancelled,
    email: r.email,
    name: r.name,
    shipName: r.ship_name,
    city: r.city,
    state: r.state,
    shipCity: r.ship_city,
    contactId: r.contact_id,
    isMe: !!r.email && mine.has(r.email),
    merchandise: r.merchandise,
    discount: r.discount,
    refunded: r.refunded,
    shipping: r.shipping,
    tax: r.tax,
    donation: r.donation,
    total: r.total,
    sales,
    cost,
    profit: cost === null ? null : r2(sales - cost + tips),
    items,
    units: items.length ? items.reduce((n, i) => n + i.qty, 0) : null,
    promo: r.promo_code,
    utm: { source: r.utm_source, medium: r.utm_medium, campaign: r.utm_campaign },
    via: r.source,
  };
}

export async function loadMerchOrders(env: Env): Promise<MerchOrder[]> {
  const { results } = await env.DB.prepare('SELECT * FROM bee_fw_orders ORDER BY created_at DESC').all<OrderRow>();
  const mine = await myEmails(env);
  return (results ?? []).map((r) => toOrder(r, mine));
}

export interface MerchYear {
  year: number;
  orders: number;
  cancelled: number;
  units: number | null;
  merchandise: number;
  discount: number;
  refunded: number;
  sales: number;
  shipping: number;
  tax: number;
  tips: number;
  /** Item costs — null unless every order of the year has them. */
  cost: number | null;
  costKnown: number;
  profit: number | null;
  buyers: number;
}

export function merchYears(orders: MerchOrder[]): MerchYear[] {
  const by = new Map<number, MerchOrder[]>();
  for (const o of orders) {
    const y = Number(o.day.slice(0, 4));
    by.set(y, [...(by.get(y) ?? []), o]);
  }
  return [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => {
      const live = list.filter((o) => !o.cancelled);
      const sum = (f: (o: MerchOrder) => number) => r2(live.reduce((n, o) => n + f(o), 0));
      const known = live.filter((o) => o.cost !== null);
      const cost = live.length && known.length === live.length ? sum((o) => o.cost ?? 0) : null;
      const sales = sum((o) => o.sales);
      const tips = sum((o) => o.donation);
      const units = live.every((o) => o.units !== null) ? live.reduce((n, o) => n + (o.units ?? 0), 0) : null;
      return {
        year,
        orders: live.length,
        cancelled: list.length - live.length,
        units: live.length ? units : 0,
        merchandise: sum((o) => o.merchandise),
        discount: sum((o) => o.discount),
        refunded: sum((o) => o.refunded),
        sales,
        shipping: sum((o) => o.shipping),
        tax: sum((o) => o.tax),
        tips,
        cost,
        costKnown: known.length,
        profit: cost === null ? null : r2(sales - cost + tips),
        buyers: new Set(live.map((o) => o.email ?? o.id)).size,
      };
    });
}

export async function merchDashboard(env: Env) {
  const orders = await loadMerchOrders(env);
  const k = await fwKeys(env);
  const shop = k.fw_shop_json ? (JSON.parse(k.fw_shop_json) as { name?: string; domain?: string; publicDomain?: string }) : null;
  const { results: files } = await env.DB.prepare(`SELECT file_id, file_name, export_date, web_url, row_count, status, error FROM bee_files WHERE kind = 'fourthwall' ORDER BY export_date DESC`).all<{
    file_id: string;
    file_name: string;
    export_date: string | null;
    web_url: string | null;
    row_count: number | null;
    status: string;
    error: string | null;
  }>();
  return {
    today: easternDay(now()),
    connection: {
      connected: !!k.fw_user_enc,
      shop: shop?.name ?? null,
      domain: shop?.publicDomain ?? shop?.domain ?? null,
      lastSyncAt: k.fw_last_sync_at,
      lastError: k.fw_last_error,
    },
    files: (files ?? []).map((f) => ({ fileId: f.file_id, name: f.file_name, exportDate: f.export_date, url: f.web_url, rows: f.row_count, status: f.status, error: f.error })),
    orders,
    years: merchYears(orders),
  };
}

/** The Merch section on a contact card (null when they never ordered). */
export async function merchForContact(env: Env, contactId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM bee_fw_orders WHERE contact_id = ? ORDER BY created_at DESC').bind(contactId).all<OrderRow>();
  if (!results?.length) return null;
  const orders = results.map((r) => toOrder(r, new Set()));
  const live = orders.filter((o) => !o.cancelled);
  if (!live.length) return null;
  return {
    orders: live.length,
    spent: r2(live.reduce((n, o) => n + o.total, 0)),
    sales: r2(live.reduce((n, o) => n + o.sales, 0)),
    first: live[live.length - 1].day,
    last: live[0].day,
    list: live
      .slice(0, 10)
      .map((o) => ({
        id: o.id,
        friendlyId: o.friendlyId,
        day: o.day,
        status: o.status,
        total: o.total,
        items: o.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name}${i.variant ? ` (${i.variant})` : ''}`),
      })),
  };
}

/** Merch totals for a date range (Year in Review). */
export async function merchTotals(env: Env, r: { from: string; to: string }) {
  const row = await env.DB.prepare(`SELECT COUNT(*) n, SUM(merchandise - discount - refunded) s FROM bee_fw_orders WHERE day BETWEEN ? AND ? AND upper(COALESCE(status, '')) NOT LIKE '%CANCEL%'`)
    .bind(r.from, r.to)
    .first<{ n: number; s: number | null }>();
  return { orders: row?.n ?? 0, sales: r2(row?.s ?? 0) };
}

// ---------------------------------------------------------------- taxes

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Bedford Bee (Merch)" section in each Tax Packet (this year and last). */
export async function syncMerchTaxPackets(env: Env): Promise<void> {
  const orders = await loadMerchOrders(env);
  if (!orders.length) return;
  const thisYear = Number(easternDay(now()).slice(0, 4));
  for (const y of merchYears(orders)) {
    if (y.year < thisYear - 1 || !y.orders) continue;
    const partial = y.year === thisYear;
    await syncTaxPacketSection(env, y.year, MERCH_TAX_KEY, {
      title: 'Bedford Bee (Merch)',
      blocks: [
        bullets([
          [
            bold('Orders: '),
            text(
              `${y.orders}${y.units ? ` (${y.units} item${y.units === 1 ? '' : 's'})` : ''} from ${y.buyers} buyer${y.buyers === 1 ? '' : 's'}${y.cancelled ? ` · ${y.cancelled} cancelled, not counted` : ''}`,
            ),
          ],
          [bold('Merchandise sales: '), text(usd(y.merchandise))],
          ...(y.discount ? [[bold('Discounts: '), text(`−${usd(y.discount)}`)]] : []),
          ...(y.refunded ? [[bold('Refunds: '), text(`−${usd(y.refunded)}`)]] : []),
          [bold('Net sales: '), text(usd(y.sales))],
          ...(y.tips ? [[bold('Tips (donations): '), text(usd(y.tips))]] : []),
          [
            bold('Cost of goods (Fourthwall base cost): '),
            text(y.cost !== null ? usd(y.cost) : y.costKnown ? `known for ${y.costKnown} of ${y.orders} orders — not totaled` : 'not available — connect the Fourthwall API in Settings → Bedford Bee'),
          ],
          [bold('Profit: '), text(y.profit !== null ? usd(y.profit) : '— (needs the cost of goods)')],
          [bold('Shipping charged to buyers: '), text(`${usd(y.shipping)} (passes through to Fourthwall — not income)`)],
          [bold('Sales tax collected at checkout: '), text(`${usd(y.tax)} (handled by Fourthwall — not income)`)],
        ]),
        para(`From Fourthwall orders by order date${partial ? ' — year to date, updates hourly' : ''}. Check the total against Fourthwall’s payouts for the year and any 1099-K Fourthwall sends.`),
      ],
      expected: [],
      links: [{ key: 'merch', title: 'Bedford Bee Merch Dashboard', url: `${appOrigin(env)}/bee?tab=merch` }],
    });
  }
}
