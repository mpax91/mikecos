import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { BackupScanner } from './scanner';
import type { BackupEvent, CallEvent, MmsEvent, SmsEvent } from './scanner';

/** Calls & Texts importer (2026-10-11). SMS Backup & Restore writes a full
 * backup of Mike's phone every night into the Drive folder "SMS":
 * calls-YYYYMMDDhhmmss.xml (~600 KB, the phone's last ~2,000 calls) and
 * sms-YYYYMMDDhhmmss.xml (~2.2 GB: a plain-text block, oldest → newest,
 * then a chat/picture block, oldest → newest, attachments inline).
 *
 * Each run: the newest calls file is read whole; the plain-text block is
 * streamed from byte 0 until the first <mms; the chat block is found by a
 * binary search on dates (Range reads) and streamed from the watermark,
 * at most CHAT_BUDGET_BYTES per run — so the first backfill takes a few
 * hourly runs and every night after that reads only the newest stretch.
 * Watermarks (newest date counted per stream) make re-reads idempotent.
 *
 * Stored: rollups per hashed number per month, last call/text, group-chat
 * membership. No message text, no per-call rows, no plain phone numbers. */

export const COMMS_FOLDER_NAME = 'SMS';
const CHAT_BUDGET_BYTES = 400 * 1024 * 1024;
const now = () => new Date().toISOString();

export interface CommSettingsRow {
  id: number;
  cloud_account_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  calls_file_id: string | null;
  calls_wm: number | null;
  sms_file_id: string | null;
  sms_wm: number | null;
  mms_file_id: string | null;
  mms_wm: number | null;
  mms_done: number;
  sms_file_size: number | null;
  first_at: number | null;
  last_scan_at: string | null;
  last_error: string | null;
  stats_json: string | null;
}

export interface BackupFile {
  id: string;
  name: string;
  size: number | null;
  modifiedAt: string | null;
}

/** Where the backup files come from — Google Drive in production, local
 * files in tests. `read` returns the bytes from `start` (to `end`
 * exclusive, or EOF) as a stream. */
export interface BackupSource {
  list(): Promise<BackupFile[]>;
  read(file: BackupFile, start: number, end?: number): Promise<ReadableStream<Uint8Array>>;
}

export interface CommsRunResult {
  folder: string | null;
  calls: { file: string | null; added: number };
  texts: { file: string | null; added: number };
  chats: { file: string | null; added: number; bytes: number; done: boolean; through: number | null; offset?: number };
  errors: string[];
}

// ---- numbers ----

/** Last 10 digits of a US-style number; null for short codes, emails and
 * RCS group addresses. */
