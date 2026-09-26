import { Hono } from 'hono';
import type { Env } from './types';

/** Contacts "Ask" — a rule-based (no LLM/API tokens) natural-language query
 * engine over contacts + voter_records. Mounted at /api/contacts/ask.
 *
 * This is deliberately NOT an AI feature: every recognized query shape is a
 * fixed regex/keyword pattern below, matched deterministically against
 * real columns (contacts.city/circle, voter_records.party/voter_age) —
 * matching how the rest of MikeOS gets its "smart" feel from plain rules,
 * not runtime AI calls. A query this can't parse into at least one filter
 * gets an honest "couldn't understand that" response rather than either
 * guessing or dumping the whole contact list.
 *
 * Two real limitations, both worth knowing before trusting a result:
 *  - Location only matches a city that's already an exact value somewhere
 *    in contacts.city (see worker/src/index.ts's ParsedContactRecord.city
 *    for where that gets populated at import time) — a query naming a city
 *    nobody's `city` field actually holds just won't recognize it, and
 *    silently drops that filter rather than erroring.
 *  - Party matching is pattern-based (LIKE, not an enum) since the actual
 *    stored values are a straight pass-through from whatever the source
 *    voter file's own PARTY column contains — see PARTY_PATTERNS below.
 */
export const contactsAssistantRouter = new Hono<{ Bindings: Env }>();

interface AgeFilter {
  min: number | null;
  max: number | null;
  label: string; // the original matched phrase, e.g. "under 25" — reused verbatim in the summary rather than reconstructed
}

const CIRCLE_PATTERNS: { re: RegExp; value: string; singular: string; plural: string }[] = [
  { re: /\bfriends?\b/i, value: 'friends', singular: 'friend', plural: 'friends' },
  { re: /\bfamily\b/i, value: 'family', singular: 'family member', plural: 'family members' },
  { re: /\bneighbo(?:u)?rs?\b/i, value: 'neighbors', singular: 'neighbor', plural: 'neighbors' },
  { re: /\bcommunity\b/i, value: 'community', singular: 'community contact', plural: 'community contacts' },
  { re: /\b(?:professionals?|colleagues?|co-?workers?)\b/i, value: 'professional', singular: 'professional contact', plural: 'professional contacts' },
];

// Pattern-matched, not an exact enum — the real `party` column is a
// straight pass-through from whatever the source voter file's PARTY column
// says (could be a 3-letter enrollment code like "REP", or a full word
// like "Republican", depending on the export), so each entry covers both
// shapes rather than assuming one. If a result set looks wrong for one of
// these, the fix is adding another LIKE pattern here, not rewriting the
// matching approach.
const PARTY_PATTERNS: { re: RegExp; likes: string[]; singular: string; plural: string }[] = [
  { re: /\brepublicans?\b|\bgop\b/i, likes: ['REP%', '%republic%'], singular: 'Republican', plural: 'Republicans' },
  { re: /\bdemocrats?\b|\bdems\b/i, likes: ['DEM%', '%democrat%'], singular: 'Democrat', plural: 'Democrats' },
  { re: /\bconservatives?\b/i, likes: ['CON%', '%conservative%'], singular: 'Conservative', plural: 'Conservatives' },
  { re: /\bworking\s*families?\b/i, likes: ['WOR%', '%working famil%'], singular: 'Working Families member', plural: 'Working Families members' },
  { re: /\bgreens?\b/i, likes: ['GRE%', '%green%'], singular: 'Green', plural: 'Greens' },
  { re: /\bindependents?\b|\bunaffiliated\b|\bblanks?\b/i, likes: ['%independ%', '%unaffil%', 'BLANK', 'OTH', 'OTHER'], singular: 'independent', plural: 'independents' },
];

function extractAge(query: string): AgeFilter | null {
  let m = query.match(/between\s+(\d{1,3})\s+and\s+(\d{1,3})/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]), label: m[0] };
  m = query.match(/(?:under|younger than|below)\s+(\d{1,3})/i);
  if (m) return { min: null, max: Number(m[1]) - 1, label: m[0] };
  m = query.match(/(?:over|older than|above)\s+(\d{1,3})/i);
  if (m) return { min: Number(m[1]) + 1, max: null, label: m[0] };
  m = query.match(/\bage\s+(\d{1,3})\b/i) ?? query.match(/\b(\d{1,3})\s*(?:years old|yo)\b/i);
  if (m) {
    const n = Number(m[1]);
    return { min: n, max: n, label: m[0] };
  }
  return null;
}

