import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { pdfToText } from '../statements/pdfText';
import { cleanEmployer, cleanEvent, cleanStub } from './clean';
import { NotAPaystub, parseFileName, parsePaystubPdf } from './pdf';
import type { CareerEmployer, CareerEvent, Paystub } from './types';

/** Finance → Career reads every employer's Drive folder(s) where they are —
 * Mike keeps one folder per job, named after the employer, and some exist in
 * two places (an old top-level copy and a newer one); the copies are merged
 * by file name. Folders are found by name with Drive search (any depth),
 * remembered in career_folders, and re-found on Scan Now.
 *
 * Per file (career_files):
 *  - a .json file (what Claude writes after reading an old layout) →
 *    imported ({ employers?, stubs?, events? } — same shape as POST /import);
 *  - a PDF a stored stub/event already came from (by file id, or by the same
 *    file name for that employer — a copy) → "loaded";
 *  - a new PDF → the rule-based reader (career/pdf.ts, Gusto today);
 *    anything else → "Not read yet" with the reason;
 *  - the second copy of a same-named file → "duplicate".
 * Unchanged files are never re-read. */

const READS_PER_SCAN = 8;
const SCAN_BUDGET_MS = 20_000;
const now = () => new Date().toISOString();

type Access = typeof cloudAccess;

export interface CareerFileRow {
  file_id: string;
  employer_id: string;
  folder_id: string | null;
  name: string;
  modified_at: string | null;
  web_url: string | null;
  kind: 'pdf' | 'json' | 'other';
  record_id: string | null;
  status: 'read' | 'imported' | 'loaded' | 'duplicate' | 'not_read' | 'queued' | 'ignored';
  error: string | null;
  checked_at: string | null;
}
export interface CareerFolderRow {
  folder_id: string;
  employer_id: string;
  cloud_account_id: string;
  name: string;
  url: string | null;
  listed_at: string | null;
}

// ---------- storage ----------

