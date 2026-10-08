import type { Env } from '../types';
import { appOrigin, ensureVaultEntry, syncAutoNote, syncManagedLinks, syncReminderTask } from './engine';
import type { AutoNoteState, AutoSection } from './engine';
import { bullets, para } from './vaultDoc';
import type { Block } from './vaultDoc';

/** "Tax Packet · <year>" — one Vault entry per tax year, composed from a
 * section per live statements folder. Same rules as account entries:
 * Quick Facts are Mike's (none are written); tax documents are Links; one
 * "Tax Items" note whose owned sections (Expected Documents + one per
 * account) refresh nightly — anything else Mike writes there is kept. */

export interface TaxSection {
  title: string;
  blocks: Block[];
  expected: { label: string; received: boolean }[];
  links: { key: string; title: string; url: string | null }[];
}

interface PacketRow {
  year: number;
  vault_entry_id: string;
  sections_json: string | null;
  children_json: string | null;
}

export async function syncTaxPacketSection(env: Env, year: number, folderId: string, section: TaxSection): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM statement_tax_packets WHERE year = ?').bind(year).first<PacketRow>();
  const entry = await ensureVaultEntry(env, row?.vault_entry_id ?? null, `Tax Packet · ${year}`);
  const sections: Record<string, TaxSection> = row?.sections_json ? JSON.parse(row.sections_json) : {};
  sections[folderId] = section;
  const children: { noteId?: string; note?: AutoNoteState; links?: Record<string, string> } = row?.children_json && !entry.created ? JSON.parse(row.children_json) : {};

  // Only folders still live keep a section.
  const { results } = await env.DB.prepare(`SELECT id FROM statement_folders WHERE status = 'live'`).all<{ id: string }>();
  const live = new Set((results ?? []).map((r) => r.id));
  const ordered = Object.entries(sections)
    .filter(([id]) => live.has(id))
    .sort(([, a], [, b]) => a.title.localeCompare(b.title));

  const expected = ordered.flatMap(([, sec]) => sec.expected);
  const autoSections: AutoSection[] = [
    {
      key: 'expected',
      match: (h) => /^Expected Documents$/i.test(h.trim()),
      heading: 'Expected Documents',
      blocks: [expected.length ? bullets(expected.map((e) => `${e.received ? '✓' : '☐'} ${e.label}${e.received ? '' : ' — not received yet'}`)) : para('None yet.')],
    },
    ...ordered.map(([id, sec]) => ({ key: `folder:${id}`, match: (h: string) => h.trim() === sec.title, heading: sec.title, blocks: sec.blocks })),
  ];
  const legacy = children.noteId ? { noteId: children.noteId, written: autoSections.map((s) => s.key) } : undefined;
  children.note = await syncAutoNote(env, entry.id, children.note ?? legacy, `Tax Items · ${year}`, [], autoSections);
  delete children.noteId;
  children.links = await syncManagedLinks(
    env,
    entry.id,
    children.links,
    ordered.flatMap(([id, sec]) => sec.links.map((l) => ({ ...l, key: `${id}:${l.key}`, live: true })))
  );

  await env.DB.prepare(
    `INSERT INTO statement_tax_packets (year, vault_entry_id, sections_json, children_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET vault_entry_id = excluded.vault_entry_id, sections_json = excluded.sections_json, children_json = excluded.children_json`
  )
    .bind(year, entry.id, JSON.stringify(sections), JSON.stringify(children))
    .run();
}

/** Yearly "File <year> Taxes" task (Mike, 2026-10-08): created on January 2
 * of the following year, due March 1 (time for the year-end statements
 * and tax forms to arrive and to book the accountant), filed under that
 * year's Tax Packet with a link to it as an attachment. One per year: kept
 * current while open, never re-created once Mike checks it off or deletes
 * it, and not created at all once March 1 has passed (that year is
 * already being handled). Packets themselves are kept for audits. Runs
 * after the nightly statements scan. */
export async function syncTaxFilingTask(env: Env, today: string): Promise<void> {
  const year = Number(today.slice(0, 4)) - 1;
  const due = `${year + 1}-03-01`;
  if (today < `${year + 1}-01-02`) return;
  const row = await env.DB.prepare('SELECT * FROM statement_tax_packets WHERE year = ?').bind(year).first<PacketRow>();
  if (!row) return; // no packet for that year — nothing to point at
  const children: Record<string, unknown> = row.children_json ? JSON.parse(row.children_json) : {};
  const existing = children.fileTask as { year: number; taskId: string } | undefined;
  if (!existing && today > due) return;
  const packet = await env.DB.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'vault_entry'`).bind(row.vault_entry_id).first<{ id: string }>();
  const next = await syncReminderTask(env, existing, year, { title: `File ${year} Taxes`, due, parentId: packet?.id ?? null });
  // Attach the packet as a link the first time the task is made.
  if (next && next.taskId !== existing?.taskId && packet) {
    const url = `${appOrigin(env)}/vault/${packet.id}`;
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'link', ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), `Tax Packet · ${year}`, JSON.stringify({ url, auto: 'once' }), next.taskId, ts, ts, ts, `Tax Packet · ${year} ${url}`)
      .run();
  }
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    if (next) children.fileTask = next;
    else delete children.fileTask;
    await env.DB.prepare('UPDATE statement_tax_packets SET children_json = ? WHERE year = ?').bind(JSON.stringify(children), year).run();
  }
}
