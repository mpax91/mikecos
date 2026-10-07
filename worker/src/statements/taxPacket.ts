import type { Env } from '../types';
import { ensureVaultEntry, syncAutoNote, syncManagedLinks } from './engine';
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