interface EmployerRow {
  id: string;
  name: string;
  aliases: string;
  folder_names: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: number;
  notes: string | null;
  salaries: string | null;
}
export async function loadEmployers(env: Env): Promise<CareerEmployer[]> {
  const { results } = await env.DB.prepare('SELECT * FROM career_employers ORDER BY COALESCE(start_date, created_at)').all<EmployerRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    aliases: JSON.parse(r.aliases || '[]'),
    folder_names: JSON.parse(r.folder_names || '[]'),
    title: r.title,
    start_date: r.start_date,
    end_date: r.end_date,
    is_current: !!r.is_current,
    notes: r.notes,
    salaries: JSON.parse(r.salaries || '[]'),
  }));
}
export async function storeEmployer(env: Env, e: CareerEmployer) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO career_employers (id, name, aliases, folder_names, title, start_date, end_date, is_current, notes, salaries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, folder_names = excluded.folder_names, title = excluded.title,
       start_date = excluded.start_date, end_date = excluded.end_date, is_current = excluded.is_current, notes = excluded.notes, salaries = excluded.salaries, updated_at = excluded.updated_at`,
  )
    .bind(e.id, e.name, JSON.stringify(e.aliases), JSON.stringify(e.folder_names), e.title, e.start_date, e.end_date, e.is_current ? 1 : 0, e.notes, JSON.stringify(e.salaries ?? []), ts, ts)
    .run();
}
export async function loadStubs(env: Env): Promise<Paystub[]> {
  const { results } = await env.DB.prepare('SELECT data_json FROM career_stubs ORDER BY pay_date, id').all<{ data_json: string }>();
  return (results ?? []).map((r) => JSON.parse(r.data_json) as Paystub);
}
export async function loadEvents(env: Env): Promise<CareerEvent[]> {
  const { results } = await env.DB.prepare('SELECT data_json FROM career_events ORDER BY date, id').all<{ data_json: string }>();
  return (results ?? []).map((r) => JSON.parse(r.data_json) as CareerEvent);
}
function stubStmt(env: Env, s: Paystub, source: string, ts: string) {
  return env.DB.prepare(
    `INSERT INTO career_stubs (id, employer_id, pay_date, kind, file_id, source, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET employer_id = excluded.employer_id, pay_date = excluded.pay_date, kind = excluded.kind,
       file_id = COALESCE(excluded.file_id, career_stubs.file_id), source = excluded.source, data_json = excluded.data_json, updated_at = excluded.updated_at`,
  ).bind(s.id, s.employer, s.pay_date, s.kind, s.file_id, source, JSON.stringify(s), ts, ts);
}
function eventStmt(env: Env, e: CareerEvent, source: string, ts: string) {
  return env.DB.prepare(
    `INSERT INTO career_events (id, employer_id, date, kind, file_id, source, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET employer_id = excluded.employer_id, date = excluded.date, kind = excluded.kind,
       file_id = COALESCE(excluded.file_id, career_events.file_id), source = excluded.source, data_json = excluded.data_json, updated_at = excluded.updated_at`,
  ).bind(e.id, e.employer, e.date, e.kind, e.file_id, source, JSON.stringify(e), ts, ts);
}

export interface ImportResult {
  status: 'imported' | 'not_read';
  employers: number;
  stubs: number;
  events: number;
  ids: string[];
  error: string | null;
}

/** { employers?: [], stubs?: [], events?: [] } — all-or-nothing; same id replaces. */
export async function ingestCareerJson(env: Env, text: string, source = 'json'): Promise<ImportResult> {
  const fail = (error: string): ImportResult => ({ status: 'not_read', employers: 0, stubs: 0, events: 0, ids: [], error });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('Not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Expected { employers, stubs, events }');
  const b = body as { employers?: unknown[]; stubs?: unknown[]; events?: unknown[] };
  const employers: CareerEmployer[] = [];
  const stubs: Paystub[] = [];
  const events: CareerEvent[] = [];
  for (const [i, raw] of (b.employers ?? []).entries()) {
    const e = cleanEmployer(raw);
    if (typeof e === 'string') return fail(`employer ${i + 1}: ${e}`);
    employers.push(e);
  }
  const known = new Set([...employers.map((e) => e.id), ...(await loadEmployers(env)).map((e) => e.id)]);
  for (const [i, raw] of (b.stubs ?? []).entries()) {
    const s = cleanStub(raw);
    if (typeof s === 'string') return fail(`paystub ${i + 1}: ${s}`);
    if (!known.has(s.employer)) return fail(`paystub ${i + 1}: unknown employer "${s.employer}" — add it to employers`);
    stubs.push(s);
  }
  for (const [i, raw] of (b.events ?? []).entries()) {
    const e = cleanEvent(raw);
    if (typeof e === 'string') return fail(`event ${i + 1}: ${e}`);
    if (!known.has(e.employer)) return fail(`event ${i + 1}: unknown employer "${e.employer}"`);
    events.push(e);
  }
  if (!employers.length && !stubs.length && !events.length) return fail('Nothing to import');
  const ids = new Set<string>();
  for (const s of stubs) {
    if (ids.has(s.id)) return fail(`duplicate paystub id ${s.id}`);
    ids.add(s.id);
  }
  for (const e of employers) await storeEmployer(env, e);
  const ts = now();
  const stmts = [...stubs.map((s) => stubStmt(env, s, source, ts)), ...events.map((e) => eventStmt(env, e, source, ts))];
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { status: 'imported', employers: employers.length, stubs: stubs.length, events: events.length, ids: [...stubs.map((s) => s.id), ...events.map((e) => e.id)], error: null };
}

/** Read one PDF's text into a stored paystub (no Drive — tests call it directly). */
export async function ingestPaystubText(env: Env, text: string, name: string, fileId: string | null, employerId: string) {
  try {
    const read = parsePaystubPdf(text, name);
    // Same employer + date + kind from a different file → number it.
    const base = `${employerId}:${read.pay_date}:${read.kind}`;
    let id = base;
    for (let n = 2; n < 10; n++) {
      const row = await env.DB.prepare('SELECT file_id FROM career_stubs WHERE id = ?').bind(id).first<{ file_id: string | null }>();
      if (!row || !fileId || row.file_id === fileId) break;
      id = `${base}:${n}`;
    }
    const clean = cleanStub({ ...read, id, employer: employerId, file_id: fileId, file_name: name });
    if (typeof clean === 'string') return { status: 'not_read' as const, recordId: null, error: clean };
    await stubStmt(env, clean, 'pdf', now()).run();
    return { status: 'read' as const, recordId: clean.id, error: clean.issues.length ? clean.issues.join('; ') : null };
  } catch (err) {
    return { status: 'not_read' as const, recordId: null, error: err instanceof NotAPaystub || err instanceof Error ? err.message : String(err) };
  }
}

// ---------- Drive ----------

/** Exact-name folder lookup straight against the Drive API ("name contains"
 * search caps at 50 hits, and a short name like "Origin" matches plenty).
 * Null when the call fails, so the adapter's search is the fallback. */
async function exactFolders(token: string, name: string) {
  try {
    const q = encodeURIComponent(`name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent('files(id,name,webViewLink)')}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { files?: { id: string; name: string; webViewLink?: string }[] };
    return (json.files ?? []).map((f) => ({ id: f.id, name: f.name, type: 'folder' as const, webUrl: f.webViewLink ?? null }));
  } catch {
    return null;
  }
}

