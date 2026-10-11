import type { Env } from '../types';

/** Bee subscribers ↔ Contacts (Mike, 2026-10-10). Every current subscriber
 * is linked to a contact automatically:
 *   1. a contact carrying the same email (Mike's own cards first, then
 *      voter-roll entries);
 *   2. else exactly one of Mike's own cards with the same full name — the
 *      email is added only if that card has none (fills a blank);
 *   3. else a new contact (Substack's name, or the email until renamed).
 * Nothing on an existing card is overwritten. The "Bee" label is automatic
 * (not stored): it shows while the linked subscriber is in the newest
 * export and disappears once they leave. Mike's own Author row is skipped. */

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function emailsOf(json: string): string[] {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => (typeof x === 'string' ? (x.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()) : []));
  } catch {
    return [];
  }
}

const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Same rule as Contacts' tidyNameCase: only all-lowercase names are
 * Title-Cased; anything with a capital, @ or digit is left alone. */
function tidyName(name: string): string {
  const t = name.trim();
  if (!/[a-z]/.test(t) || /[@\d]/.test(t) || t !== t.toLowerCase()) return t;
  return t
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/(^|['-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()))
    .join(' ');
}

export interface LinkResult {
  linked: number;
  matchedEmail: number;
  matchedName: number;
  created: number;
}

export async function linkBeeContacts(env: Env): Promise<LinkResult> {
  const out: LinkResult = { linked: 0, matchedEmail: 0, matchedName: 0, created: 0 };
  const { results: subs } = await env.DB.prepare(
    `SELECT email, name, contact_id FROM bee_subscribers WHERE active = 1 AND lower(COALESCE(type, '')) != 'author'`
  ).all<{ email: string; name: string | null; contact_id: string | null }>();
  if (!subs?.length) return out;

  const { results: contacts } = await env.DB.prepare(`SELECT id, name, emails, source FROM contacts`).all<{ id: string; name: string; emails: string; source: string }>();
  const byId = new Map((contacts ?? []).map((c) => [c.id, c]));
  const byEmail = new Map<string, { id: string; personal: boolean }>();
  const byName = new Map<string, string[]>();
  for (const c of contacts ?? []) {
    const personal = c.source !== 'voter_file';
    for (const e of emailsOf(c.emails)) {
      const cur = byEmail.get(e);
      if (!cur || (personal && !cur.personal)) byEmail.set(e, { id: c.id, personal });
    }
    if (personal) {
      const k = normName(c.name);
      if (k.includes(' ')) byName.set(k, [...(byName.get(k) ?? []), c.id]);
    }
  }

  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  for (const s of subs) {
    if (s.contact_id === 'none') continue; // Mike deleted that contact — leave it deleted
    const current = s.contact_id ? byId.get(s.contact_id) : undefined;
    if (current) {
      // A contact MikeOS created with only the email as its name takes
      // Substack's name once one appears (still Mike's to rename).
      if (s.name && current.name.trim().toLowerCase() === s.email) {
        stmts.push(env.DB.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').bind(tidyName(s.name), ts, current.id));
      }
      continue;
    }
    let contactId: string | null = byEmail.get(s.email)?.id ?? null;
    if (contactId) out.matchedEmail++;
    else if (s.name) {
      const same = byName.get(normName(s.name)) ?? [];
      if (same.length === 1) {
        contactId = same[0];
        out.matchedName++;
        const c = byId.get(contactId)!;
        if (!emailsOf(c.emails).length) stmts.push(env.DB.prepare('UPDATE contacts SET emails = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([s.email]), ts, c.id));
      }
    }
    if (!contactId) {
      contactId = uid();
      out.created++;
      const name = s.name ? tidyName(s.name) : s.email;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO contacts (id, name, circle, emails, phones, pinned, source, created_at, updated_at, labels) VALUES (?, ?, 'other', ?, '[]', 0, 'bee', ?, ?, '[]')`
        ).bind(contactId, name, JSON.stringify([s.email]), ts, ts)
      );
      byEmail.set(s.email, { id: contactId, personal: true });
    }
    out.linked++;
    stmts.push(env.DB.prepare('UPDATE bee_subscribers SET contact_id = ? WHERE email = ?').bind(contactId, s.email));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return out;
}
