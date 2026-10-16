import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { pdfToText } from '../statements/pdfText';
import { cleanReport } from './clean';
import { parseCreditPdf, parseReportFileName } from './pdf';
import type { CreditReport } from './types';
import { syncCreditReportsTask } from './task';

/** Finance → Credit Reports on autopilot (Mike, 2026-10-16; migration 0137).
 * MikeOS finds the top-level Drive folder "Credit Reports" (like the Bee and
 * Home Maintenance folders) and checks it nightly:
 *  - a .json file (what Claude writes after reading reports) → imported;
 *  - a PDF named "YYYY.MM.DD - Bureau.pdf" with no report yet → read with the
 *    rule-based layout readers (credit/pdf.ts); a PDF whose stored report is
 *    only partial is re-read in full and replaces it when the read is clean;
 *  - anything that can't be read shows "Not read yet" on the page.
 * Each file is remembered in credit_report_files and re-checked only when
 * Drive says it changed. */

export const CREDIT_FOLDER_NAME = 'Credit Reports';
const READS_PER_SCAN = 4;
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
export interface FileRow {
  file_id: string;
  name: string;
  modified_at: string | null;
  web_url: string | null;
  kind: 'pdf' | 'json' | 'other';
  report_id: string | null;
  status: 'loaded' | 'read' | 'imported' | 'not_read' | 'queued' | 'ignored';
  error: string | null;
  checked_at: string | null;
}

export async function loadCreditSettings(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare('SELECT * FROM credit_report_settings WHERE id = 1').first<SettingsRow>();
  if (row) return row;
  await env.DB.prepare('INSERT OR IGNORE INTO credit_report_settings (id) VALUES (1)').run();
  return (await env.DB.prepare('SELECT * FROM credit_report_settings WHERE id = 1').first<SettingsRow>())!;
}

type Access = typeof cloudAccess;

async function findFolder(env: Env, access: Access) {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await access(env, acct.id);
      const f = (await adapter.listFolder(token, null)).find((e) => e.type === 'folder' && e.name.trim().toLowerCase() === CREDIT_FOLDER_NAME.toLowerCase());
      if (f) return { accountId: acct.id, folderId: f.id, folderName: f.name, folderUrl: f.webUrl };
    } catch (err) {
      console.error('Credit Reports folder search failed', acct.label, err);
    }
  }
  return null;
}

export async function storeReport(env: Env, r: CreditReport, source: string) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO credit_reports (id, bureau, pulled_on, file_id, source, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET bureau = excluded.bureau, pulled_on = excluded.pulled_on, file_id = COALESCE(excluded.file_id, credit_reports.file_id),
       source = excluded.source, data_json = excluded.data_json, updated_at = excluded.updated_at`,
  )
    .bind(r.id, r.bureau, r.pulled_on, r.file_id, source, JSON.stringify(r), ts, ts)
    .run();
}

/** Which stored report a Drive file belongs to: by file id, else by the file name's date + bureau. */
function reportFor<T extends { id: string; file_id: string | null; partial: boolean }>(name: string, fileId: string, reports: T[]): T | null {
  const byFile = reports.find((r) => r.file_id === fileId);
  if (byFile) return byFile;
  const { date, bureau } = parseReportFileName(name);
  if (!date) return null;
  if (bureau) return reports.find((r) => r.id === `${date}-${bureau}`) ?? null;
  // Merged 3-bureau reports (CreditCheck, PCS) are stored as "other".
  return reports.find((r) => r.id === `${date}-other`) ?? null;
}

/** Turn one PDF's text into a stored report (pure apart from DB writes — tests call it without Drive). */
export async function ingestPdfText(
  env: Env,
  text: string,
  name: string,
  fileId: string,
  existing: CreditReport | null,
): Promise<{ status: FileRow['status']; reportId: string | null; error: string | null }> {
  let parsed;
  try {
    parsed = parseCreditPdf(text, name, fileId);
  } catch (err) {
    return { status: 'not_read', reportId: null, error: err instanceof Error ? err.message : String(err) };
  }
  const clean = cleanReport(parsed.report);
  if (typeof clean === 'string') return { status: 'not_read', reportId: null, error: clean };
  if (existing) {
    // Only replace a stored report that was itself partial, and only with a clean, fuller read.
    if (!existing.partial) return { status: 'loaded', reportId: existing.id, error: null };
    if (parsed.mismatch || clean.accounts.length < existing.accounts.length)
      return { status: 'loaded', reportId: existing.id, error: `Re-read wasn't complete (${parsed.mismatch ?? `${clean.accounts.length} accounts`}) — kept the stored copy` };
    // Keep what the layout reader doesn't capture (personal info, negatives, scores).
    if (!clean.personal.addresses.length) clean.personal = existing.personal;
    if (!clean.negatives.length) clean.negatives = existing.negatives;
    if (!clean.scores.length) clean.scores = existing.scores;
    clean.notes = `${clean.notes ?? ''} Replaced a partial copy.`.trim();
  }
  await storeReport(env, clean, 'pdf');
  return { status: 'read', reportId: clean.id, error: parsed.mismatch };
}