function extractCircle(query: string) {
  return CIRCLE_PATTERNS.find((p) => p.re.test(query)) ?? null;
}

function extractParty(query: string) {
  return PARTY_PATTERNS.find((p) => p.re.test(query)) ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest known city wins (so a query containing "New Bedford" doesn't
// match the shorter "Bedford" instead), word-boundary matched so "Bedford"
// doesn't fire on "Bedfordshire" or similar.
function extractCity(query: string, knownCities: string[]): string | null {
  const candidates = knownCities
    .filter((city) => new RegExp(`\\b${escapeRegex(city)}\\b`, 'i').test(query))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

interface ContactMatchRow {
  id: string;
  name: string;
  city: string | null;
  circle: string;
  party: string | null;
  voter_age: number | null;
}

contactsAssistantRouter.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'A question is required' }, 400);

  const { results: cityRows } = await c.env.DB.prepare("SELECT DISTINCT city FROM contacts WHERE city IS NOT NULL AND city != ''").all<{
    city: string;
  }>();
  const knownCities = (cityRows ?? []).map((r) => r.city);

  const age = extractAge(q);
  const circle = extractCircle(q);
  const party = extractParty(q);
  const city = extractCity(q, knownCities);

  if (!age && !circle && !party && !city) {
    return c.json({
      understood: [],
      summary: 'Couldn’t pick out a location, party, age, or circle from that — try something like "friends in Bedford" or "Republicans under 30".',
      count: 0,
      contacts: [],
    });
  }

  const conditions: string[] = [];
  const binds: unknown[] = [];
  const understood: string[] = [];
  // Age/party only mean anything for a voter-linked contact — an inner
  // join when either is present so a contact with no voter record can't
  // match a party/age filter it has no data for at all; a location/circle-
  // only query stays a left join so it still reaches personal contacts who
  // were never in the voter file.
  const needsVoterJoin = !!age || !!party;

  if (city) {
    conditions.push('LOWER(c.city) = LOWER(?)');
    binds.push(city);
    understood.push(`city: ${city}`);
  }
  if (circle) {
    conditions.push('c.circle = ?');
    binds.push(circle.value);
    understood.push(`circle: ${circle.value}`);
  }
  if (party) {
    conditions.push(`(${party.likes.map(() => 'v.party LIKE ?').join(' OR ')})`);
    binds.push(...party.likes);
    understood.push(`party: ${party.plural}`);
  }
  if (age) {
    if (age.min != null) {
      conditions.push('v.voter_age >= ?');
      binds.push(age.min);
    }
    if (age.max != null) {
      conditions.push('v.voter_age <= ?');
      binds.push(age.max);
    }
    understood.push(`age: ${age.label}`);
  }

  const join = needsVoterJoin ? 'JOIN voter_records v ON v.contact_id = c.id' : 'LEFT JOIN voter_records v ON v.contact_id = c.id';
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.city, c.circle, v.party, v.voter_age
     FROM contacts c ${join} ${where}
     ORDER BY c.name`
  )
    .bind(...binds)
    .all<ContactMatchRow>();
  const rows = results ?? [];

  // Builds a sentence close to how Mike actually phrased his example
  // queries ("You have 3 friends in Salem", "You have 79 Republicans under
  // 25 in Bedford") rather than just echoing the parsed filters back —
  // `understood` above is the literal, always-accurate readout for when
  // this summary's phrasing and the real filters ever diverge.
  const subject = party ? (rows.length === 1 ? party.singular : party.plural) : circle ? (rows.length === 1 ? circle.singular : circle.plural) : rows.length === 1 ? 'contact' : 'contacts';
  const circleQualifier = party && circle ? ` who ${rows.length === 1 ? 'is' : 'are'} also ${circle.plural}` : '';
  const ageClause = age ? ` ${age.label}` : '';
  const cityClause = city ? ` in ${city}` : '';
  const summary = `You have ${rows.length} ${subject}${circleQualifier}${ageClause}${cityClause}.`;

  return c.json({
    understood,
    summary,
    count: rows.length,
    contacts: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, circle: r.circle, party: r.party, voterAge: r.voter_age })),
  });
});
