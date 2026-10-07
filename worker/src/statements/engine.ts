import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { detectFactValue, reindexEntry } from '../vault';
import { UnreadableStatement } from './common';
import { pdfToText } from './pdfText';
import { templateById } from './templates';
import { doc, docText, heading, markAuto } from './vaultDoc';
import type { Block } from './vaultDoc';
import { deriveNy529 } from './ny529Derive';

/** Base statements engine: lists a registered Drive folder, reads any PDF
 * not seen before (or modified since), stores normalized statement +
 * transaction rows, then hands off to the folder's template to refresh the
 * Vault note, flags and reminders. Idempotent — safe to run any time. */

export interface FolderRow {
  id: string;
  cloud_account_id: string;
  folder_id: string;
  folder_name: string;
  folder_url: string | null;
  template_id: string | null;
  status: 'live' | 'needs_template' | 'ignored';
  owner: 'household' | 'chase';
  vault_entry_id: string | null;
  settings_json: string | null;
  meta_json: string | null;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanResult {
  listed: number;
  read: number;
  parsed: number;
  unreadable: number;
  duplicates: number;
  remaining: number;
  errors: string[];
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
export const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Files read per run — keeps one invocation small; a backlog simply
 * continues on the next run (the nightly job loops until done). */
const MAX_FILES_PER_RUN = 12;

export async function loadFolder(env: Env, id: string): Promise<FolderRow | null> {
  return env.DB.prepare('SELECT * FROM statement_folders WHERE id = ?').bind(id).first<FolderRow>();
}

export async function scanFolder(env: Env, folder: FolderRow): Promise<ScanResult> {
  const template = templateById(folder.template_id);
  if (!template || folder.status !== 'live') throw new Error('This folder isn’t live (no template yet, or ignored).');
  const result: ScanResult = { listed: 0, read: 0, parsed: 0, unreadable: 0, duplicates: 0, remaining: 0, errors: [] };

  try {
    const { token, adapter } = await cloudAccess(env, folder.cloud_account_id);
    const entries = (await adapter.listFolder(token, folder.folder_id)).filter((e) => e.type === 'file' && /\.pdf$/i.test(e.name));
    result.listed = entries.length;

    const known = new Map(
      ((await env.DB.prepare('SELECT file_id, modified_at, status FROM statement_files WHERE folder_row_id = ?').bind(folder.id).all<{ file_id: string; modified_at: string | null; status: string }>()).results ?? []).map(
        (r) => [r.file_id, r]
      )
    );
    // A transient failure ('failed') is retried; unreadable/duplicate are
    // final until the file itself changes.
    const todo = entries
      .filter((e) => {
        const k = known.get(e.id);
        return !k || k.status === 'failed' || (e.modifiedAt && k.modified_at !== e.modifiedAt);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    result.remaining = Math.max(0, todo.length - MAX_FILES_PER_RUN);

    for (const file of todo.slice(0, MAX_FILES_PER_RUN)) {
      result.read++;
      let status: 'parsed' | 'unreadable' | 'failed' | 'duplicate' = 'failed';
      let error: string | null = null;
      let statementId: string | null = null;
      try {
        const res = await adapter.downloadFile(token, file.id);
        const text = await pdfToText(await res.arrayBuffer());
        if (text.replace(/\s/g, '').length < 40) throw new UnreadableStatement('No text layer (image-only scan)');
        const parsed = template.parse(text);

        const existing = await env.DB.prepare('SELECT id, file_id FROM statements WHERE folder_row_id = ? AND period_end = ?')
          .bind(folder.id, parsed.periodEnd)
          .first<{ id: string; file_id: string }>();
        if (existing && existing.file_id !== file.id) {
          status = 'duplicate';
          error = `Same period as another file (ending ${parsed.periodEnd})`;
          result.duplicates++;
        } else {
          statementId = existing?.id ?? uid();
          const stmts = [
            env.DB.prepare(
              `INSERT INTO statements (id, folder_row_id, file_id, period_start, period_end, values_json, checks_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(folder_row_id, period_end) DO UPDATE SET file_id = excluded.file_id, period_start = excluded.period_start,
                 values_json = excluded.values_json, checks_json = excluded.checks_json`
            ).bind(statementId, folder.id, file.id, parsed.periodStart, parsed.periodEnd, JSON.stringify(parsed.values), JSON.stringify(parsed.checks), now()),
            env.DB.prepare('DELETE FROM statement_transactions WHERE statement_id = ?').bind(statementId),
            ...parsed.transactions.map((t, i) =>
              env.DB.prepare(
                `INSERT INTO statement_transactions (id, statement_id, folder_row_id, txn_date, description, kind, amount, units, unit_price, position)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(uid(), statementId, folder.id, t.date, t.description, t.kind, t.amount, t.units, t.unitPrice, i)
            ),
          ];
          await env.DB.batch(stmts);
          status = 'parsed';
          result.parsed++;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (err instanceof UnreadableStatement) {
          status = 'unreadable';
          result.unreadable++;
        } else {
          result.errors.push(`${file.name}: ${error}`);
        }
      }
      await env.DB.prepare(
        `INSERT INTO statement_files (id, folder_row_id, file_id, file_name, web_url, modified_at, status, error, statement_id, parsed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder_row_id, file_id) DO UPDATE SET file_name = excluded.file_name, web_url = excluded.web_url,
           modified_at = excluded.modified_at, status = excluded.status, error = excluded.error,
           statement_id = excluded.statement_id, parsed_at = excluded.parsed_at`
      )
        .bind(uid(), folder.id, file.id, file.name, file.webUrl, file.modifiedAt, status, error, statementId, now())
        .run();
    }

    // Files deleted from Drive: drop their rows (and statements) so the
    // dashboard and coverage reflect what's actually in the folder.
    const present = new Set(entries.map((e) => e.id));
    for (const [fileId] of known) {
      if (present.has(fileId)) continue;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM statement_transactions WHERE statement_id IN (SELECT id FROM statements WHERE folder_row_id = ? AND file_id = ?)').bind(folder.id, fileId),
        env.DB.prepare('DELETE FROM statements WHERE folder_row_id = ? AND file_id = ?').bind(folder.id, fileId),
        env.DB.prepare('DELETE FROM statement_files WHERE folder_row_id = ? AND file_id = ?').bind(folder.id, fileId),
      ]);
    }

    await derive(env, folder);
    await env.DB.prepare('UPDATE statement_folders SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind(now(), result.errors.length ? result.errors.join(' · ').slice(0, 1000) : null, now(), folder.id)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE statement_folders SET last_scan_at = ?, last_error = ?, updated_at = ? WHERE id = ?').bind(now(), message, now(), folder.id).run();
    throw err;
  }
  return result;
}

/** Template-specific outputs (Vault note, flags, reminders, Tax Packet). */
export async function derive(env: Env, folder: FolderRow): Promise<void> {
  if (folder.template_id === 'ny529') await deriveNy529(env, (await loadFolder(env, folder.id)) ?? folder);
}

/** Nightly: every live folder, looping each until its backlog is read. */
export async function scanAllLiveFolders(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT * FROM statement_folders WHERE status = 'live'`).all<FolderRow>();
  for (const folder of results ?? []) {
    try {
      for (let pass = 0; pass < 20; pass++) {
        const r = await scanFolder(env, folder);
        if (!r.remaining) break;
      }
    } catch (err) {
      console.error('Statements scan failed', folder.folder_name, err);
    }
  }
}

/** True when the nightly scan is due: ~3:20am Eastern, or any later hour
 * if a live folder hasn't been scanned in 20h (self-healing retry). */
export async function statementsScanDue(env: Env, scheduledTime: number): Promise<boolean> {
  const hourUtc = new Date(scheduledTime).getUTCHours();
  if (hourUtc === STATEMENTS_SCAN_HOUR_UTC) return true;
  const stale = await env.DB.prepare(`SELECT COUNT(*) AS n FROM statement_folders WHERE status = 'live' AND (last_scan_at IS NULL OR last_scan_at < ?)`)
    .bind(new Date(scheduledTime - 20 * 60 * 60 * 1000).toISOString())
    .first<{ n: number }>();
  return (stale?.n ?? 0) > 0;
}
export const STATEMENTS_SCAN_HOUR_UTC = 7;

// ---- Vault helpers shared by templates ----

export async function ensureVaultEntry(env: Env, existingId: string | null, title: string): Promise<{ id: string; created: boolean }> {
  if (existingId) {
    const row = await env.DB.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'vault_entry'`).bind(existingId).first<{ id: string }>();
    if (row) return { id: row.id, created: false };
  }
  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
     VALUES (?, 'vault_entry', ?, NULL, NULL, 1, NULL, 0, ?, ?, ?, ?)`
  )
    .bind(id, title, ts, ts, ts, title)
    .run();
  return { id, created: true };
}

/** Quick Facts are Mike's: evergreen, hand-curated. Statements only seeds
 * a few evergreen facts when it first creates an entry, as ordinary facts
 * (no managed_key) — after that it never adds, edits, reorders or removes
 * a Quick Fact. Anything that changes lives in the auto note instead. */
export async function seedFacts(env: Env, entryId: string, facts: { label: string; value: string | null }[]): Promise<void> {
  const rows = facts.filter((f) => f.value);
  if (!rows.length) return;
  await env.DB.batch(
    rows.map((f, i) => {
      const det = detectFactValue(f.value);
      return env.DB.prepare('INSERT INTO vault_facts (id, entry_id, label, value, position, created_at, value_type, value_norm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        uid(), entryId, f.label, f.value, i, now(), det.type, det.norm
      );
    })
  );
  await reindexEntry({ env }, entryId);
}

/** One reminder task per (purpose, year): created once, kept current while
 * open, never resurrected after Mike completes it, removed when no longer
 * needed. Returns the task id to remember (or null). */
export async function syncReminderTask(
  env: Env,
  existing: { year: number; taskId: string } | undefined,
  year: number,
  want: { title: string; due: string; parentId: string | null } | null
): Promise<{ year: number; taskId: string } | undefined> {
  const cur = existing && existing.year === year ? await env.DB.prepare('SELECT id, status, title, due_date FROM entities WHERE id = ?').bind(existing.taskId).first<{ id: string; status: string | null; title: string; due_date: string | null }>() : null;
  if (!want) {
    if (cur && cur.status !== 'done') await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(cur.id).run();
    return cur && cur.status === 'done' ? existing : undefined;
  }
  if (cur) {
    if (cur.status !== 'done' && (cur.title !== want.title || cur.due_date !== want.due)) {
      await env.DB.prepare('UPDATE entities SET title = ?, due_date = ?, updated_at = ? WHERE id = ?').bind(want.title, want.due, now(), cur.id).run();
    }
    return existing;
  }
  if (existing && existing.year === year) return existing; // Mike deleted it — don't nag with a new one
  const taskId = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text)
     VALUES (?, 'task', ?, ?, 0, 'open', 0, ?, ?, ?, ?, ?)`
  )
    .bind(taskId, want.title, want.parentId, want.due, ts, ts, ts, want.title)
    .run();
  return { year, taskId };
}

/** Recomputes a folder's flags from the full set of current conditions. */
export async function syncFlags(env: Env, folderId: string, flags: { key: string; severity: 'warn' | 'info'; message: string }[]): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id, dedupe_key, message, resolved_at FROM statement_flags WHERE folder_row_id = ?')
    .bind(folderId)
    .all<{ id: string; dedupe_key: string; message: string; resolved_at: string | null }>();
  const byKey = new Map((results ?? []).map((r) => [r.dedupe_key, r]));
  const wanted = new Set(flags.map((f) => f.key));
  const stmts: D1PreparedStatement[] = [];
  for (const f of flags) {
    const cur = byKey.get(f.key);
    if (!cur) {
      stmts.push(
        env.DB.prepare('INSERT INTO statement_flags (id, folder_row_id, dedupe_key, severity, message, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(uid(), folderId, f.key, f.severity, f.message, now())
      );
    } else if (cur.resolved_at || cur.message !== f.message) {
      stmts.push(env.DB.prepare('UPDATE statement_flags SET message = ?, severity = ?, resolved_at = NULL WHERE id = ?').bind(f.message, f.severity, cur.id));
    }
  }
  for (const [key, row] of byKey) {
    if (!wanted.has(key) && !row.resolved_at) stmts.push(env.DB.prepare('UPDATE statement_flags SET resolved_at = ? WHERE id = ?').bind(now(), row.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---- Auto-updated Vault children: one "Account Details" note + Links ----
// Ids and bookkeeping live in the caller's meta. Mike's changes win:
//  - the note's TITLE is set once and never touched again;
//  - in the note, Statements only refreshes the sections it owns (matched
//    by their level-2 heading); everything else — edits to other sections,
//    added text, removed lines — is left exactly as Mike left it. An owned
//    section Mike deletes stays deleted;
//  - links are created once; only "live" links (e.g. Latest Statement)
//    keep their URL/title current. Deleted ones stay deleted.

export interface AutoSection {
  key: string;
  /** Does an existing level-2 heading belong to this section? */
  match: (headingText: string) => boolean;
  heading: string;
  blocks: Block[];
}

export interface AutoNoteState {
  noteId?: string;
  written?: string[]; // section keys ever written (so a deletion is respected)
}

type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string };
const nodeText = (n: PMNode): string => (n.text ?? '') + (n.content ?? []).map(nodeText).join('');
const isH2 = (n: PMNode) => n.type === 'heading' && (n.attrs?.level ?? 0) === 2;

export async function syncAutoNote(
  env: Env,
  entryId: string,
  state: AutoNoteState | undefined,
  title: string,
  intro: Block[],
  sections: AutoSection[]
): Promise<AutoNoteState> {
  const ts = now();
  const written = new Set(state?.written ?? []);
  const sectionNodes = (sec: AutoSection) => markAuto([heading(2, sec.heading), ...sec.blocks]) as PMNode[];

  if (state?.noteId) {
    const cur = await env.DB.prepare('SELECT title, content FROM entities WHERE id = ?').bind(state.noteId).first<{ title: string; content: string | null }>();
    if (!cur) return { ...state, written: [...written] }; // deleted by Mike — leave it gone
    let docNode: PMNode;
    try {
      docNode = cur.content ? JSON.parse(cur.content) : { type: 'doc', content: [] };
    } catch {
      return { ...state, written: [...written] }; // not ours to repair
    }
    const nodes: PMNode[] = docNode.content ?? [];
    let out: PMNode[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const sec = isH2(n) ? sections.find((s) => !seen.has(s.key) && s.match(nodeText(n))) : undefined;
      if (!sec) {
        out.push(n);
        continue;
      }
      seen.add(sec.key);
      out.push(...sectionNodes(sec));
      while (i + 1 < nodes.length && !isH2(nodes[i + 1])) i++; // drop the old body
    }
    // A section that has never been written (new for this account) is
    // appended; one written before but missing now was removed by Mike.
    for (const sec of sections) {
      if (!seen.has(sec.key) && !written.has(sec.key)) {
        out.push(...sectionNodes(sec));
        seen.add(sec.key);
      }
    }
    seen.forEach((k) => written.add(k));
    const content = JSON.stringify({ ...docNode, type: 'doc', content: out });
    if (content !== cur.content) {
      await env.DB.prepare('UPDATE entities SET content = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(content, `${cur.title} ${docText(content)}`, ts, state.noteId).run();
    }
    return { noteId: state.noteId, written: [...written] };
  }

  const content = doc([...intro, ...sections.flatMap((sec) => markAuto([heading(2, sec.heading), ...sec.blocks]))]);
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
     VALUES (?, 'note', ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?)`
  )
    .bind(id, title, content, entryId, ts, ts, ts, `${title} ${docText(content)}`)
    .run();
  return { noteId: id, written: sections.map((s) => s.key) };
}

/** Links are created once. `live: true` links (Latest Statement) keep
 * their URL and title current; the rest are never touched again. A null
 * url removes a link Statements created. Deleted links stay deleted. */
export async function syncManagedLinks(
  env: Env,
  entryId: string,
  existing: Record<string, string> | undefined,
  links: { key: string; title: string; url: string | null; live?: boolean }[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(existing ?? {}) };
  const ts = now();
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM entities WHERE parent_id = ? AND type = 'link'`).bind(entryId).first<{ m: number }>();
  let pos = (max?.m ?? -1) + 1;
  for (const l of links) {
    const id = out[l.key];
    if (!l.url) {
      if (id) await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(id).run();
      delete out[l.key];
      continue;
    }
    const content = JSON.stringify({ url: l.url, auto: l.live ? 'live' : 'once' });
    if (id) {
      const cur = await env.DB.prepare('SELECT title, content FROM entities WHERE id = ?').bind(id).first<{ title: string; content: string | null }>();
      if (!l.live) {
        // Created-once links: only tag one that still points where we put
        // it (pre-tag links) — never change a title or a URL Mike edited.
        if (cur?.content) {
          try {
            const m = JSON.parse(cur.content) as { url?: string; auto?: string };
            if (!m.auto && m.url === l.url) await env.DB.prepare('UPDATE entities SET content = ? WHERE id = ?').bind(content, id).run();
          } catch {
            // not ours to repair
          }
        }
        continue;
      }
      if (cur && (cur.title !== l.title || cur.content !== content)) {
        await env.DB.prepare('UPDATE entities SET title = ?, content = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(l.title, content, `${l.title} ${l.url}`, ts, id).run();
      }
      continue; // missing = deleted by Mike; leave it
    }
    const newId = uid();
    await env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'link', ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
    )
      .bind(newId, l.title, content, entryId, pos++, ts, ts, ts, `${l.title} ${l.url}`)
      .run();
    out[l.key] = newId;
  }
  return out;
}

/** The frontend origin (first ALLOWED_ORIGINS entry) for in-app links. */
export const appOrigin = (env: Env) => (env.ALLOWED_ORIGINS ?? 'https://mikeos.pages.dev').split(',')[0].trim();
