import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { pdfToText } from '../statements/pdfText';
import { cleanStatement } from './clean';
import { parseSsaPdf } from './pdf';
import type { SsaStatement } from './types';
import { syncSsaTask } from './task';

/** Finance → Social Security reads the top-level Drive folder "Social
 * Security" (auto-found by name, like Credit Reports) nightly and on Scan
 * Now:
 *  - a PDF with no statement yet → read with the rule-based reader (ssa/pdf.ts);
 *  - a .json file (what Claude writes after reading a scanned paper statement)
 *    → imported (one statement or { statements: [...] });
 *  - anything unreadable shows "Not read yet" with the reason.
 * Each file is remembered in ssa_files and only re-read when Drive says it
 * changed. Statements are keyed by their printed date. */

export const SSA_FOLDER_NAME = 'Social Security';
const READS_PER_SCAN = 6;
const SCAN_BUDGET_MS = 20_000;
const now = () => new Date().toISOString();

interface SettingsRow {
  cloud_account_id: string | null;
  folder_id: string | null;
  folder_name: string | null;
  folder_url: string | null;
  last_scan_at: string | null;
  last_error: string | null;
}
export interface SsaFileRow {
  file_id: string;
  name: string;
  modified_at: string | null;
  web_url: string | null;
  kind: 'pdf' | 'json' | 'other';
  statement_id: string | null;
  status: 'read' | 'imported' | 'loaded' | 'not_read' | 'queued' | 'ignored';
  error: string | null;
  checked_at: string | null;
}

export async function loadSsaSettings(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM ssa_settings WHERE id = 1').first<SettingsRow>();
  if (row) return row;
  await env.DB.prepare('INSERT OR IGNORE INTO ssa_settings (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM ssa_settings WHERE id = 1').first<SettingsRow>())!;
}

