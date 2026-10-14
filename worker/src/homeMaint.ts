import { Hono } from 'hono';
import type { Env } from './types';
import { cloudAccess } from './cloud';

/** Home → Maintenance (Mike, 2026-10-14; migration 0130).
 *
 * Receipts live in ONE Drive folder "Home Maintenance" (top level of a
 * connected Google Drive), named
 *     YYYY.MM.DD - System - Vendor - Service - $Amount.pdf
 * Everything is read from the NAME — no PDF reading, no AI. A name that
 * can't be read still lands as a record with `parse_error`, so Mike can fix
 * the name (or the fields, by hand) instead of it vanishing.
 *
 * Recurring items (Septic Pump-Out every 48 months, …) say how often a thing
 * is due. The newest receipt for the item's system (and, if set, with one of
 * its match words in the vendor/service) sets the next due date; a
 * "Schedule <item>" task lands on Today `lead_days` before it and is checked
 * off by itself when the next receipt arrives. */

export const HOME_MAINT_FOLDER_NAME = 'Home Maintenance';

export const SYSTEMS = ['Septic', 'HVAC', 'Plumbing', 'Electrical', 'Roof', 'Chimney', 'Exterior', 'Landscaping', 'Appliances', 'Other'] as const;

/** Other words for a system that may appear in a file name. */
const SYSTEM_ALIASES: Record<string, (typeof SYSTEMS)[number]> = {
  septic: 'Septic',
  hvac: 'HVAC',
  heating: 'HVAC',
  heat: 'HVAC',
  furnace: 'HVAC',
  boiler: 'HVAC',
  ac: 'HVAC',
  'a/c': 'HVAC',
  cooling: 'HVAC',
  plumbing: 'Plumbing',
  plumber: 'Plumbing',
  'water heater': 'Plumbing',
  well: 'Plumbing',
  electrical: 'Electrical',
  electric: 'Electrical',
  electrician: 'Electrical',
  generator: 'Electrical',
  roof: 'Roof',
  roofing: 'Roof',
  chimney: 'Chimney',
  fireplace: 'Chimney',
  exterior: 'Exterior',
  gutters: 'Exterior',
  gutter: 'Exterior',
  siding: 'Exterior',
  windows: 'Exterior',
  painting: 'Exterior',
  landscaping: 'Landscaping',
  lawn: 'Landscaping',
  tree: 'Landscaping',
  trees: 'Landscaping',
  yard: 'Landscaping',
  appliances: 'Appliances',
  appliance: 'Appliances',
  other: 'Other',
};

