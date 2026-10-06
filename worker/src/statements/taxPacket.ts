import type { Env } from '../types';
import { ensureVaultEntry, syncManagedFacts, syncManagedLinks, syncManagedNote } from './engine';
import { bullets, doc, docText, heading, italic, para } from './vaultDoc';
import type { Block } from './vaultDoc';

/** "Tax Packet · <year>" — one Vault entry per tax year, composed from a
 * section per live statements folder. Same Vault architecture as account
 * notes: headline totals as Quick Facts, tax documents as Links, and one
 * auto-updated "Tax Items" note with the expected-documents checklist and
 * every account's section. */

export interface TaxSection {
  title: string;
  facts: { key: string; label: string; value: string | null }[];
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
  let children: { noteId?: string; links?: Record<string, string> } = row?.children_json && !entry.created ? JSON.parse(row.children_json) : {};

  // Only folders still registered + live keep a section.
  const { results } = await env.DB.prepare(`SELECT id FROM statement_folders WHERE status = 'live'`).all<{ id: string }>();
  const live = new Set((results ?? []).map((r) => r.id));
  const ordered = Object.entries(sections)
    .filter(([id]) => live.has(id))
    .sort(([, a], [, b]) => a.title.localeCompare(b.title));

  // Facts written before this layout used per-template prefixes — clear them.
  await env.DB.prepare(`DELETE FROM vault_facts WHERE entry_id = ? AND managed_key IS NOT NULL AND managed_key NOT LIKE 'tax:%'`).bind(entry.id).run();
  await syncManagedFacts(
    env,
    entry.id,
    ordered.flatMap(([id, sec]) => sec.facts.map((f) => ({ ...f, key: `${id}:${f.key}` }))),
    'tax:'
  );

  const expected = ordered.flatMap(([, sec]) => sec.expected);
  const blocks: Block[] = [
    para([italic(`Built automatically from the statement folders in Drive — edits here are overwritten. Add your own notes (accountant, other forms) as a separate note.`)]),
    heading(2, 'Expected Documents'),
    expected.length ? bullets(expected.map((e) => `${e.received ? '✓' : '☐'} ${e.label}${e.received ? '' : ' — not received yet'}`)) : para('None yet.'),
    ...ordered.flatMap(([, sec]) => [heading(2, sec.title), ...sec.blocks]),
  ];
  const noteJson = doc(blocks);
  children.noteId = await syncManagedNote(env, entry.id, children.noteId, `Tax Items · ${year} · Auto-Updated`, noteJson, docText(noteJson));
  children.links = await syncManagedLinks(
    env,
    entry.id,
    children.links,
    ordered.flatMap(([id, sec]) => sec.links.map((l) => ({ ...l, key: `${id}:${l.key}` })))
  );

  await env.DB.prepare(
    `INSERT INTO statement_tax_packets (year, vault_entry_id, sections_json, children_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET vault_entry_id = excluded.vault_entry_id, sections_json = excluded.sections_json, children_json = excluded.children_json`
  )
    .bind(year, entry.id, JSON.stringify(sections), JSON.stringify(children))
    .run();
}