export function normalizeNumber(raw: string | null | undefined): string | null {
  if (!raw || /[@~,;]/.test(raw)) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.slice(-10);
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.CLOUD_ACCOUNT_ENC_KEY;
  if (!secret) throw new Error('CLOUD_ACCOUNT_ENC_KEY is not set — needed to hash phone numbers.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(`mikeos-comms:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function makeHasher(env: Env): Promise<(value: string) => Promise<string>> {
  const key = await hmacKey(env);
  const cache = new Map<string, string>();
  return async (value: string) => {
    const hit = cache.get(value);
    if (hit) return hit;
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
    const hex = [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    cache.set(value, hex);
    return hex;
  };
}

const easternMonth = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);

// ---- aggregation ----

type Kind = 'call_in' | 'call_out' | 'call_missed' | 'text_in' | 'text_out' | 'group_in';

class Rollup {
  monthly = new Map<string, { hash: string; month: string; kind: Kind; n: number; seconds: number }>();
  last = new Map<string, { call?: [number, string]; text?: [number, string]; group?: number }>();
  groups = new Map<string, { members: Set<string>; messages: number; last: number }>();
  memberLast = new Map<string, number>(); // group|num → last
  added = 0;
  firstAt: number | null = null;

  add(hash: string, date: number, kind: Kind, seconds = 0) {
    const month = easternMonth(date);
    const key = `${hash}|${month}|${kind}`;
    const row = this.monthly.get(key) ?? { hash, month, kind, n: 0, seconds: 0 };
    row.n++;
    row.seconds += seconds;
    this.monthly.set(key, row);
    const l = this.last.get(hash) ?? {};
    if (kind.startsWith('call')) {
      if (!l.call || date > l.call[0]) l.call = [date, kind];
    } else if (kind === 'group_in') {
      if (!l.group || date > l.group) l.group = date;
    } else if (!l.text || date > l.text[0]) l.text = [date, kind];
    this.last.set(hash, l);
    this.added++;
    if (this.firstAt === null || date < this.firstAt) this.firstAt = date;
  }

  group(groupHash: string, members: string[], date: number, sender: string | null) {
    const g = this.groups.get(groupHash) ?? { members: new Set<string>(), messages: 0, last: 0 };
    for (const m of members) g.members.add(m);
    g.messages++;
    g.last = Math.max(g.last, date);
    this.groups.set(groupHash, g);
    for (const m of members) {
      const k = `${groupHash}|${m}`;
      this.memberLast.set(k, Math.max(this.memberLast.get(k) ?? 0, date));
    }
    if (sender) this.add(sender, date, 'group_in');
    else this.added++;
  }

  async flush(env: Env) {
    const stmts: D1PreparedStatement[] = [];
    for (const r of this.monthly.values()) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO comm_monthly (num_hash, month, kind, n, seconds) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(num_hash, month, kind) DO UPDATE SET n = n + excluded.n, seconds = seconds + excluded.seconds`
        ).bind(r.hash, r.month, r.kind, r.n, r.seconds)
      );
    }
    for (const [hash, l] of this.last) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO comm_last (num_hash, last_call_at, last_call_kind, last_text_at, last_text_kind, last_group_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(num_hash) DO UPDATE SET
             last_call_kind = CASE WHEN excluded.last_call_at > COALESCE(last_call_at, 0) THEN excluded.last_call_kind ELSE last_call_kind END,
             last_call_at = MAX(COALESCE(last_call_at, 0), COALESCE(excluded.last_call_at, 0)),
             last_text_kind = CASE WHEN excluded.last_text_at > COALESCE(last_text_at, 0) THEN excluded.last_text_kind ELSE last_text_kind END,
             last_text_at = MAX(COALESCE(last_text_at, 0), COALESCE(excluded.last_text_at, 0)),
             last_group_at = MAX(COALESCE(last_group_at, 0), COALESCE(excluded.last_group_at, 0))`
        ).bind(hash, l.call?.[0] ?? null, l.call?.[1] ?? null, l.text?.[0] ?? null, l.text?.[1] ?? null, l.group ?? null)
      );
    }
    for (const [gh, g] of this.groups) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO comm_groups (group_hash, members, messages, last_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(group_hash) DO UPDATE SET members = MAX(members, excluded.members), messages = messages + excluded.messages, last_at = MAX(COALESCE(last_at, 0), excluded.last_at)`
        ).bind(gh, g.members.size, g.messages, g.last)
      );
    }
    for (const [k, last] of this.memberLast) {
      const [gh, num] = k.split('|');
      stmts.push(
        env.DB.prepare(
          `INSERT INTO comm_group_members (group_hash, num_hash, last_at) VALUES (?, ?, ?)
           ON CONFLICT(group_hash, num_hash) DO UPDATE SET last_at = MAX(COALESCE(last_at, 0), excluded.last_at)`
        ).bind(gh, num, last)
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    this.monthly.clear();
    this.last.clear();
    this.groups.clear();
    this.memberLast.clear();
  }
}

const CALL_KIND: Record<number, Kind | undefined> = { 1: 'call_in', 2: 'call_out', 3: 'call_missed', 4: 'call_missed', 5: 'call_missed', 7: 'call_in' };

async function addCall(r: Rollup, hash: (v: string) => Promise<string>, e: CallEvent) {
  const kind = CALL_KIND[e.type];
  const num = normalizeNumber(e.number);
  if (!kind || !num) return;
  r.add(await hash(num), e.date, kind, kind === 'call_missed' ? 0 : e.duration);
}

async function addSms(r: Rollup, hash: (v: string) => Promise<string>, e: SmsEvent) {
  const num = normalizeNumber(e.address);
  if (!num || (e.type !== 1 && e.type !== 2)) return;
  r.add(await hash(num), e.date, e.type === 1 ? 'text_in' : 'text_out');
}

async function addMms(r: Rollup, hash: (v: string) => Promise<string>, e: MmsEvent) {
  if (e.box !== 1 && e.box !== 2) return;
  const self = normalizeNumber(e.self);
  const parts = e.addrs.map((a) => ({ num: normalizeNumber(a.address), type: a.type })).filter((a) => a.num && a.num !== self);
  const others = [...new Set(parts.map((p) => p.num!))];
  const isGroup = others.length >= 2 || /[~@]/.test(e.address);
  if (!isGroup) {
    const num = others[0] ?? normalizeNumber(e.address);
    if (!num || num === self) return;
    r.add(await hash(num), e.date, e.box === 1 ? 'text_in' : 'text_out');
    return;
  }
  // Group chat: credit the sender (incoming); remember who's in it.
  const groupKey = /[~@]/.test(e.address) && !/^[\d+~ ]+$/.test(e.address) ? `addr:${e.address}` : `nums:${[...others].sort().join(',')}`;
  const gh = await hash(groupKey);
  const members = await Promise.all(others.map((n) => hash(n)));
  const from = e.box === 1 ? parts.find((p) => p.type === 137)?.num ?? null : null;
  r.group(gh, members, e.date, from ? await hash(from) : null);
}

// ---- settings / folder ----

export async function loadCommSettings(env: Env): Promise<CommSettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM comm_settings WHERE id = 1').first<CommSettingsRow>();
  if (row) return row;
  await env.DB.prepare('INSERT OR IGNORE INTO comm_settings (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM comm_settings WHERE id = 1').first<CommSettingsRow>())!;
}

export async function findCommsFolder(env: Env) {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await cloudAccess(env, acct.id);
      for (const f of await adapter.listFolder(token, null)) {
        if (f.type === 'folder' && f.name.trim().toLowerCase() === COMMS_FOLDER_NAME.toLowerCase()) {
          return { accountId: acct.id, accountLabel: acct.label, folderId: f.id, folderName: f.name, folderUrl: f.webUrl };
        }
      }
    } catch (err) {
      console.error('SMS folder search failed', acct.label, err);
    }
  }
  return null;
}

/** Google Drive source with byte-range reads (alt=media + Range). */
export async function driveSource(env: Env, accountId: string, folderId: string): Promise<BackupSource> {
  const { token, adapter } = await cloudAccess(env, accountId);
  return {
    async list() {
      return (await adapter.listFolder(token, folderId))
        .filter((f) => f.type === 'file')
        .map((f) => ({ id: f.id, name: f.name, size: f.sizeBytes, modifiedAt: f.modifiedAt }));
    },
    async read(file, start, end) {
      const range = `bytes=${start}-${end !== undefined ? end - 1 : ''}`;
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}`, Range: range },
      });
      if (!res.ok || !res.body) throw new Error(`Drive read failed (${res.status}) for ${file.name}`);
      return res.body;
    },
  };
}