export interface ParsedName {
  date: string | null;
  system: string | null;
  vendor: string | null;
  service: string | null;
  amount: number | null;
  error: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function systemOf(word: string): (typeof SYSTEMS)[number] | null {
  return SYSTEM_ALIASES[word.trim().toLowerCase()] ?? null;
}

function validDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** "2026.10.12 - Septic - ABC Septic - Pump-out - $525.pdf" → fields. Also
 * takes "Date - Vendor - Service" (no system → Other, flagged) and names
 * without an amount. Dashes may be -, – or —; dates . - or _. */
export function parseReceiptName(fileName: string): ParsedName {
  const out: ParsedName = { date: null, system: null, vendor: null, service: null, amount: null, error: null };
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  const parts = base
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const dm = parts[0]?.match(/^(\d{4})[.\-_](\d{1,2})[.\-_](\d{1,2})$/);
  if (!dm) {
    out.error = 'The name doesn’t start with a date like 2026.10.12';
    return out;
  }
  out.date = validDay(Number(dm[1]), Number(dm[2]), Number(dm[3]));
  if (!out.date) {
    out.error = `“${parts[0]}” isn’t a real date`;
    return out;
  }
  const rest = parts.slice(1);
  const last = rest[rest.length - 1];
  const am = last?.match(/^\$\s*([\d,]+(?:\.\d{1,2})?)$|^([\d,]+\.\d{2})$/);
  if (am) {
    out.amount = Number((am[1] ?? am[2]).replace(/,/g, ''));
    rest.pop();
  }
  if (!rest.length) {
    out.error = 'Only a date — add System - Vendor - Service';
    return out;
  }
  const sys = systemOf(rest[0]);
  if (sys) {
    out.system = sys;
    rest.shift();
  } else {
    out.system = 'Other';
    out.error = `“${rest[0]}” isn’t one of the systems (${SYSTEMS.join(', ')}) — filed under Other`;
  }
  if (rest.length >= 2) {
    out.vendor = rest[0];
    out.service = rest.slice(1).join(' - ');
  } else if (rest.length === 1) {
    out.service = rest[0];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates

export const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const fmtDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Rows

export interface RecordRow {
  id: string;
  source: 'drive' | 'manual';
  file_id: string | null;
  file_name: string | null;
  file_url: string | null;
  modified_at: string | null;
  service_date: string | null;
  system: string | null;
  vendor: string | null;
  service: string | null;
  amount: number | null;
  notes: string | null;
  parse_error: string | null;
  edited: number;
  missing: number;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  id: string;
  name: string;
  system: string;
  match_words: string | null;
  interval_months: number | null;
  lead_days: number;
  due_override: string | null;
  due_override_set: string | null;
  notes: string | null;
  active: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export type ItemStatus = 'overdue' | 'due_soon' | 'ok' | 'unknown' | 'history' | 'paused';

export interface ItemState {
  item: ItemRow;
  matches: RecordRow[]; // newest first
  last: RecordRow | null;
  nextDue: string | null;
  remindOn: string | null;
  status: ItemStatus;
  overrideActive: boolean;
}

export const matchWords = (item: Pick<ItemRow, 'match_words'>) =>
  (item.match_words ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

export function recordMatches(item: Pick<ItemRow, 'system' | 'match_words'>, r: RecordRow): boolean {
  if (!r.service_date || r.missing) return false;
  if ((r.system ?? '').toLowerCase() !== item.system.toLowerCase()) return false;
  const words = matchWords(item);
  if (!words.length) return true;
  const hay = `${r.service ?? ''} ${r.vendor ?? ''}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}

export function itemState(item: ItemRow, records: RecordRow[], today: string): ItemState {
  const matches = records.filter((r) => recordMatches(item, r)).sort((a, b) => (b.service_date ?? '').localeCompare(a.service_date ?? ''));
  const last = matches[0] ?? null;
  // A "next due" Mike typed stands until a receipt dated on/after the day he typed it.
  const overrideActive = !!item.due_override && !(last && item.due_override_set && (last.service_date ?? '') >= item.due_override_set);
  const nextDue = overrideActive ? item.due_override : last && item.interval_months ? addMonths(last.service_date!, item.interval_months) : null;
  const remindOn = nextDue ? addDays(nextDue, -Math.max(0, item.lead_days)) : null;
  let status: ItemStatus;
  if (!item.active) status = 'paused';
  else if (!item.interval_months && !overrideActive) status = 'history';
  else if (!nextDue) status = 'unknown';
  else if (nextDue < today) status = 'overdue';
  else if (remindOn! <= today) status = 'due_soon';
  else status = 'ok';
  return { item, matches, last, nextDue, remindOn, status, overrideActive };
}

async function loadRecords(env: Env): Promise<RecordRow[]> {
  return (await env.DB.prepare('SELECT * FROM home_maint_records ORDER BY service_date DESC, created_at DESC').all<RecordRow>()).results ?? [];
}
async function loadItems(env: Env): Promise<ItemRow[]> {
  return (await env.DB.prepare('SELECT * FROM home_maint_items ORDER BY position, name').all<ItemRow>()).results ?? [];
}

// ---------------------------------------------------------------------------
// Today tasks

export const TASK_ACTION = 'home-maint';

function taskTitle(s: ItemState): string {
  return `Schedule ${s.item.name}`;
}
function taskDescription(s: ItemState): string {
  const bits = [`${s.status === 'overdue' ? 'Was due' : 'Due'} ${fmtDay(s.nextDue!)}`];
  if (s.last) {
    const by = [s.last.vendor, s.last.amount != null ? usd(s.last.amount) : null].filter(Boolean).join(', ');
    bits.push(`last done ${fmtDay(s.last.service_date!)}${by ? ` (${by})` : ''}`);
  }
  if (s.item.interval_months) bits.push(`every ${intervalText(s.item.interval_months)}`);
  return `${bits.join(' · ')}. Once it's done, drop the receipt in the Drive folder "${HOME_MAINT_FOLDER_NAME}" and this checks itself off.`;
}
export function intervalText(months: number): string {
  if (months % 12 === 0) return months === 12 ? '1 year' : `${months / 12} years`;
  return months === 1 ? '1 month' : `${months} months`;
}

interface TaskLink {
  item_id: string;
  cycle_due: string;
  entity_id: string;
  created_at: string;
  status: string | null;
  title: string | null;
  content: string | null;
}

/** Keep one open "Schedule …" task per due item; check it off when a newer
 * receipt moves the due date out; drop it if the item is paused/deleted or
 * its schedule moved out without a receipt. A task Mike checked off or
 * deleted himself isn't made again for the same due date. Idempotent. */
export async function syncMaintTasks(env: Env, today = easternToday()): Promise<{ created: number; closed: number; removed: number }> {
  const db = env.DB;
  const [items, records] = await Promise.all([loadItems(env), loadRecords(env)]);
  const links =
    (
      await db
        .prepare(
          `SELECT t.item_id, t.cycle_due, t.entity_id, t.created_at, e.status, e.title, e.content
           FROM home_maint_tasks t LEFT JOIN entities e ON e.id = t.entity_id`,
        )
        .all<TaskLink>()
    ).results ?? [];
  const ts = now();
  let created = 0;
  let closed = 0;
  let removed = 0;
  const itemIds = new Set(items.map((i) => i.id));

  // Tasks for deleted items.
  for (const l of links.filter((l) => !itemIds.has(l.item_id))) {
    if (l.status === 'open') {
      await db.prepare('DELETE FROM entities WHERE id = ?').bind(l.entity_id).run();
      removed++;
    }
    await db.prepare('DELETE FROM home_maint_tasks WHERE item_id = ? AND cycle_due = ?').bind(l.item_id, l.cycle_due).run();
  }

  for (const item of items) {
    const s = itemState(item, records, today);
    const mine = links.filter((l) => l.item_id === item.id);
    const open = mine.filter((l) => l.status === 'open');
    const due = s.status === 'overdue' || s.status === 'due_soon';
    if (due) {
      const meta = JSON.stringify({ action: TASK_ACTION, itemId: item.id, description: taskDescription(s) });
      const title = taskTitle(s);
      const current = mine.find((l) => l.cycle_due === s.nextDue);
      if (current) {
        if (current.status === 'open' && (current.title !== title || current.content !== meta)) {
          await db.prepare('UPDATE entities SET title = ?, content = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(title, meta, title, ts, current.entity_id).run();
        }
        // Any other open one (an older cycle) is the same job — drop it.
        for (const l of open.filter((l) => l !== current)) {
          await db.batch([
            db.prepare('DELETE FROM entities WHERE id = ?').bind(l.entity_id),
            db.prepare('DELETE FROM home_maint_tasks WHERE item_id = ? AND cycle_due = ?').bind(l.item_id, l.cycle_due),
          ]);
          removed++;
        }
        continue;
      }
      if (open.length) {
        // The due date moved (schedule edited) while still due — keep the task, re-point it.
        const keep = open[0];
        await db.batch([
          db.prepare('UPDATE home_maint_tasks SET cycle_due = ? WHERE item_id = ? AND cycle_due = ?').bind(s.nextDue, keep.item_id, keep.cycle_due),
          db.prepare('UPDATE entities SET title = ?, content = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(title, meta, title, ts, keep.entity_id),
        ]);
        for (const l of open.slice(1)) {
          await db.batch([
            db.prepare('DELETE FROM entities WHERE id = ?').bind(l.entity_id),
            db.prepare('DELETE FROM home_maint_tasks WHERE item_id = ? AND cycle_due = ?').bind(l.item_id, l.cycle_due),
          ]);
          removed++;
        }
        continue;
      }
      const id = uid();
      const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>();
      await db.batch([
        db
          .prepare(
            `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
             VALUES (?, 'task', ?, ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, 'personal')`,
          )
          .bind(id, title, meta, pos?.n ?? 0, today, ts, ts, ts, title),
        db.prepare('INSERT INTO home_maint_tasks (item_id, cycle_due, entity_id, created_at) VALUES (?, ?, ?, ?)').bind(item.id, s.nextDue, id, ts),
      ]);
      created++;
      continue;
    }
    // Not due (or paused / no schedule): open tasks either got done (a receipt
    // newer than the task's window) or no longer apply.
    for (const l of open) {
      const windowStart = addDays(l.cycle_due, -Math.max(0, item.lead_days) - 30);
      const doneByReceipt = item.active && s.last && (s.last.service_date ?? '') >= windowStart;
      if (doneByReceipt) {
        await db.batch([
          db.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, l.entity_id),
          db.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(uid(), l.entity_id, l.title ?? taskTitle(s), ts, today),
        ]);
        closed++;
      } else {
        await db.batch([
          db.prepare('DELETE FROM entities WHERE id = ?').bind(l.entity_id),
          db.prepare('DELETE FROM home_maint_tasks WHERE item_id = ? AND cycle_due = ?').bind(l.item_id, l.cycle_due),
        ]);
        removed++;
      }
    }
  }
  return { created, closed, removed };
}

// ---------------------------------------------------------------------------
// Drive scan

interface SettingsRow {
  id: number;
  cloud_account_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  last_scan_at: string | null;
  last_error: string | null;
  updated_at: string | null;
}

async function loadSettings(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM home_maint_settings WHERE id = 1').first<SettingsRow>();
  if (row) return row;
  await env.DB.prepare('INSERT OR IGNORE INTO home_maint_settings (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM home_maint_settings WHERE id = 1').first<SettingsRow>())!;
}

async function findFolder(env: Env): Promise<{ accountId: string; folderId: string; folderName: string; folderUrl: string | null } | null> {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await cloudAccess(env, acct.id);
      const f = (await adapter.listFolder(token, null)).find((e) => e.type === 'folder' && e.name.trim().toLowerCase() === HOME_MAINT_FOLDER_NAME.toLowerCase());
      if (f) return { accountId: acct.id, folderId: f.id, folderName: f.name, folderUrl: f.webUrl };
    } catch (err) {
      console.error('Home Maintenance folder search failed', acct.label, err);
    }
  }
  return null;
}

export interface ScanEntry {
  id: string;
  name: string;
  modifiedAt: string | null;
  webUrl: string | null;
}

/** Store what's in the folder (pure DB work — the Drive listing is passed
 * in, so tests can drive it without Drive). */
export async function applyListing(env: Env, entries: ScanEntry[]): Promise<{ added: number; updated: number; missing: number }> {
  const db = env.DB;
  const known = new Map(((await db.prepare(`SELECT * FROM home_maint_records WHERE source = 'drive'`).all<RecordRow>()).results ?? []).map((r) => [r.file_id!, r]));
  const ts = now();
  let added = 0;
  let updated = 0;
  let missing = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    seen.add(e.id);
    const k = known.get(e.id);
    const p = parseReceiptName(e.name);
    if (!k) {
      await db
        .prepare(
          `INSERT INTO home_maint_records (id, source, file_id, file_name, file_url, modified_at, service_date, system, vendor, service, amount, parse_error, created_at, updated_at)
           VALUES (?, 'drive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uid(), e.id, e.name, e.webUrl, e.modifiedAt, p.date, p.system, p.vendor, p.service, p.amount, p.error, ts, ts)
        .run();
      added++;
      continue;
    }
    const nameChanged = k.file_name !== e.name;
    if (!nameChanged && !k.missing && k.file_url === e.webUrl) continue;
    if (k.edited && !nameChanged) {
      await db.prepare('UPDATE home_maint_records SET file_url = ?, modified_at = ?, missing = 0, updated_at = ? WHERE id = ?').bind(e.webUrl, e.modifiedAt, ts, k.id).run();
    } else {
      // A renamed file is re-read even if it was edited — the new name is Mike's latest word.
      await db
        .prepare(
          `UPDATE home_maint_records SET file_name = ?, file_url = ?, modified_at = ?, service_date = ?, system = ?, vendor = ?, service = ?, amount = ?,
             parse_error = ?, edited = 0, missing = 0, updated_at = ? WHERE id = ?`,
        )
        .bind(e.name, e.webUrl, e.modifiedAt, p.date, p.system, p.vendor, p.service, p.amount, p.error, ts, k.id)
        .run();
    }
    updated++;
  }
  for (const [fileId, k] of known) {
    if (!seen.has(fileId) && !k.missing) {
      await db.prepare('UPDATE home_maint_records SET missing = 1, updated_at = ? WHERE id = ?').bind(ts, k.id).run();
      missing++;
    }
  }
  return { added, updated, missing };
}

export interface MaintScanResult {
  folder: string | null;
  listed: number;
  added: number;
  updated: number;
  missing: number;
  error: string | null;
}

export async function scanMaint(env: Env): Promise<MaintScanResult> {
  let s = await loadSettings(env);
  const result: MaintScanResult = { folder: s.folder_name, listed: 0, added: 0, updated: 0, missing: 0, error: null };
  try {
    if (!s.folder_id || !s.cloud_account_id) {
      const found = await findFolder(env);
      if (!found) throw new Error(`No "${HOME_MAINT_FOLDER_NAME}" folder found at the top of a connected Google Drive.`);
      await env.DB.prepare('UPDATE home_maint_settings SET cloud_account_id = ?, folder_id = ?, folder_name = ?, folder_url = ?, updated_at = ? WHERE id = 1')
        .bind(found.accountId, found.folderId, found.folderName, found.folderUrl, now())
        .run();
      s = await loadSettings(env);
      result.folder = s.folder_name;
    }
    const { token, adapter } = await cloudAccess(env, s.cloud_account_id!);
    let listing;
    try {
      listing = await adapter.listFolder(token, s.folder_id!);
    } catch (err) {
      // Folder moved or deleted — forget it so the next scan looks again.
      await env.DB.prepare('UPDATE home_maint_settings SET folder_id = NULL, cloud_account_id = NULL WHERE id = 1').run();
      throw err;
    }
    const files = listing.filter((e) => e.type === 'file').map((e) => ({ id: e.id, name: e.name, modifiedAt: e.modifiedAt, webUrl: e.webUrl }));
    result.listed = files.length;
    Object.assign(result, await applyListing(env, files));
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  await env.DB.prepare('UPDATE home_maint_settings SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = 1').bind(now(), result.error, now()).run();
  await syncMaintTasks(env);
  return result;
}

/** Nightly at 07:xx UTC, or any :20 tick if the last scan is >20h old. */
export async function maintScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  const s = await loadSettings(env);
  return !s.last_scan_at || s.last_scan_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// API — /api/home/maintenance

export const homeMaintRouter = new Hono<{ Bindings: Env }>();

function itemJson(s: ItemState, links: Map<string, string>) {
  const i = s.item;
  return {
    id: i.id,
    name: i.name,
    system: i.system,
    matchWords: i.match_words ?? '',
    intervalMonths: i.interval_months,
    leadDays: i.lead_days,
    dueOverride: i.due_override,
    overrideActive: s.overrideActive,
    notes: i.notes,
    active: !!i.active,
    position: i.position,
    status: s.status,
    nextDue: s.nextDue,
    remindOn: s.remindOn,
    lastRecordId: s.last?.id ?? null,
    recordIds: s.matches.map((r) => r.id),
    taskId: links.get(i.id) ?? null,
  };
}

function recordJson(r: RecordRow) {
  return {
    id: r.id,
    source: r.source,
    fileName: r.file_name,
    fileUrl: r.file_url,
    date: r.service_date,
    system: r.system,
    vendor: r.vendor,
    service: r.service,
    amount: r.amount,
    notes: r.notes,
    parseError: r.parse_error,
    edited: !!r.edited,
    missing: !!r.missing,
  };
}

homeMaintRouter.get('/', async (c) => {
  const today = easternToday();
  await syncMaintTasks(c.env, today);
  const [items, records, settings] = await Promise.all([loadItems(c.env), loadRecords(c.env), loadSettings(c.env)]);
  const { results: open } = await c.env.DB.prepare(`SELECT t.item_id, t.entity_id FROM home_maint_tasks t JOIN entities e ON e.id = t.entity_id WHERE e.status = 'open'`).all<{
    item_id: string;
    entity_id: string;
  }>();
  const links = new Map((open ?? []).map((r) => [r.item_id, r.entity_id]));
  return c.json({
    today,
    systems: SYSTEMS,
    folder: { name: settings.folder_name, url: settings.folder_url, lastScanAt: settings.last_scan_at, lastError: settings.last_error, expectedName: HOME_MAINT_FOLDER_NAME },
    items: items.map((i) => itemJson(itemState(i, records, today), links)),
    records: records.map(recordJson),
  });
});

homeMaintRouter.post('/scan', async (c) => c.json(await scanMaint(c.env)));

// --- items

interface ItemBody {
  name?: string;
  system?: string;
  matchWords?: string | null;
  intervalMonths?: number | null;
  leadDays?: number;
  dueOverride?: string | null;
  notes?: string | null;
  active?: boolean;
  position?: number;
}

function cleanItem(b: ItemBody, partial: boolean): { ok: true; v: Partial<Record<keyof ItemRow, unknown>> } | { ok: false; error: string } {
  const v: Partial<Record<keyof ItemRow, unknown>> = {};
  if (b.name !== undefined || !partial) {
    const name = (b.name ?? '').trim().slice(0, 120);
    if (!name) return { ok: false, error: 'Give it a name' };
    v.name = name;
  }
  if (b.system !== undefined || !partial) {
    const sys = SYSTEMS.find((s) => s.toLowerCase() === (b.system ?? '').trim().toLowerCase());
    if (!sys) return { ok: false, error: `System must be one of ${SYSTEMS.join(', ')}` };
    v.system = sys;
  }
  if (b.matchWords !== undefined) v.match_words = (b.matchWords ?? '').trim().slice(0, 200) || null;
  if (b.intervalMonths !== undefined) {
    if (b.intervalMonths === null) v.interval_months = null;
    else if (!Number.isInteger(b.intervalMonths) || b.intervalMonths < 1 || b.intervalMonths > 240) return { ok: false, error: 'Every … months must be 1–240' };
    else v.interval_months = b.intervalMonths;
  }
  if (b.leadDays !== undefined) {
    if (!Number.isInteger(b.leadDays) || b.leadDays < 0 || b.leadDays > 365) return { ok: false, error: 'Remind me … days before must be 0–365' };
    v.lead_days = b.leadDays;
  }
  if (b.dueOverride !== undefined) {
    if (b.dueOverride !== null && !ISO_DAY.test(b.dueOverride)) return { ok: false, error: 'Next due must be a date' };
    v.due_override = b.dueOverride;
    v.due_override_set = b.dueOverride ? easternToday() : null;
  }
  if (b.notes !== undefined) v.notes = (b.notes ?? '').trim().slice(0, 2000) || null;
  if (b.active !== undefined) v.active = b.active ? 1 : 0;
  if (b.position !== undefined && Number.isInteger(b.position)) v.position = b.position;
  return { ok: true, v };
}

homeMaintRouter.post('/items', async (c) => {
  const b = await c.req.json<ItemBody>().catch(() => ({}) as ItemBody);
  const r = cleanItem(b, false);
  if (!r.ok) return c.json({ error: r.error }, 400);
  const id = uid();
  const ts = now();
  const pos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM home_maint_items').first<{ n: number }>();
  const v = { interval_months: null, lead_days: 30, match_words: null, due_override: null, due_override_set: null, notes: null, active: 1, position: pos?.n ?? 0, ...r.v };
  await c.env.DB.prepare(
    `INSERT INTO home_maint_items (id, name, system, match_words, interval_months, lead_days, due_override, due_override_set, notes, active, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, v.name, v.system, v.match_words, v.interval_months, v.lead_days, v.due_override, v.due_override_set, v.notes, v.active, v.position, ts, ts)
    .run();
  await syncMaintTasks(c.env);
  return c.json({ id }, 201);
});

homeMaintRouter.patch('/items/:id', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM home_maint_items WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<ItemBody>().catch(() => ({}) as ItemBody);
  const r = cleanItem(b, true);
  if (!r.ok) return c.json({ error: r.error }, 400);
  const keys = Object.keys(r.v) as (keyof ItemRow)[];
  if (keys.length) {
    await c.env.DB.prepare(`UPDATE home_maint_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => r.v[k] as string | number | null), now(), id)
      .run();
  }
  await syncMaintTasks(c.env);
  return c.json({ ok: true });
});

homeMaintRouter.delete('/items/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM home_maint_items WHERE id = ?').bind(c.req.param('id')).run();
  if (!res.meta.changes) return c.json({ error: 'Not found' }, 404);
  await syncMaintTasks(c.env);
  return c.json({ ok: true });
});

// --- records

interface RecordBody {
  date?: string | null;
  system?: string | null;
  vendor?: string | null;
  service?: string | null;
  amount?: number | null;
  notes?: string | null;
  reset?: boolean;
}

function cleanRecord(b: RecordBody): { ok: true; v: Partial<Record<keyof RecordRow, unknown>> } | { ok: false; error: string } {
  const v: Partial<Record<keyof RecordRow, unknown>> = {};
  if (b.date !== undefined) {
    if (!b.date || !ISO_DAY.test(b.date)) return { ok: false, error: 'Date is required' };
    v.service_date = b.date;
  }
  if (b.system !== undefined) {
    const sys = SYSTEMS.find((s) => s.toLowerCase() === (b.system ?? '').trim().toLowerCase());
    if (!sys) return { ok: false, error: `System must be one of ${SYSTEMS.join(', ')}` };
    v.system = sys;
  }
  if (b.vendor !== undefined) v.vendor = (b.vendor ?? '').trim().slice(0, 120) || null;
  if (b.service !== undefined) v.service = (b.service ?? '').trim().slice(0, 200) || null;
  if (b.amount !== undefined) {
    if (b.amount !== null && (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount < 0)) return { ok: false, error: 'Amount must be a number' };
    v.amount = b.amount === null ? null : Math.round(b.amount * 100) / 100;
  }
  if (b.notes !== undefined) v.notes = (b.notes ?? '').trim().slice(0, 2000) || null;
  return { ok: true, v };
}

homeMaintRouter.post('/records', async (c) => {
  const b = await c.req.json<RecordBody>().catch(() => ({}) as RecordBody);
  if (b.date === undefined) return c.json({ error: 'Date is required' }, 400);
  if (b.system === undefined) return c.json({ error: 'System is required' }, 400);
  const r = cleanRecord(b);
  if (!r.ok) return c.json({ error: r.error }, 400);
  const id = uid();
  const ts = now();
  const v = r.v;
  await c.env.DB.prepare(
    `INSERT INTO home_maint_records (id, source, service_date, system, vendor, service, amount, notes, edited, created_at, updated_at)
     VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, v.service_date, v.system, v.vendor ?? null, v.service ?? null, v.amount ?? null, v.notes ?? null, ts, ts)
    .run();
  await syncMaintTasks(c.env);
  return c.json({ id }, 201);
});

homeMaintRouter.patch('/records/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM home_maint_records WHERE id = ?').bind(c.req.param('id')).first<RecordRow>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<RecordBody>().catch(() => ({}) as RecordBody);
  const ts = now();
  if (b.reset) {
    // Back to what the file name says (Drive receipts only).
    if (row.source !== 'drive' || !row.file_name) return c.json({ error: 'Only receipts from Drive can be reset to their file name' }, 400);
    const p = parseReceiptName(row.file_name);
    await c.env.DB.prepare('UPDATE home_maint_records SET service_date = ?, system = ?, vendor = ?, service = ?, amount = ?, parse_error = ?, edited = 0, updated_at = ? WHERE id = ?')
      .bind(p.date, p.system, p.vendor, p.service, p.amount, p.error, ts, row.id)
      .run();
  } else {
    const r = cleanRecord(b);
    if (!r.ok) return c.json({ error: r.error }, 400);
    const keys = Object.keys(r.v) as (keyof RecordRow)[];
    if (keys.length) {
      // Once the fields are Mike's, the name's complaint no longer applies.
      await c.env.DB.prepare(`UPDATE home_maint_records SET ${keys.map((k) => `${k} = ?`).join(', ')}, edited = 1, parse_error = NULL, updated_at = ? WHERE id = ?`)
        .bind(...keys.map((k) => r.v[k] as string | number | null), ts, row.id)
        .run();
    }
  }
  await syncMaintTasks(c.env);
  return c.json({ ok: true });
});

homeMaintRouter.delete('/records/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT source, missing FROM home_maint_records WHERE id = ?').bind(c.req.param('id')).first<{ source: string; missing: number }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.source === 'drive' && !row.missing) return c.json({ error: 'This receipt is still in the Drive folder — delete or move the file there' }, 400);
  await c.env.DB.prepare('DELETE FROM home_maint_records WHERE id = ?').bind(c.req.param('id')).run();
  await syncMaintTasks(c.env);
  return c.json({ ok: true });
});