export async function ingestJsonText(env: Env, text: string): Promise<{ status: FileRow['status']; reportId: string | null; error: string | null }> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 'not_read', reportId: null, error: 'Not valid JSON' };
  }
  const list = Array.isArray(body) ? body : Array.isArray((body as { reports?: unknown[] })?.reports) ? (body as { reports: unknown[] }).reports : [body];
  const clean: CreditReport[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = cleanReport(list[i]);
    if (typeof r === 'string') return { status: 'not_read', reportId: null, error: `report ${i + 1}: ${r}` };
    clean.push(r);
  }
  for (const r of clean) await storeReport(env, r, 'json');
  return { status: 'imported', reportId: clean.length === 1 ? clean[0].id : null, error: clean.length > 1 ? `${clean.length} reports imported` : null };
}

export interface CreditScanResult {
  folder: string | null;
  listed: number;
  read: number;
  imported: number;
  notRead: number;
  /** Files left for the next pass (per-scan budget). */
  queued: number;
  error: string | null;
}

/** `access` is swappable so tests can stand in for Drive. */
export async function scanCreditFolder(env: Env, access: Access = cloudAccess): Promise<CreditScanResult> {
  const started = Date.now();
  let s = await loadCreditSettings(env);
  const result: CreditScanResult = { folder: s.folder_name, listed: 0, read: 0, imported: 0, notRead: 0, queued: 0, error: null };
  try {
    if (!s.folder_id || !s.cloud_account_id) {
      const found = await findFolder(env, access);
      if (!found) throw new Error(`No "${CREDIT_FOLDER_NAME}" folder found at the top of a connected Google Drive.`);
      await env.DB.prepare('UPDATE credit_report_settings SET cloud_account_id = ?, folder_id = ?, folder_name = ?, folder_url = ? WHERE id = 1')
        .bind(found.accountId, found.folderId, found.folderName, found.folderUrl)
        .run();
      s = await loadCreditSettings(env);
      result.folder = s.folder_name;
    }
    const { token, adapter } = await access(env, s.cloud_account_id!);
    let listing;
    try {
      listing = await adapter.listFolder(token, s.folder_id!);
    } catch (err) {
      await env.DB.prepare('UPDATE credit_report_settings SET folder_id = NULL, cloud_account_id = NULL WHERE id = 1').run();
      throw err;
    }
    const files = listing.filter((e) => e.type === 'file');
    result.listed = files.length;
    const known = new Map(((await env.DB.prepare('SELECT * FROM credit_report_files').all<FileRow>()).results ?? []).map((f) => [f.file_id, f]));
    const reportRows = ((await env.DB.prepare('SELECT id, file_id, data_json FROM credit_reports').all<{ id: string; file_id: string | null; data_json: string }>()).results ?? []).map((r) => {
      const d = JSON.parse(r.data_json) as CreditReport;
      return { id: r.id, file_id: r.file_id ?? d.file_id, partial: !!d.partial, data: d };
    });
    let reads = 0;
    // Newest first, so this year's pull is read before old files.
    for (const f of [...files].sort((a, b) => b.name.localeCompare(a.name))) {
      const lower = f.name.toLowerCase();
      const kind: FileRow['kind'] = lower.endsWith('.pdf') ? 'pdf' : lower.endsWith('.json') ? 'json' : 'other';
      const prev = known.get(f.id);
      const changed = !prev || prev.modified_at !== f.modifiedAt || prev.name !== f.name;
      const match = kind === 'pdf' ? reportFor(f.name, f.id, reportRows) : null;
      let row: Omit<FileRow, 'checked_at'> = {
        file_id: f.id,
        name: f.name,
        modified_at: f.modifiedAt,
        web_url: f.webUrl,
        kind,
        report_id: match?.id ?? prev?.report_id ?? null,
        status: prev?.status ?? 'not_read',
        error: prev?.error ?? null,
      };
      const wantsRead = changed || prev?.status === 'queued';
      if (kind === 'other') row = { ...row, status: 'ignored', error: null };
      else if (kind === 'pdf' && match && !match.partial) row = { ...row, status: prev?.status === 'read' ? 'read' : 'loaded', error: null };
      else if (wantsRead && (reads >= READS_PER_SCAN || Date.now() - started >= SCAN_BUDGET_MS)) {
        row = { ...row, status: 'queued', error: null };
        result.queued++;
      } else if (wantsRead) {
        // Read it: a new/changed JSON, a PDF with no report yet, or a PDF whose report is partial.
        reads++;
        try {
          const res = await adapter.downloadFile(token, f.id);
          if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
          const buf = await res.arrayBuffer();
          const out = kind === 'json' ? await ingestJsonText(env, new TextDecoder().decode(buf)) : await ingestPdfText(env, await pdfToText(buf), f.name, f.id, match?.data ?? null);
          row = { ...row, status: out.status, report_id: out.reportId ?? row.report_id, error: out.error };
          if (out.status === 'not_read' && match) row = { ...row, status: 'loaded', error: `Couldn't re-read the full PDF: ${out.error}` };
          if (out.status === 'read') result.read++;
          if (out.status === 'imported') result.imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A partial report already stored stays "loaded" — the re-read just didn't help.
          row = match ? { ...row, status: 'loaded', error: `Couldn't re-read the full PDF: ${msg}` } : { ...row, status: 'not_read', error: msg };
        }
      }
      if (row.status === 'not_read') result.notRead++;
      await env.DB.prepare(
        `INSERT INTO credit_report_files (file_id, name, modified_at, web_url, kind, report_id, status, error, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, modified_at = excluded.modified_at, web_url = excluded.web_url, kind = excluded.kind,
           report_id = excluded.report_id, status = excluded.status, error = excluded.error, checked_at = excluded.checked_at`,
      )
        .bind(row.file_id, row.name, row.modified_at, row.web_url, row.kind, row.report_id, row.status, row.error, now())
        .run();
    }
    // Files gone from the folder are forgotten (their reports stay).
    const seen = new Set(files.map((f) => f.id));
    for (const id of known.keys()) if (!seen.has(id)) await env.DB.prepare('DELETE FROM credit_report_files WHERE file_id = ?').bind(id).run();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  await env.DB.prepare('UPDATE credit_report_settings SET last_scan_at = ?, last_error = ? WHERE id = 1').bind(now(), result.error).run();
  await syncCreditReportsTask(env);
  return result;
}

/** Nightly at 07:xx UTC, or any :20 tick if the last scan is >20h old. */
export async function creditScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  const s = await loadCreditSettings(env);
  return !s.last_scan_at || s.last_scan_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}