/** Newest calls-*.xml and sms-*.xml (names carry the backup timestamp). */
export function newestBackups(files: BackupFile[]) {
  const pick = (re: RegExp) => files.filter((f) => re.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
  return { calls: pick(/^calls-\d+.*\.xml$/i), sms: pick(/^sms-\d+.*\.xml$/i) };
}

// ---- streaming ----

/** Streams bytes into a scanner; `onEvents` drains its events. Stops after
 * `budget` bytes or when `stop()` says so. Returns bytes read and whether
 * the stream ended. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  scanner: BackupScanner,
  onEvents: (events: BackupEvent[]) => Promise<void>,
  opts: { budget?: number; stop?: () => boolean } = {}
): Promise<{ bytes: number; ended: boolean }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        scanner.push(dec.decode());
        await onEvents(scanner.events.splice(0));
        return { bytes, ended: true };
      }
      bytes += value.length;
      scanner.push(dec.decode(value, { stream: true }));
      if (scanner.events.length) await onEvents(scanner.events.splice(0));
      if ((opts.budget !== undefined && bytes >= opts.budget) || opts.stop?.()) return { bytes, ended: false };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Date of the first chat/picture message at or after `offset`
 * (-Infinity while still in the plain-text block; null only at end of
 * file). Reads forward until the first <mms> tag — through a large video
 * attachment if it has to (capped at PROBE_MAX_BYTES). */
const PROBE_MAX_BYTES = 512 * 1024 * 1024;
async function probeMmsDate(source: BackupSource, file: BackupFile, offset: number): Promise<number | null> {
  const size = file.size ?? 0;
  if (offset >= size) return null;
  const scanner = new BackupScanner({ mms: true });
  await pump(await source.read(file, offset, Math.min(size, offset + PROBE_MAX_BYTES)), scanner, async (ev) => void ev, {
    stop: () => scanner.firstMmsDate !== null || (scanner.sawSms && !scanner.sawMms),
  });
  if (scanner.firstMmsDate !== null) return scanner.firstMmsDate;
  if (scanner.sawSms) return -Infinity;
  return null;
}

/** Largest offset whose first chat message is ≤ watermark (start reading there). */
async function findChatStart(source: BackupSource, file: BackupFile, wm: number): Promise<number> {
  const size = file.size ?? 0;
  if (!wm || size < 64 * 1024 * 1024) return 0;
  let lo = 0;
  let hi = size;
  while (hi - lo > 8 * 1024 * 1024) {
    const mid = Math.floor((lo + hi) / 2);
    const d = await probeMmsDate(source, file, mid);
    if (d === null || d > wm) hi = mid;
    else lo = mid;
  }
  return lo;
}

// ---- the run ----

export async function runComms(env: Env, sourceOverride?: BackupSource, opts: { chatBudget?: number } = {}): Promise<CommsRunResult> {
  let s = await loadCommSettings(env);
  const result: CommsRunResult = { folder: s.folder_name, calls: { file: null, added: 0 }, texts: { file: null, added: 0 }, chats: { file: null, added: 0, bytes: 0, done: !!s.mms_done, through: s.mms_wm }, errors: [] };
  const update = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    await env.DB.prepare(`UPDATE comm_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`).bind(...keys.map((k) => fields[k] ?? null)).run();
  };
  try {
    let source = sourceOverride;
    if (!source) {
      if (!s.folder_id || !s.cloud_account_id) {
        const found = await findCommsFolder(env);
        if (!found) throw new Error(`No "${COMMS_FOLDER_NAME}" folder found at the top of a connected Google Drive.`);
        await update({ cloud_account_id: found.accountId, folder_id: found.folderId, folder_name: found.folderName, folder_url: found.folderUrl });
        s = await loadCommSettings(env);
        result.folder = s.folder_name;
      }
      source = await driveSource(env, s.cloud_account_id!, s.folder_id!);
    }
    const hash = await makeHasher(env);
    const { calls, sms } = newestBackups(await source.list());
    let firstAt = s.first_at;
    const noteFirst = (r: Rollup) => {
      if (r.firstAt !== null && (firstAt === null || r.firstAt < firstAt)) firstAt = r.firstAt;
    };

    // 1. Calls — the whole (small) file, anything newer than the watermark.
    if (calls && calls.id !== s.calls_file_id) {
      result.calls.file = calls.name;
      const r = new Rollup();
      let wm = s.calls_wm ?? 0;
      const start = wm;
      await pump(await source.read(calls, 0), new BackupScanner({ call: true }), async (ev) => {
        for (const e of ev) {
          if (e.kind !== 'call' || e.date <= start) continue;
          await addCall(r, hash, e);
          wm = Math.max(wm, e.date);
        }
      });
      await r.flush(env);
      noteFirst(r);
      result.calls.added = r.added;
      await update({ calls_file_id: calls.id, calls_wm: wm || null, first_at: firstAt });
    }

    if (sms) {
      // 2. Plain texts — stream from the top until the chat block starts.
      if (sms.id !== s.sms_file_id) {
        result.texts.file = sms.name;
        const r = new Rollup();
        let wm = s.sms_wm ?? 0;
        const start = wm;
        const scanner = new BackupScanner({ sms: true });
        await pump(await source.read(sms, 0), scanner, async (ev) => {
          for (const e of ev) {
            if (e.kind !== 'sms' || e.date <= start) continue;
            await addSms(r, hash, e);
            wm = Math.max(wm, e.date);
          }
        }, { stop: () => scanner.sawMms });
        await r.flush(env);
        noteFirst(r);
        result.texts.added = r.added;
        // A new nightly file: its chat block may have new messages again.
        await update({ sms_file_id: sms.id, sms_wm: wm || null, sms_file_size: sms.size, mms_done: 0, first_at: firstAt });
        s = await loadCommSettings(env);
      }

      // 3. Chat / picture messages — from the watermark, up to the budget.
      if (!s.mms_done || s.mms_file_id !== sms.id) {
        result.chats.file = sms.name;
        const r = new Rollup();
        let wm = s.mms_wm ?? 0;
        const start = wm;
        let stats: { chatsFirstAt?: number } = {};
        try {
          stats = s.stats_json ? JSON.parse(s.stats_json) : {};
        } catch {
          stats = {};
        }
        const offset = await findChatStart(source, sms, start);
        const out = await pump(await source.read(sms, offset), new BackupScanner({ mms: true }), async (ev) => {
          for (const e of ev) {
            if (e.kind !== 'mms' || e.date <= start) continue;
            if (!stats.chatsFirstAt || e.date < stats.chatsFirstAt) stats.chatsFirstAt = e.date;
            await addMms(r, hash, e);
            wm = Math.max(wm, e.date);
          }
          if (r.monthly.size + r.last.size > 2000) await r.flush(env);
        }, { budget: opts.chatBudget ?? CHAT_BUDGET_BYTES });
        await r.flush(env);
        noteFirst(r);
        result.chats.added = r.added;
        result.chats.bytes = out.bytes;
        result.chats.offset = offset;
        result.chats.done = out.ended;
        result.chats.through = wm || null;
        await update({ mms_wm: wm || null, mms_done: out.ended ? 1 : 0, mms_file_id: out.ended ? sms.id : s.mms_file_id, first_at: firstAt, stats_json: JSON.stringify(stats) });
      }
    }
    await update({ last_scan_at: now(), last_error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    await update({ last_scan_at: now(), last_error: message });
  }
  return result;
}

/** Hourly at the comms slot: work to do when a newer backup landed or the
 * chat backfill isn't finished. Cheap check (one folder listing). */
export async function commsScanDue(env: Env): Promise<boolean> {
  const s = await loadCommSettings(env);
  if (!s.folder_id) return new Date().getUTCHours() === 8; // look for the folder once a day
  if (!s.mms_done) return true;
  if (!s.last_scan_at || s.last_scan_at < new Date(Date.now() - 20 * 3600 * 1000).toISOString()) return true;
  try {
    const source = await driveSource(env, s.cloud_account_id!, s.folder_id);
    const { calls, sms } = newestBackups(await source.list());
    return (!!calls && calls.id !== s.calls_file_id) || (!!sms && sms.id !== s.sms_file_id);
  } catch {
    return false;
  }
}