async function findFolders(env: Env, access: Access, emp: CareerEmployer): Promise<CareerFolderRow[]> {
  const { results } = await env.DB.prepare(`SELECT id, label FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{ id: string; label: string }>();
  const wanted = new Set((emp.folder_names.length ? emp.folder_names : [emp.name]).map((n) => n.trim().toLowerCase()));
  const out: CareerFolderRow[] = [];
  for (const acct of results ?? []) {
    try {
      const { token, adapter } = await access(env, acct.id);
      for (const name of wanted) {
        const hits = (await exactFolders(token, name)) ?? (await adapter.search(token, name));
        for (const h of hits) if (h.type === 'folder' && wanted.has(h.name.trim().toLowerCase()) && !out.some((o) => o.folder_id === h.id)) out.push({ folder_id: h.id, employer_id: emp.id, cloud_account_id: acct.id, name: h.name, url: h.webUrl, listed_at: null });
      }
    } catch (err) {
      console.error('Career folder search failed', acct.label, err);
    }
  }
  return out;
}

export interface CareerScanResult {
  employers: number;
  folders: number;
  listed: number;
  read: number;
  imported: number;
  notRead: number;
  queued: number;
  error: string | null;
}

export async function scanCareer(env: Env, opts: { refind?: boolean } = {}, access: Access = cloudAccess): Promise<CareerScanResult> {
  const started = Date.now();
  const result: CareerScanResult = { employers: 0, folders: 0, listed: 0, read: 0, imported: 0, notRead: 0, queued: 0, error: null };
  const errors: string[] = [];
  try {
    const employers = await loadEmployers(env);
    result.employers = employers.length;
    const knownFiles = new Map(((await env.DB.prepare('SELECT * FROM career_files').all<CareerFileRow>()).results ?? []).map((f) => [f.file_id, f]));
    const seen = new Set<string>();
    let reads = 0;
    // Current employer first (the one that gets new files), then the rest.
    for (const emp of [...employers].sort((a, b) => Number(b.is_current) - Number(a.is_current))) {
      let folders = (await env.DB.prepare('SELECT * FROM career_folders WHERE employer_id = ?').bind(emp.id).all<CareerFolderRow>()).results ?? [];
      if (!folders.length || opts.refind) {
        const found = await findFolders(env, access, emp);
        if (found.length) {
          await env.DB.prepare('DELETE FROM career_folders WHERE employer_id = ?').bind(emp.id).run();
          for (const f of found)
            await env.DB.prepare('INSERT OR REPLACE INTO career_folders (folder_id, employer_id, cloud_account_id, name, url, listed_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(f.folder_id, f.employer_id, f.cloud_account_id, f.name, f.url).run();
          folders = found;
        }
      }
      result.folders += folders.length;
      // Records already stored for this employer: by file id and by file name (copies).
      const recs = (
        await env.DB.prepare(
          `SELECT id, file_id, json_extract(data_json, '$.file_name') AS file_name FROM career_stubs WHERE employer_id = ?
           UNION ALL SELECT id, file_id, json_extract(data_json, '$.file_name') AS file_name FROM career_events WHERE employer_id = ?`,
        )
          .bind(emp.id, emp.id)
          .all<{ id: string; file_id: string | null; file_name: string | null }>()
      ).results ?? [];
      const byFileId = new Map(recs.filter((r) => r.file_id).map((r) => [r.file_id!, r.id]));
      const byName = new Map(recs.filter((r) => r.file_name).map((r) => [r.file_name!.toLowerCase(), r.id]));
      const namesSeen = new Map<string, string>();

      for (const folder of folders) {
        let files: { id: string; name: string; modifiedAt: string | null; webUrl: string | null; folderId: string }[] = [];
        try {
          const { token, adapter } = await access(env, folder.cloud_account_id);
          const top = await adapter.listFolder(token, folder.folder_id);
          files = top.filter((e) => e.type === 'file').map((e) => ({ ...e, folderId: folder.folder_id }));
          await env.DB.prepare('UPDATE career_folders SET listed_at = ? WHERE folder_id = ?').bind(now(), folder.folder_id).run();
        } catch (err) {
          errors.push(`${emp.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        result.listed += files.length;
        for (const f of files.sort((a, b) => b.name.localeCompare(a.name))) {
          seen.add(f.id);
          const lower = f.name.toLowerCase();
          const kind: CareerFileRow['kind'] = lower.endsWith('.pdf') ? 'pdf' : lower.endsWith('.json') ? 'json' : 'other';
          const prev = knownFiles.get(f.id);
          const changed = !prev || prev.modified_at !== f.modifiedAt || prev.name !== f.name;
          const linked = byFileId.get(f.id) ?? byName.get(lower) ?? null;
          let row: Omit<CareerFileRow, 'checked_at'> = {
            file_id: f.id,
            employer_id: emp.id,
            folder_id: f.folderId,
            name: f.name,
            modified_at: f.modifiedAt,
            web_url: f.webUrl,
            kind,
            record_id: linked ?? prev?.record_id ?? null,
            status: prev?.status ?? 'not_read',
            error: prev?.error ?? null,
          };
          const firstCopy = namesSeen.get(lower);
          if (kind !== 'json') namesSeen.set(lower, firstCopy ?? f.id);
          if (kind === 'other') row = { ...row, status: 'ignored', error: null };
          // Only "Employer - YYYY.MM.DD….pdf" names are paystubs; other PDFs (work files, decks)
          // are skipped unless an imported record points at them.
          else if (kind === 'pdf' && !linked && !parseFileName(f.name)) row = { ...row, status: 'ignored', error: 'Not a dated paystub name — skipped' };
          else if (firstCopy && firstCopy !== f.id) row = { ...row, status: linked ? 'loaded' : 'duplicate', error: null };
          else if (kind === 'pdf' && linked && !changed) row = { ...row, status: prev?.status === 'read' ? 'read' : 'loaded', error: prev?.status === 'read' ? row.error : null };
          else if (!(changed || prev?.status === 'queued')) {
            /* unchanged — keep the previous outcome */
          } else if (kind === 'pdf' && linked && prev?.status !== 'read') {
            row = { ...row, status: 'loaded', error: null };
          } else if (reads >= READS_PER_SCAN || Date.now() - started >= SCAN_BUDGET_MS) {
            row = { ...row, status: 'queued', error: null };
            result.queued++;
          } else {
            reads++;
            try {
              const { token, adapter } = await access(env, folder.cloud_account_id);
              const res = await adapter.downloadFile(token, f.id);
              if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
              const buf = await res.arrayBuffer();
              if (kind === 'json') {
                const out = await ingestCareerJson(env, new TextDecoder().decode(buf));
                row = { ...row, status: out.status, record_id: null, error: out.error ?? `${out.stubs} paystubs, ${out.events} equity items` };
                if (out.status === 'imported') result.imported++;
              } else {
                const parsed = parseFileName(f.name);
                if (parsed && parsed.kind === 'equity') throw new NotAPaystub('Equity document — Claude reads these (drop a .json next to it)');
                const out = await ingestPaystubText(env, await pdfToText(buf), f.name, f.id, emp.id);
                row = { ...row, status: out.status, record_id: out.recordId ?? row.record_id, error: out.error };
                if (out.status === 'read') {
                  result.read++;
                  byFileId.set(f.id, out.recordId!);
                }
              }
            } catch (err) {
              row = { ...row, status: 'not_read', error: err instanceof Error ? err.message : String(err) };
            }
          }
          await env.DB.prepare(
            `INSERT INTO career_files (file_id, employer_id, folder_id, name, modified_at, web_url, kind, record_id, status, error, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(file_id) DO UPDATE SET employer_id = excluded.employer_id, folder_id = excluded.folder_id, name = excluded.name, modified_at = excluded.modified_at,
               web_url = excluded.web_url, kind = excluded.kind, record_id = excluded.record_id, status = excluded.status, error = excluded.error, checked_at = excluded.checked_at`,
          )
            .bind(row.file_id, row.employer_id, row.folder_id, row.name, row.modified_at, row.web_url, row.kind, row.record_id, row.status, row.error, now())
            .run();
        }
      }
    }
    // Files gone from every folder (only for employers whose folders all listed fine).
    if (!errors.length) for (const id of knownFiles.keys()) if (!seen.has(id)) await env.DB.prepare('DELETE FROM career_files WHERE file_id = ?').bind(id).run();
    // A JSON import names its PDFs — mark those loaded now.
    await env.DB.prepare(
      `UPDATE career_files SET status = 'loaded', error = NULL,
         record_id = COALESCE((SELECT id FROM career_stubs s WHERE s.file_id = career_files.file_id), (SELECT id FROM career_events e WHERE e.file_id = career_files.file_id))
       WHERE status IN ('not_read', 'queued') AND kind = 'pdf'
         AND (EXISTS (SELECT 1 FROM career_stubs s WHERE s.file_id = career_files.file_id) OR EXISTS (SELECT 1 FROM career_events e WHERE e.file_id = career_files.file_id))`,
    ).run();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  result.error = errors.length ? errors.join('; ') : null;
  result.notRead = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM career_files WHERE status = 'not_read'`).first<{ n: number }>())?.n ?? 0;
  await env.DB.prepare('UPDATE career_settings SET last_scan_at = ?, last_error = ? WHERE id = 1').bind(now(), result.error).run();
  return result;
}

/** Nightly at 07:xx UTC, or any :20 tick if the last scan is >20h old. */
export async function careerScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  if (new Date(scheduledTime).getUTCHours() === 7) return true;
  const s = await env.DB.prepare('SELECT last_scan_at FROM career_settings WHERE id = 1').first<{ last_scan_at: string | null }>();
  return !s?.last_scan_at || s.last_scan_at < new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString();
}
