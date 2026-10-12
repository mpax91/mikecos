import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { blank, csvRecords, int, num } from './csv';
import { linkBeeContacts } from './contacts';
import { syncBeeExportTask } from './reminder';
import { syncBeeTaxPackets } from './tax';
import { deriveMerch, ingestFourthwallCsv, isFourthwallCsv } from './merch';

/** Bedford Bee importer (2026-10-10). Mike drops Substack's posts export,
 * Substack's subscriber export and Stripe's balance history into a Drive
 * folder named "Bedford Bee" (all-time each time, monthly). Files are told
 * apart by their header row, so any file name works; the export date comes
 * from the name ("2026.10.10 - …", "…_2026-10-11…") or else Drive's
 * modified date. Idempotent — re-reads a file only when it changes. */

export type BeeFileKind = 'posts' | 'subscribers' | 'stripe' | 'fourthwall' | 'other';

export interface BeeSettingsRow {
  id: number;
  cloud_account_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  last_scan_at: string | null;
  last_error: string | null;
  updated_at: string | null;
}

export interface BeeScanResult {
  folder: string | null;
  listed: number;
  read: number;
  errors: string[];
}

const now = () => new Date().toISOString();
export const BEE_FOLDER_NAME = 'Bedford Bee';
const easternDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function classifyHeaders(headers: string[]): BeeFileKind {
  const h = new Set(headers.map((x) => x.toLowerCase()));
  if (h.has('post_date') && h.has('open_rate')) return 'posts';
  if (h.has('email') && h.has('type') && h.has('start date')) return 'subscribers';
  if (h.has('id') && h.has('type') && h.has('net') && h.has('created (utc)')) return 'stripe';
  if (isFourthwallCsv(headers)) return 'fourthwall';
  return 'other';
}