export async function storeStatement(env: Env, s: SsaStatement, source: string) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO ssa_statements (id, statement_date, file_id, source, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET statement_date = excluded.statement_date, file_id = COALESCE(excluded.file_id, ssa_statements.file_id),
       source = excluded.source, data_json = excluded.data_json, updated_at = excluded.updated_at`,
  )
    .bind(s.id, s.statement_date, s.file_id, source, JSON.stringify(s), ts, ts)
    .run();
}

export async function loadStatements(env: Env): Promise<SsaStatement[]> {
  const { results } = await env.DB.prepare('SELECT data_json, file_id FROM ssa_statements ORDER BY statement_date').all<{ data_json: string; file_id: string | null }>();
  return (results ?? []).map((r) => ({ ...(JSON.parse(r.data_json) as SsaStatement), file_id: r.file_id ?? (JSON.parse(r.data_json) as SsaStatement).file_id }));
}

/** Read one PDF's text into a stored statement (no Drive — tests call it directly). */
export async function ingestSsaPdfText(env: Env, text: string, name: string, fileId: string | null) {
  try {
    const { statement, issues } = parseSsaPdf(text, name);
    const clean = cleanStatement({ ...statement, file_id: fileId, file_name: name, notes: issues.length ? issues.join('; ') : null });
    if (typeof clean === 'string') return { status: 'not_read' as const, statementId: null, error: clean };
    await storeStatement(env, clean, 'pdf');
    return { status: 'read' as const, statementId: clean.id, error: issues.length ? issues.join('; ') : null };
  } catch (err) {
    return { status: 'not_read' as const, statementId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function ingestSsaJson(env: Env, text: string, source = 'json') {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 'not_read' as const, ids: [] as string[], error: 'Not valid JSON' };
  }
  const list = Array.isArray(body) ? body : Array.isArray((body as { statements?: unknown[] })?.statements) ? (body as { statements: unknown[] }).statements : [body];
  const clean: SsaStatement[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = cleanStatement(list[i]);
    if (typeof s === 'string') return { status: 'not_read' as const, ids: [], error: `statement ${i + 1}: ${s}` };
    clean.push(s);
  }
  for (const s of clean) await storeStatement(env, s, source);
  return { status: 'imported' as const, ids: clean.map((s) => s.id), error: null };
}

type Access = typeof cloudAccess;

async function findFolder(env: Env, access: Access) {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await access(env, acct.id);
      const f = (await adapter.listFolder(token, null)).find((e) => e.type === 'folder' && e.name.trim().toLowerCase() === SSA_FOLDER_NAME.toLowerCase());
      if (f) return { accountId: acct.id, folderId: f.id, folderName: f.name, folderUrl: f.webUrl };
    } catch (err) {
      console.error('Social Security folder search failed', acct.label, err);
    }
  }
  return null;
}

export interface SsaScanResult {
  folder: string | null;
  listed: number;
  read: number;
  imported: number;
  notRead: number;
  queued: number;
  error: string | null;
}

export async function scanSsaFolder(env: Env, access: Access = cloudAccess): Promise<SsaScanResult> {
  const started = Date.now();
  let s = await loadSsaSettings(env);
  const result: SsaScanResult = { folder: s.folder_name, listed: 0, read: 0, imported: 0, notRead: 0, queued: 0, error: null };
  try {
    if (!s.folder_id || !s.cloud_account_id) {
      const found = await findFolder(env, access);
      if (!found) throw new Error(`No "${SSA_FOLDER_NAME}" folder found at the top of a connected Google Drive.`);
      await env.DB.prepare('UPDATE ssa_settings SET cloud_account_id = ?, folder_id = ?, folder_name = ?, folder_url = ? WHERE id = 1')
        .bind(found.accountId, found.folderId, found.folderName, found.folderUrl)
        .run();
      s = await loadSsaSettings(env);
      result.folder = s.folder_name;
    }
    const { token, adapter } = await access(env, s.cloud_account_id!);
    let listing;
    try {
      listing = await adapter.listFolder(token, s.folder_id!);
    } catch (err) {
      await env.DB.prepare('UPDATE ssa_settings SET folder_id = NULL, cloud_account_id = NULL WHERE id = 1').run();
      throw err;
    }
    const files = listing.filter((e) => e.type === 'file');
    result.listed = files.length;
    const known = new Map(((await env.DB.prepare('SELECT * FROM ssa_files').all<SsaFileRow>()).results ?? []).map((f) => [f.file_id, f]));
    const stored = await loadStatements(env);
    const byFile = new Map(stored.filter((x) => x.file_id).map((x) => [x.file_id!, x.id]));
    let reads = 0;
    for (const f of [...files].sort((a, b) => b.name.localeCompare(a.name))) {
      const lower = f.name.toLowerCase();
      const kind: SsaFileRow['kind'] = lower.endsWith('.pdf') ? 'pdf' : lower.endsWith('.json') ? 'json' : 'other';
      const prev = known.get(f.id);
      const changed = !prev || prev.modified_at !== f.modifiedAt || prev.name !== f.name;
      const linked = byFile.get(f.id) ?? null;
      let row: Omit<SsaFileRow, 'checked_at'> = {
        file_id: f.id,
        name: f.name,
        modified_at: f.modifiedAt,
        web_url: f.webUrl,
        kind,
        statement_id: linked ?? prev?.statement_id ?? null,
        status: prev?.status ?? 'not_read',
        error: prev?.error ?? null,
      };
      const wantsRead = changed || prev?.status === 'queued';
      if (kind === 'other') row = { ...row, status: 'ignored', error: null };
      else if (kind === 'pdf' && linked && !changed) row = { ...row, status: prev?.status === 'read' ? 'read' : 'loaded', error: prev?.status === 'read' ? row.error : null };
      else if (!wantsRead) {
        /* unchanged — keep the previous outcome */
      } else if (reads >= READS_PER_SCAN || Date.now() - started >= SCAN_BUDGET_MS) {
        row = { ...row, status: 'queued', error: null };
        result.queued++;
      } else {
        reads++;
        try {
          const res = await adapter.downloadFile(token, f.id);
          if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
          const buf = await res.arrayBuffer();
          if (kind === 'json') {
            const out = await ingestSsaJson(env, new TextDecoder().decode(buf));
            row = { ...row, status: out.status, statement_id: out.ids.length === 1 ? out.ids[0] : null, error: out.error ?? (out.ids.length > 1 ? `${out.ids.length} statements imported` : null) };
            if (out.status === 'imported') result.imported++;
          } else {
            const out = await ingestSsaPdfText(env, await pdfToText(buf), f.name, f.id);
            // A scan Claude already read (JSON carrying this file id) stays "loaded".
            if (out.status === 'not_read' && linked) row = { ...row, status: 'loaded', error: null };
            else row = { ...row, status: out.status, statement_id: out.statementId ?? row.statement_id, error: out.error };
            if (out.status === 'read') result.read++;
          }
        } catch (err) {
          row = linked ? { ...row, status: 'loaded', error: null } : { ...row, status: 'not_read', error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (row.status === 'not_read') result.notRead++;
      await env.DB.prepare(
        `INSERT INTO ssa_files (file_id, name, modified_at, web_url, kind, statement_id, status, error, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, modified_at = excluded.modified_at, web_url = excluded.web_url, kind = excluded.kind,
           statement_id = excluded.statement_id, status = excluded.status, error = excluded.error, checked_at = excluded.checked_at`,
      )
        .bind(row.file_id, row.name, row.modified_at, row.web_url, row.kind, row.statement_id, row.status, row.error, now())
        .run();
    }
    const seen = new Set(files.map((f) => f.id));
    for (const id of known.keys()) if (!seen.has(id)) await env.DB.prepare('DELETE FROM ssa_files WHERE file_id = ?').bind(id).run();
    // A JSON-imported scan names its PDF's file id — mark that PDF loaded now that it's linked.
    const fresh = new Map((await loadStatements(env)).filter((x) => x.file_id).map((x) => [x.file_id!, x.id]));
    for (const f of files) {
      const id = fresh.get(f.id);
      if (id) await env.DB.prepare(`UPDATE ssa_files SET statement_id = ?, status = CASE WHEN status = 'not_read' THEN 'loaded' ELSE status END, error = CASE WHEN status = 'not_read' THEN NULL ELSE error END WHERE file_id = ?`).bind(id, f.id).run();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.notRead = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ssa_files WHERE status = 'not_read'`).first<{ n: number }>())?.n ?? 0);
  await env.DB.prepare('UPDATE ssa_settings SET last_scan_at = ?, last_error = ? WHERE id = 1').bind(now(), result.error).run();
  await syncSsaTask(env);
  return result;
}

/** Nightly at 07:xx UTC, or any :20 tick if the last scan is >20h old. */
export async function ssaScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  const s = await loadSsaSettings(env);
  return !s.last_scan_at || s.last_scan_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}