/** "2026.10.10 - Bedford Bee - Posts.csv", "subscriber-export-2026-10-11-00-16-05.csv" → 2026-10-10 / 2026-10-11. */
export function exportDateFromName(name: string): string | null {
  const m = name.match(/(20\d\d)[.\-_](\d\d)[.\-_](\d\d)/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${y}-${mo}-${d}` : null;
}

export async function loadBeeSettings(env: Env): Promise<BeeSettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM bee_settings WHERE id = 1').first<BeeSettingsRow>();
  if (row) return row;
  await env.DB.prepare('INSERT OR IGNORE INTO bee_settings (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM bee_settings WHERE id = 1').first<BeeSettingsRow>())!;
}

/** Top-level "Bedford Bee" folders across connected Google Drive accounts. */
export async function findBeeFolders(env: Env): Promise<{ accountId: string; accountLabel: string; folderId: string; folderName: string; folderUrl: string | null }[]> {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  const out = [];
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await cloudAccess(env, acct.id);
      for (const f of await adapter.listFolder(token, null)) {
        if (f.type === 'folder' && f.name.trim().toLowerCase() === BEE_FOLDER_NAME.toLowerCase()) {
          out.push({ accountId: acct.id, accountLabel: acct.label, folderId: f.id, folderName: f.name, folderUrl: f.webUrl });
        }
      }
    } catch (err) {
      console.error('Bee folder search failed', acct.label, err);
    }
  }
  return out;
}

export async function scanBee(env: Env): Promise<BeeScanResult> {
  let settings = await loadBeeSettings(env);
  const result: BeeScanResult = { folder: settings.folder_name, listed: 0, read: 0, errors: [] };
  try {
    if (!settings.folder_id || !settings.cloud_account_id) {
      const found = (await findBeeFolders(env))[0];
      if (!found) throw new Error(`No "${BEE_FOLDER_NAME}" folder found at the top of a connected Google Drive.`);
      await env.DB.prepare('UPDATE bee_settings SET cloud_account_id = ?, folder_id = ?, folder_name = ?, folder_url = ?, updated_at = ? WHERE id = 1')
        .bind(found.accountId, found.folderId, found.folderName, found.folderUrl, now())
        .run();
      settings = await loadBeeSettings(env);
      result.folder = settings.folder_name;
    }
    const { token, adapter } = await cloudAccess(env, settings.cloud_account_id!);
    const entries = (await adapter.listFolder(token, settings.folder_id!)).filter((e) => e.type === 'file' && /\.csv$/i.test(e.name));
    result.listed = entries.length;
    const known = new Map(
      ((await env.DB.prepare('SELECT file_id, modified_at, status FROM bee_files').all<{ file_id: string; modified_at: string | null; status: string }>()).results ?? []).map((r) => [r.file_id, r])
    );
    const todo = entries.filter((e) => {
      const k = known.get(e.id);
      return !k || k.status === 'failed' || (e.modifiedAt && k.modified_at !== e.modifiedAt);
    });
    // Oldest export first, so the newest posts file is the one that sticks.
    const dated = todo
      .map((e) => ({ e, date: exportDateFromName(e.name) ?? (e.modifiedAt ? easternDate(e.modifiedAt) : null) }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.e.name.localeCompare(b.e.name));
    for (const { e, date } of dated) {
      result.read++;
      let kind: BeeFileKind = 'other';
      let status: 'parsed' | 'skipped' | 'failed' = 'failed';
      let error: string | null = null;
      let rows: number | null = null;
      try {
        const res = await adapter.downloadFile(token, e.id);
        const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
        const out = await ingestBeeCsv(env, { fileId: e.id, exportDate: date, text });
        kind = out.kind;
        rows = out.rows;
        status = kind === 'other' ? 'skipped' : 'parsed';
        if (kind === 'other') error = 'Not a Substack posts, subscriber, Stripe or Fourthwall orders export';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        result.errors.push(`${e.name}: ${error}`);
      }
      await env.DB.prepare(
        `INSERT INTO bee_files (file_id, file_name, kind, export_date, modified_at, web_url, status, error, row_count, parsed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET file_name = excluded.file_name, kind = excluded.kind, export_date = excluded.export_date,
           modified_at = excluded.modified_at, web_url = excluded.web_url, status = excluded.status, error = excluded.error,
           row_count = excluded.row_count, parsed_at = excluded.parsed_at`
      )
        .bind(e.id, e.name, kind, date, e.modifiedAt, e.webUrl, status, error, rows, now())
        .run();
    }
    // Renames don't change modifiedAt on every provider — keep names current.
    for (const e of entries) {
      const k = known.get(e.id);
      if (k) await env.DB.prepare('UPDATE bee_files SET file_name = ?, web_url = ? WHERE file_id = ?').bind(e.name, e.webUrl, e.id).run();
    }
    // A subscriber file deleted from Drive takes its snapshot with it.
    const present = new Set(entries.map((e) => e.id));
    for (const [fileId] of known) {
      if (present.has(fileId)) continue;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM bee_subscriber_snapshots WHERE file_id = ?').bind(fileId),
        env.DB.prepare('DELETE FROM bee_files WHERE file_id = ?').bind(fileId),
      ]);
    }
    await deriveBee(env);
    await env.DB.prepare('UPDATE bee_settings SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = 1')
      .bind(now(), result.errors.length ? result.errors.join(' · ').slice(0, 1000) : null, now())
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE bee_settings SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = 1').bind(now(), message, now()).run();
    throw err;
  }
  return result;
}

/** Everything that follows from the stored rows. */
export async function deriveBee(env: Env): Promise<void> {
  await rebuildSubscribers(env);
  await linkBeeContacts(env);
  await syncBeeExportTask(env);
  await syncBeeTaxPackets(env);
  await deriveMerch(env);
}

/** Reads one export (any of the three kinds) into the tables. */
export async function ingestBeeCsv(env: Env, f: { fileId: string; exportDate: string | null; text: string }): Promise<{ kind: BeeFileKind; rows: number }> {
  const { headers, records } = csvRecords(f.text);
  const kind = classifyHeaders(headers);
  if (kind === 'posts') await ingestPosts(env, f, records);
  else if (kind === 'subscribers') await ingestSubscribers(env, f, records);
  else if (kind === 'stripe') await ingestStripe(env, f, records);
  else if (kind === 'fourthwall') await ingestFourthwallCsv(env, records);
  return { kind, rows: records.length };
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

async function ingestPosts(env: Env, f: { fileId: string; exportDate: string | null }, records: Record<string, string>[]) {
  // An older export never overwrites numbers from a newer one.
  const newest = await env.DB.prepare(`SELECT MAX(export_date) AS d FROM bee_files WHERE kind = 'posts' AND status = 'parsed' AND file_id != ?`).bind(f.fileId).first<{ d: string | null }>();
  if (newest?.d && f.exportDate && f.exportDate < newest.d) return;
  const ts = now();
  const stmts = records
    .filter((r) => r.post_date && r.title)
    .map((r) =>
      env.DB.prepare(
        `INSERT INTO bee_posts (post_date, title, audience, sent, delivered, dropped, opens, opened, open_rate, opens_day7, opens_day28, clicks, clicked,
           views, likes, comments, shares, restacks, signups, subscribes, upgrades, unsubscribes, complaints, raw_json, file_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_date) DO UPDATE SET title = excluded.title, audience = excluded.audience, sent = excluded.sent, delivered = excluded.delivered,
           dropped = excluded.dropped, opens = excluded.opens, opened = excluded.opened, open_rate = excluded.open_rate, opens_day7 = excluded.opens_day7,
           opens_day28 = excluded.opens_day28, clicks = excluded.clicks, clicked = excluded.clicked, views = excluded.views, likes = excluded.likes,
           comments = excluded.comments, shares = excluded.shares, restacks = excluded.restacks, signups = excluded.signups, subscribes = excluded.subscribes,
           upgrades = excluded.upgrades, unsubscribes = excluded.unsubscribes, complaints = excluded.complaints, raw_json = excluded.raw_json,
           file_id = excluded.file_id, updated_at = excluded.updated_at`
      ).bind(
        r.post_date,
        r.title,
        blank(r.audience),
        int(r.sent),
        int(r.delivered),
        int(r.dropped),
        int(r.opens),
        int(r.opened),
        num(r.open_rate),
        int(r.unique_opens_day7),
        int(r.unique_opens_day28),
        int(r.clicks),
        int(r.clicked),
        int(r.views),
        int(r.likes),
        int(r.comments),
        int(r.shares),
        int(r.restacks),
        int(r.signups),
        int(r.subscribes),
        int(r.free_to_paid_upgrades),
        int(r.unsubscribes),
        int(r.complaints),
        JSON.stringify(r),
        f.fileId,
        ts
      )
    );
  await runBatches(env, stmts);
}

async function ingestSubscribers(env: Env, f: { fileId: string; exportDate: string | null }, records: Record<string, string>[]) {
  const date = f.exportDate ?? easternDate(now());
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM bee_subscriber_snapshots WHERE file_id = ?').bind(f.fileId),
    env.DB.prepare('DELETE FROM bee_subscriber_snapshots WHERE export_date = ?').bind(date),
  ];
  for (const r of records) {
    const email = (r.Email ?? '').trim().toLowerCase();
    if (!email.includes('@')) continue;
    stmts.push(
      env.DB.prepare('INSERT OR REPLACE INTO bee_subscriber_snapshots (export_date, email, type, row_json, file_id) VALUES (?, ?, ?, ?, ?)').bind(
        date,
        email,
        blank(r.Type),
        JSON.stringify(r),
        f.fileId
      )
    );
  }
  await runBatches(env, stmts);
}

async function ingestStripe(env: Env, f: { fileId: string }, records: Record<string, string>[]) {
  const stmts = records
    .filter((r) => r.id && r.Type)
    .map((r) =>
      env.DB.prepare(
        `INSERT INTO bee_stripe_txns (id, type, source, amount, fee, net, currency, created, available_on, description, transfer, transfer_date, file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, source = excluded.source, amount = excluded.amount, fee = excluded.fee, net = excluded.net,
           currency = excluded.currency, created = excluded.created, available_on = excluded.available_on, description = excluded.description,
           transfer = excluded.transfer, transfer_date = excluded.transfer_date, file_id = excluded.file_id`
      ).bind(
        r.id,
        r.Type,
        blank(r.Source),
        num(r.Amount) ?? 0,
        num(r.Fee) ?? 0,
        num(r.Net) ?? 0,
        blank(r.Currency),
        r['Created (UTC)'],
        blank(r['Available On (UTC)']),
        blank(r.Description),
        blank(r.Transfer),
        blank(r['Transfer Date (UTC)']),
        f.fileId
      )
    );
  await runBatches(env, stmts);
}

/** bee_subscribers from every snapshot: details from the newest export a
 * person appears in; active = in the newest export; anyone who dropped out
 * left on the first export without them. contact_id is kept. */
export async function rebuildSubscribers(env: Env): Promise<void> {
  const { results } = await env.DB.prepare('SELECT export_date, email, type, row_json FROM bee_subscriber_snapshots ORDER BY export_date').all<{
    export_date: string;
    email: string;
    type: string | null;
    row_json: string;
  }>();
  const snaps = results ?? [];
  const dates = [...new Set(snaps.map((s) => s.export_date))].sort();
  if (!dates.length) {
    await env.DB.prepare('DELETE FROM bee_subscribers').run();
    return;
  }
  const latest = dates[dates.length - 1];
  const people = new Map<string, { first: string; last: string; row: Record<string, string> }>();
  for (const s of snaps) {
    const p = people.get(s.email);
    const row = JSON.parse(s.row_json) as Record<string, string>;
    if (!p) people.set(s.email, { first: s.export_date, last: s.export_date, row });
    else {
      p.last = s.export_date;
      p.row = row;
    }
  }
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [email, p] of people) {
    const r = p.row;
    const active = p.last === latest ? 1 : 0;
    const leftDate = active ? null : dates.find((d) => d > p.last) ?? null;
    const stats = subscriberStats(r);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO bee_subscribers (email, name, type, start_date, first_paid_date, cancel_date, expiration_date, stripe_plan, revenue, source_free, source_paid,
           state, country, stats_json, active, first_seen_export, last_seen_export, left_date, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, type = excluded.type, start_date = excluded.start_date, first_paid_date = excluded.first_paid_date,
           cancel_date = excluded.cancel_date, expiration_date = excluded.expiration_date, stripe_plan = excluded.stripe_plan, revenue = excluded.revenue,
           source_free = excluded.source_free, source_paid = excluded.source_paid, state = excluded.state, country = excluded.country,
           stats_json = excluded.stats_json, active = excluded.active, first_seen_export = excluded.first_seen_export,
           last_seen_export = excluded.last_seen_export, left_date = excluded.left_date, updated_at = excluded.updated_at`
      ).bind(
        email,
        blank(r.Name),
        blank(r.Type),
        blank(r['Start date']),
        blank(r['First paid date']),
        blank(r['Cancel date']),
        blank(r['Expiration date']),
        blank(r['Stripe plan']),
        num(r.Revenue),
        blank(r['Subscription source (free)']),
        blank(r['Subscription source (paid)']),
        blank(r['State/Province']),
        blank(r.Country),
        JSON.stringify(stats),
        active,
        p.first,
        p.last,
        leftDate,
        ts
      )
    );
  }
  // People only in deleted snapshots disappear entirely.
  const keep = [...people.keys()];
  const { results: existing } = await env.DB.prepare('SELECT email FROM bee_subscribers').all<{ email: string }>();
  const keepSet = new Set(keep);
  for (const e of existing ?? []) if (!keepSet.has(e.email)) stmts.push(env.DB.prepare('DELETE FROM bee_subscribers WHERE email = ?').bind(e.email));
  await runBatches(env, stmts);
}

export interface SubscriberStats {
  activity: number | null;
  received6mo: number | null;
  dropped6mo: number | null;
  opened6mo: number | null; // total opens (a forward re-opens the pixel)
  seen6mo: number | null; // unique emails opened
  opened30d: number | null;
  opened7d: number | null;
  lastOpen: string | null;
  clicks: number | null;
  lastClick: string | null;
  shares: number | null;
  comments: number | null;
  postViews: number | null;
  postViews30d: number | null;
  uniquePostsSeen: number | null;
  daysActive30d: number | null;
}

export function subscriberStats(r: Record<string, string>): SubscriberStats {
  return {
    activity: int(r.Activity),
    received6mo: int(r['Emails received (6mo)']),
    dropped6mo: int(r['Emails dropped (6mo)']),
    opened6mo: int(r['Emails opened (6mo)']),
    seen6mo: int(r['Unique emails seen (6mo)']),
    opened30d: int(r['Emails opened (30d)']),
    opened7d: int(r['Emails opened (7d)']),
    lastOpen: blank(r['Last email open']),
    clicks: int(r['Links clicked']),
    lastClick: blank(r['Last clicked at']),
    shares: int(r.Shares),
    comments: int(r.Comments),
    postViews: int(r['Post views']),
    postViews30d: int(r['Post views (30d)']),
    uniquePostsSeen: int(r['Unique posts seen']),
    daysActive30d: int(r['Days active (30d)']),
  };
}

/** Nightly with the statements scan (07:xx UTC), or any later :20 slot if
 * the last Bee scan is over 20h old (self-healing retry). */
export async function beeScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  const s = await loadBeeSettings(env);
  return !s.last_scan_at || s.last_scan_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}
