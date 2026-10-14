import { Hono } from 'hono';
import type { Env } from '../types';
import type { ParsedMeeting } from '../ics';
import { isMe, parseMeetingSummary, type ParsedAction } from './gemini';
import { firstName, meetingNoteTemplate, noteLines, scanNoteActions } from './noteScan';
import { contactRealmSql, realmMatches, realmOf, realmSql, workLabel, type Realm, type RealmFilter } from './realm';
import { extractRecord, markdownToPlain, markdownToTiptap, threadSourceLabel, type MeetingRecord } from './record';

/** Work features (migration 0106) — mounted at /api/work.
 *
 *  - Meetings Mike enters by hand (`meeting_series`), merged into every
 *    calendar view through a synthetic ICS feed (`seriesFeedSource`).
 *  - People on a meeting (Contacts), meeting summaries pasted from Gemini
 *    (`meeting_summaries`) and their next steps (`meeting_actions`) → tasks
 *    for Mike or Waiting items on someone else.
 *  - Morning-of meeting prep, a person's open items, and the Monday / Friday
 *    briefs. All rule-based — no AI. */
export const workRouter = new Hono<{ Bindings: Env }>();

const HOME_TZ = 'America/New_York';
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: HOME_TZ });
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const localDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: HOME_TZ });
const ARCHIVED_TREE_CTE = `WITH RECURSIVE archived_tree(id) AS (
  SELECT id FROM entities WHERE is_top_level = 1 AND status = 'archived'
  UNION ALL
  SELECT e.id FROM entities e JOIN archived_tree a ON e.parent_id = a.id
)`;
const NOT_ARCHIVED = `id NOT IN (SELECT id FROM archived_tree)`;

/** Meetings come from index.ts (Google feeds + the series feed) — injected
 * to avoid a circular import. */
type MeetingLoader = (db: D1Database, start: string, end: string) => Promise<(ParsedMeeting & { date: string })[]>;
let loadMeetings: MeetingLoader = async () => [];
export function setMeetingLoader(fn: MeetingLoader): void {
  loadMeetings = fn;
}

// ---------------------------------------------------------------------------
// Meeting series → synthetic ICS feed
// ---------------------------------------------------------------------------

interface SeriesRow {
  id: string;
  title: string;
  realm: string;
  start_date: string;
  start_time: string | null;
  duration_min: number;
  rrule: string | null;
  until_date: string | null;
  skip_dates: string;
  location: string | null;
  link: string | null;
  project_id: string | null;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
const compactDate = (iso: string) => iso.replace(/-/g, '');
const compactTime = (hhmm: string) => hhmm.replace(':', '') + '00';

/** Wall-clock (America/New_York) → UTC instant, DST-safe. */
function easternToUtc(dateIso: string, hhmm: string): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOME_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return new Date(guess - (asLocal - guess));
}

/** Add minutes to a wall-clock date+time, returning the new wall date+time. */
function wallAdd(dateIso: string, hhmm: string, minutes: number): { date: string; time: string } {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + minutes));
  return { date: t.toISOString().slice(0, 10), time: t.toISOString().slice(11, 16) };
}

const toUtcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function seriesToVevent(s: SeriesRow): string[] {
  const out = ['BEGIN:VEVENT', `UID:ms-${s.id}`, `SUMMARY:${icsEscape(s.title || 'Meeting')}`];
  const skips = safeJsonArray(s.skip_dates);
  if (s.start_time) {
    const end = wallAdd(s.start_date, s.start_time, Math.max(5, s.duration_min || 30));
    out.push(`DTSTART;TZID=${HOME_TZ}:${compactDate(s.start_date)}T${compactTime(s.start_time)}`);
    out.push(`DTEND;TZID=${HOME_TZ}:${compactDate(end.date)}T${compactTime(end.time)}`);
    for (const d of skips) out.push(`EXDATE;TZID=${HOME_TZ}:${compactDate(d)}T${compactTime(s.start_time)}`);
  } else {
    out.push(`DTSTART;VALUE=DATE:${compactDate(s.start_date)}`);
    out.push(`DTEND;VALUE=DATE:${compactDate(addDays(s.start_date, 1))}`);
    for (const d of skips) out.push(`EXDATE;VALUE=DATE:${compactDate(d)}`);
  }
  if (s.rrule) {
    let rule = s.rrule.replace(/^RRULE:/i, '').trim();
    if (s.until_date && !/UNTIL=|COUNT=/i.test(rule)) {
      const until = s.start_time ? easternToUtc(s.until_date, '23:59') : new Date(`${s.until_date}T23:59:59Z`);
      rule += `;UNTIL=${toUtcStamp(until)}`;
    }
    out.push(`RRULE:${rule}`);
  }
  if (s.location) out.push(`LOCATION:${icsEscape(s.location)}`);
  const desc = [s.link, s.description].filter(Boolean).join('\n');
  if (desc) out.push(`DESCRIPTION:${icsEscape(desc)}`);
  out.push('END:VEVENT');
  return out;
}

export async function seriesFeedSource(db: D1Database): Promise<{ ics: string; calendar: string; calendarId: string } | null> {
  const { results } = await db.prepare(`SELECT * FROM meeting_series WHERE active = 1`).all<SeriesRow>().catch(() => ({ results: [] as SeriesRow[] }));
  if (!results?.length) return null;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MikeOS//Meetings//EN'];
  for (const s of results) lines.push(...seriesToVevent(s));
  lines.push('END:VCALENDAR');
  return { ics: lines.join('\r\n'), calendar: MANUAL_CALENDAR, calendarId: '' };
}
export const MANUAL_CALENDAR = 'mikeos';

function safeJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Enriching meetings: realm, series, people, notes, summaries
// ---------------------------------------------------------------------------

export interface PersonRef {
  id: string;
  name: string;
}

export type EnrichedMeeting<T extends ParsedMeeting = ParsedMeeting> = T & {
  hasNote: boolean;
  realm: Realm;
  seriesKey: string;
  seriesId: string | null;
  recurring: boolean;
  people: PersonRef[];
  summaryCount: number;
  pendingActions: number;
  projectId: string | null;
  docs: MeetingDoc[];
  /** The link to join: a hand-entered series' Video Link, else the invite's
   * Meet / Zoom / Teams / Webex link. null when there isn't one. */
  joinUrl: string | null;
};
const VIDEO_LINK = /meet\.google|zoom\.us|teams\.microsoft|teams\.live|webex/i;

/** 'ms-abc:2026-10-13T14:00:00.000Z' → 'ms-abc'; an ICS uid has no colon. */
export function seriesKeyOf(meetingId: string): string {
  const i = meetingId.indexOf(':');
  return i === -1 ? meetingId : meetingId.slice(0, i);
}

async function inChunks<T>(ids: string[], fn: (chunk: string[], ph: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    out.push(...(await fn(chunk, chunk.map(() => '?').join(','))));
  }
  return out;
}

export async function enrichMeetings<T extends ParsedMeeting>(db: D1Database, meetings: T[], realm: RealmFilter): Promise<EnrichedMeeting<T>[]> {
  if (meetings.length === 0) return [];
  const ids = [...new Set(meetings.map((m) => m.id))];
  const keys = [...new Set(meetings.map((m) => seriesKeyOf(m.id)))];
  const seriesIds = keys.filter((k) => k.startsWith('ms-')).map((k) => k.slice(3));

  const [feeds, series, notes, summaries, pending, seriesPeople, docRows] = await Promise.all([
    db.prepare(`SELECT id, realm FROM calendar_feeds`).all<{ id: string; realm: string }>(),
    inChunks(seriesIds, async (ch, ph) => (await db.prepare(`SELECT id, realm, rrule, project_id, link FROM meeting_series WHERE id IN (${ph})`).bind(...ch).all<{ id: string; realm: string; rrule: string | null; project_id: string | null; link: string | null }>()).results ?? []),
    inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT mn.meeting_id FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id WHERE mn.meeting_id IN (${ph})`).bind(...ch).all<{ meeting_id: string }>()).results ?? []),
    inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT meeting_id, COUNT(*) AS n FROM meeting_summaries WHERE source != 'own_note' AND meeting_id IN (${ph}) GROUP BY meeting_id`).bind(...ch).all<{ meeting_id: string; n: number }>()).results ?? []),
    inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT meeting_id, COUNT(*) AS n FROM meeting_actions WHERE status = 'pending' AND meeting_id IN (${ph}) GROUP BY meeting_id`).bind(...ch).all<{ meeting_id: string; n: number }>()).results ?? []),
    inChunks(seriesIds, async (ch, ph) => (await db.prepare(`SELECT sp.series_id, c.id, c.name FROM meeting_series_people sp JOIN contacts c ON c.id = sp.contact_id WHERE sp.series_id IN (${ph}) ORDER BY sp.position, c.name`).bind(...ch).all<{ series_id: string; id: string; name: string }>()).results ?? []),
    inChunks(keys, async (ch, ph) => (await db.prepare(`SELECT * FROM meeting_docs WHERE series_key IN (${ph}) ORDER BY position, created_at`).bind(...ch).all<DocRow>()).results ?? []).catch(() => [] as DocRow[]),
  ]);
  const docsByKey = new Map<string, MeetingDoc[]>();
  for (const d of docRows) {
    const list = docsByKey.get(d.series_key) ?? [];
    list.push(docJson(d));
    docsByKey.set(d.series_key, list);
  }
  const feedRealm = new Map((feeds.results ?? []).map((f) => [f.id, f.realm || 'personal']));
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const hasNote = new Set(notes.map((n) => n.meeting_id));
  const summaryN = new Map(summaries.map((s) => [s.meeting_id, s.n]));
  const pendingN = new Map(pending.map((s) => [s.meeting_id, s.n]));
  const peopleBySeries = new Map<string, PersonRef[]>();
  for (const p of seriesPeople) {
    const list = peopleBySeries.get(p.series_id) ?? [];
    list.push({ id: p.id, name: p.name });
    peopleBySeries.set(p.series_id, list);
  }

  // Google invites: match attendee emails to Contacts.
  const emails = [...new Set(meetings.filter((m) => !seriesKeyOf(m.id).startsWith('ms-')).flatMap((m) => m.attendees.map((a) => a.email.toLowerCase())))];
  const byEmail = new Map<string, PersonRef>();
  if (emails.length) {
    const rows = await inChunks(emails, async (ch, ph) =>
      (
        await db
          .prepare(`SELECT c.id, c.name, lower(j.value) AS email FROM contacts c, json_each(c.emails) j WHERE c.source != 'voter_file' AND lower(j.value) IN (${ph})`)
          .bind(...ch)
          .all<{ id: string; name: string; email: string }>()
      ).results ?? []
    );
    for (const r of rows) byEmail.set(r.email, { id: r.id, name: r.name });
  }

  const out: EnrichedMeeting<T>[] = [];
  for (const m of meetings) {
    const key = seriesKeyOf(m.id);
    const manual = key.startsWith('ms-') ? seriesById.get(key.slice(3)) : undefined;
    const r = (manual ? manual.realm : feedRealm.get(m.calendar)) === 'work' ? 'work' : 'personal';
    if (!realmMatches(realm, r)) continue;
    const people = manual
      ? peopleBySeries.get(manual.id) ?? []
      : [...new Map(m.attendees.map((a) => byEmail.get(a.email.toLowerCase())).filter((p): p is PersonRef => !!p).map((p) => [p.id, p])).values()];
    out.push({
      ...m,
      gcalUrl: manual ? null : m.gcalUrl,
      hasNote: hasNote.has(m.id),
      realm: r,
      seriesKey: key,
      seriesId: manual ? manual.id : null,
      recurring: manual ? !!manual.rrule : m.id.includes(':'),
      people,
      summaryCount: summaryN.get(m.id) ?? 0,
      pendingActions: pendingN.get(m.id) ?? 0,
      projectId: manual?.project_id ?? null,
      docs: docsByKey.get(key) ?? [],
      joinUrl: (manual ? manual.link?.trim() || null : null) ?? (m.links ?? []).find((l) => VIDEO_LINK.test(l)) ?? null,
    });
  }

  // Mike's own 📝 notes used to be read for next steps that then waited to
  // be sorted. Off since 2026-10-13 (notes-first: Mike highlights what he
  // wants to act on) — kept behind work_settings.note_scan = '1'.
  try {
    if ((await getSetting(db, 'note_scan', '0')) !== '1') return out;
    const read = await scanStaleNotes(db, out.filter((m) => m.hasNote));
    if (read.length) {
      const counts = await inChunks(read, async (ch, ph) => (await db.prepare(`SELECT meeting_id, COUNT(*) AS n FROM meeting_actions WHERE status = 'pending' AND meeting_id IN (${ph}) GROUP BY meeting_id`).bind(...ch).all<{ meeting_id: string; n: number }>()).results ?? []);
      const n = new Map(counts.map((x) => [x.meeting_id, x.n]));
      for (const m of out) if (read.includes(m.id)) m.pendingActions = n.get(m.id) ?? 0;
    }
  } catch (e) {
    console.error('meeting note scan failed', e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Documents on a meeting (migration 0113) — per series, so every occurrence
// of a recurring meeting shows the same doc (e.g. a 1:1's running doc).
// ---------------------------------------------------------------------------

export interface MeetingDoc {
  id: string;
  title: string;
  url: string;
  kind: string;
}
interface DocRow {
  id: string;
  series_key: string;
  title: string;
  url: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** What a link is, for the icon + a default name: Google Doc / Sheet /
 * Slides / Form / Drive, else 'link'. */
export function docKind(url: string): string {
  const m = /^https?:\/\/(docs|drive|sheets|slides)\.google\.com\/(\w+)/i.exec(url);
  if (!m) return 'link';
  const what = m[1].toLowerCase() === 'drive' ? 'drive' : m[2].toLowerCase();
  return { document: 'doc', spreadsheets: 'sheet', presentation: 'slides', forms: 'form', drive: 'drive', file: 'drive', open: 'drive' }[what] ?? 'drive';
}
const DOC_KIND_NAME: Record<string, string> = { doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides', form: 'Google Form', drive: 'Google Drive File' };
export function docDefaultTitle(url: string): string {
  const k = docKind(url);
  if (k !== 'link') return DOC_KIND_NAME[k];
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}
function docJson(d: DocRow): MeetingDoc {
  return { id: d.id, title: d.title || docDefaultTitle(d.url), url: d.url, kind: docKind(d.url) };
}
/** Accepts a full URL, or a bare 'docs.google.com/…' (adds https://).
 * Returns null for anything that isn't http(s). */
export function cleanDocUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z]+:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

workRouter.get('/docs', async (c) => {
  const key = (c.req.query('seriesKey') ?? '').trim();
  if (!key) return c.json({ error: 'seriesKey required' }, 400);
  const { results } = await c.env.DB.prepare('SELECT * FROM meeting_docs WHERE series_key = ? ORDER BY position, created_at').bind(key).all<DocRow>();
  return c.json({ docs: (results ?? []).map(docJson) });
});

workRouter.post('/docs', async (c) => {
  const b = await c.req.json<{ seriesKey?: string; url?: string; title?: string }>().catch(() => ({}) as { seriesKey?: string; url?: string; title?: string });
  const key = (b.seriesKey ?? '').trim();
  const url = cleanDocUrl(b.url);
  if (!key || key.length > 500) return c.json({ error: 'seriesKey required' }, 400);
  if (!url) return c.json({ error: 'Paste a link (https://…)' }, 400);
  const pos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM meeting_docs WHERE series_key = ?').bind(key).first<{ n: number }>();
  const row: DocRow = { id: uid(), series_key: key, title: (b.title ?? '').trim().slice(0, 200), url, position: pos?.n ?? 0, created_at: now(), updated_at: now() };
  await c.env.DB.prepare('INSERT INTO meeting_docs (id, series_key, title, url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.series_key, row.title, row.url, row.position, row.created_at, row.updated_at)
    .run();
  return c.json(docJson(row));
});

workRouter.patch('/docs/:id', async (c) => {
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare('SELECT * FROM meeting_docs WHERE id = ?').bind(id).first<DocRow>();
  if (!cur) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<{ url?: string; title?: string }>().catch(() => ({}) as { url?: string; title?: string });
  let url = cur.url;
  if (b.url !== undefined) {
    const u = cleanDocUrl(b.url);
    if (!u) return c.json({ error: 'Paste a link (https://…)' }, 400);
    url = u;
  }
  const title = b.title !== undefined ? String(b.title).trim().slice(0, 200) : cur.title;
  await c.env.DB.prepare('UPDATE meeting_docs SET url = ?, title = ?, updated_at = ? WHERE id = ?').bind(url, title, now(), id).run();
  return c.json(docJson({ ...cur, url, title }));
});

workRouter.delete('/docs/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM meeting_docs WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSetting(db: D1Database, key: string, fallback = ''): Promise<string> {
  const row = await db.prepare('SELECT value FROM work_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}
async function myNames(db: D1Database): Promise<string[]> {
  return (await getSetting(db, 'my_names', 'Mike'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function settingsJson(db: D1Database) {
  return {
    myNames: (await myNames(db)).join(', '),
    workLabel: await workLabel(db),
    noteTemplate: (await getSetting(db, 'note_template', '1')) !== '0',
    noteTip: (await getSetting(db, 'note_tip', '1')) !== '0',
  };
}

/** The body a new meeting 📝 note starts with — the Notes / Decisions /
 * Next Steps template (Settings → Meetings can turn it or its tip line off).
 * null = start blank. `people` = full names on the meeting. */
export async function meetingNoteStart(db: D1Database, people: string[]): Promise<{ content: string; text: string } | null> {
  if ((await getSetting(db, 'note_template', '1')) === '0') return null;
  const mine = await myNames(db);
  const me = firstName(mine[0] ?? 'Mike');
  const others = [...new Set(people.filter((n) => n.trim() && !isMe(n, mine) && !isMe(firstName(n), mine)).map(firstName))];
  const content = meetingNoteTemplate(me, others, (await getSetting(db, 'note_tip', '1')) !== '0');
  return { content, text: noteLines(content).map((l) => l.text).join(' ') };
}

workRouter.get('/settings', async (c) => c.json(await settingsJson(c.env.DB)));

workRouter.put('/settings', async (c) => {
  const body = await c.req.json<{ myNames?: string; workLabel?: string; noteTemplate?: boolean; noteTip?: boolean }>();
  const put = (key: string, value: string) =>
    c.env.DB.prepare(`INSERT INTO work_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
  if (typeof body.myNames === 'string') await put('my_names', body.myNames.trim());
  if (typeof body.workLabel === 'string' && body.workLabel.trim()) await put('work_label', body.workLabel.trim());
  if (typeof body.noteTemplate === 'boolean') await put('note_template', body.noteTemplate ? '1' : '0');
  if (typeof body.noteTip === 'boolean') await put('note_tip', body.noteTip ? '1' : '0');
  return c.json(await settingsJson(c.env.DB));
});

// ---------------------------------------------------------------------------
// Meeting series CRUD (Settings → Meetings)
// ---------------------------------------------------------------------------

async function seriesJson(db: D1Database, rows: SeriesRow[]) {
  const ids = rows.map((r) => r.id);
  const people = await inChunks(ids, async (ch, ph) =>
    (await db.prepare(`SELECT sp.series_id, c.id, c.name, c.title, c.company FROM meeting_series_people sp JOIN contacts c ON c.id = sp.contact_id WHERE sp.series_id IN (${ph}) ORDER BY sp.position, c.name`).bind(...ch).all<{ series_id: string; id: string; name: string; title: string | null; company: string | null }>()).results ?? []
  );
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((x): x is string => !!x))];
  const projects = await inChunks(projectIds, async (ch, ph) => (await db.prepare(`SELECT id, title FROM entities WHERE id IN (${ph})`).bind(...ch).all<{ id: string; title: string }>()).results ?? []);
  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    realm: r.realm,
    startDate: r.start_date,
    startTime: r.start_time,
    durationMin: r.duration_min,
    rrule: r.rrule,
    untilDate: r.until_date,
    skipDates: safeJsonArray(r.skip_dates),
    location: r.location,
    link: r.link,
    projectId: r.project_id,
    projectTitle: r.project_id ? projectTitle.get(r.project_id) ?? null : null,
    description: r.description,
    active: r.active === 1,
    people: people.filter((p) => p.series_id === r.id).map((p) => ({ id: p.id, name: p.name, title: p.title, company: p.company })),
  }));
}

interface SeriesBody {
  title?: string;
  realm?: string;
  startDate?: string;
  startTime?: string | null;
  durationMin?: number;
  rrule?: string | null;
  untilDate?: string | null;
  location?: string | null;
  link?: string | null;
  projectId?: string | null;
  description?: string | null;
  active?: boolean;
  peopleIds?: string[];
  skipDates?: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

async function setSeriesPeople(db: D1Database, seriesId: string, peopleIds: string[]) {
  const unique = [...new Set(peopleIds.filter((x) => typeof x === 'string' && x))];
  const stmts = [db.prepare('DELETE FROM meeting_series_people WHERE series_id = ?').bind(seriesId)];
  unique.forEach((cid, i) => stmts.push(db.prepare('INSERT INTO meeting_series_people (series_id, contact_id, position) VALUES (?, ?, ?)').bind(seriesId, cid, i)));
  await db.batch(stmts);
}

workRouter.get('/series', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM meeting_series WHERE 1=1${realmSql(realmOf(c))} ORDER BY active DESC, title COLLATE NOCASE`).all<SeriesRow>();
  return c.json({ series: await seriesJson(c.env.DB, results ?? []) });
});

workRouter.post('/series', async (c) => {
  const b = await c.req.json<SeriesBody>();
  const title = b.title?.trim();
  if (!title) return c.json({ error: 'Title is required' }, 400);
  if (!b.startDate || !DATE_RE.test(b.startDate)) return c.json({ error: 'Start date is required' }, 400);
  if (b.startTime && !TIME_RE.test(b.startTime)) return c.json({ error: 'Time must be HH:MM' }, 400);
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO meeting_series (id, title, realm, start_date, start_time, duration_min, rrule, until_date, skip_dates, location, link, project_id, description, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      title,
      b.realm === 'personal' ? 'personal' : 'work',
      b.startDate,
      b.startTime || null,
      Math.max(5, Math.round(Number(b.durationMin ?? 30))),
      b.rrule?.trim() || null,
      b.untilDate && DATE_RE.test(b.untilDate) ? b.untilDate : null,
      b.location?.trim() || null,
      b.link?.trim() || null,
      b.projectId || null,
      b.description?.trim() || null,
      b.active === false ? 0 : 1,
      ts,
      ts
    )
    .run();
  if (b.peopleIds) await setSeriesPeople(c.env.DB, id, b.peopleIds);
  const row = await c.env.DB.prepare('SELECT * FROM meeting_series WHERE id = ?').bind(id).first<SeriesRow>();
  return c.json((await seriesJson(c.env.DB, [row!]))[0], 201);
});

workRouter.patch('/series/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM meeting_series WHERE id = ?').bind(id).first<SeriesRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<SeriesBody>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (b.title !== undefined) set('title', b.title.trim() || existing.title);
  if (b.realm === 'work' || b.realm === 'personal') set('realm', b.realm);
  if (b.startDate !== undefined && DATE_RE.test(b.startDate)) set('start_date', b.startDate);
  if (b.startTime !== undefined) {
    if (b.startTime && !TIME_RE.test(b.startTime)) return c.json({ error: 'Time must be HH:MM' }, 400);
    set('start_time', b.startTime || null);
  }
  if (b.durationMin !== undefined) set('duration_min', Math.max(5, Math.round(Number(b.durationMin))));
  if (b.rrule !== undefined) set('rrule', b.rrule?.trim() || null);
  if (b.untilDate !== undefined) set('until_date', b.untilDate && DATE_RE.test(b.untilDate) ? b.untilDate : null);
  if (b.location !== undefined) set('location', b.location?.trim() || null);
  if (b.link !== undefined) set('link', b.link?.trim() || null);
  if (b.projectId !== undefined) set('project_id', b.projectId || null);
  if (b.description !== undefined) set('description', b.description?.trim() || null);
  if (b.active !== undefined) set('active', b.active ? 1 : 0);
  if (b.skipDates !== undefined) set('skip_dates', JSON.stringify([...new Set(b.skipDates.filter((d) => DATE_RE.test(d)))].sort()));
  if (sets.length) {
    set('updated_at', now());
    vals.push(id);
    await c.env.DB.prepare(`UPDATE meeting_series SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
  if (b.peopleIds) await setSeriesPeople(c.env.DB, id, b.peopleIds);
  const row = await c.env.DB.prepare('SELECT * FROM meeting_series WHERE id = ?').bind(id).first<SeriesRow>();
  return c.json((await seriesJson(c.env.DB, [row!]))[0]);
});

/** Cancel (or restore) one occurrence: { date, skip: true|false }. */
workRouter.post('/series/:id/skip', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<{ date: string; skip?: boolean }>();
  if (!DATE_RE.test(b.date ?? '')) return c.json({ error: 'date required' }, 400);
  const row = await c.env.DB.prepare('SELECT skip_dates FROM meeting_series WHERE id = ?').bind(id).first<{ skip_dates: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const set = new Set(safeJsonArray(row.skip_dates));
  if (b.skip === false) set.delete(b.date);
  else set.add(b.date);
  await c.env.DB.prepare('UPDATE meeting_series SET skip_dates = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([...set].sort()), now(), id).run();
  return c.json({ ok: true, skipDates: [...set].sort() });
});

workRouter.delete('/series/:id', async (c) => {
  const id = c.req.param('id');
  // Notes, summaries and tasks stay — they're Mike's records; only the
  // schedule goes.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM meeting_series_people WHERE series_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM meeting_series WHERE id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM meeting_docs WHERE series_key = ?').bind(`ms-${id}`),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Meeting summaries (Gemini) + next steps
// ---------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  meeting_id: string;
  series_key: string;
  occurrence_start: string;
  meeting_title: string;
  realm: string;
  note_entity_id: string | null;
  summary: string | null;
  details: string | null;
  decisions: string | null;
  raw_text: string;
  source: string;
  created_at: string;
  kind?: string | null;
  format?: string | null;
  record_json?: string | null;
  review_task_id?: string | null;
}
interface ActionRow {
  id: string;
  summary_id: string;
  meeting_id: string;
  series_key: string;
  text: string;
  owner_name: string | null;
  contact_id: string | null;
  is_mine: number;
  status: string;
  entity_id: string | null;
  created_at: string;
  confidence?: string | null;
  due_date?: string | null;
  record_action_id?: string | null;
  owner_email?: string | null;
}

async function actionsJson(db: D1Database, rows: ActionRow[]) {
  const entityIds = rows.map((r) => r.entity_id).filter((x): x is string => !!x);
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const [ents, cts] = await Promise.all([
    inChunks(entityIds, async (ch, ph) => (await db.prepare(`SELECT id, status, due_date FROM entities WHERE id IN (${ph})`).bind(...ch).all<{ id: string; status: string; due_date: string | null }>()).results ?? []),
    inChunks(contactIds, async (ch, ph) => (await db.prepare(`SELECT id, name FROM contacts WHERE id IN (${ph})`).bind(...ch).all<{ id: string; name: string }>()).results ?? []),
  ]);
  const ent = new Map(ents.map((e) => [e.id, e]));
  const ct = new Map(cts.map((x) => [x.id, x.name]));
  const ids = rows.map((r) => r.id);
  const withPrompt = new Set(
    (await inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT DISTINCT action_id FROM meeting_assists WHERE action_id IN (${ph})`).bind(...ch).all<{ action_id: string }>()).results ?? []).catch(() => [])).map((x) => x.action_id)
  );
  return rows.map((r) => {
    const e = r.entity_id ? ent.get(r.entity_id) : undefined;
    return {
      id: r.id,
      summaryId: r.summary_id,
      meetingId: r.meeting_id,
      text: r.text,
      ownerName: r.owner_name,
      contactId: r.contact_id,
      contactName: r.contact_id ? ct.get(r.contact_id) ?? null : null,
      isMine: r.is_mine === 1,
      status: r.status,
      entityId: e ? r.entity_id : null,
      entityDone: e ? e.status === 'done' : r.status === 'task' || r.status === 'waiting',
      dueDate: e?.due_date ?? (r.status === 'pending' || r.status === 'noted' ? r.due_date ?? null : null),
      confidence: r.confidence === 'implied' ? 'implied' : r.confidence === 'stated' ? 'stated' : null,
      hasPrompt: withPrompt.has(r.id),
    };
  });
}

function recordOf(s: SummaryRow): MeetingRecord | null {
  if (!s.record_json) return null;
  try {
    return JSON.parse(s.record_json) as MeetingRecord;
  } catch {
    return null;
  }
}

function summaryJson(s: SummaryRow) {
  const rec = recordOf(s);
  return {
    id: s.id,
    meetingId: s.meeting_id,
    seriesKey: s.series_key,
    start: s.occurrence_start,
    title: s.meeting_title,
    realm: s.realm,
    noteEntityId: s.note_entity_id,
    summary: s.summary ?? '',
    details: s.details ?? '',
    decisions: s.decisions ?? '',
    source: s.source,
    createdAt: s.created_at,
    kind: s.kind ?? null,
    tldr: rec?.tldr ?? [],
    attendeesConfirmed: rec?.meeting?.attendeesConfirmed ?? null,
    attendees: rec?.meeting?.attendees ?? rec?.thread?.participants ?? [],
    threadSource: rec?.thread?.source ?? null,
    threadChannel: rec?.thread?.channel ?? null,
  };
}

workRouter.get('/meetings/:meetingId/summaries', async (c) => {
  const meetingId = c.req.param('meetingId');
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ? ORDER BY created_at').bind(meetingId).all<SummaryRow>();
  const { results: acts } = await db.prepare('SELECT * FROM meeting_actions WHERE meeting_id = ? ORDER BY created_at, rowid').bind(meetingId).all<ActionRow>();
  const [items, assists] = await Promise.all([
    db.prepare(`SELECT * FROM meeting_items WHERE meeting_id = ? AND kind != 'ignored_person' ORDER BY created_at, position`).bind(meetingId).all<ItemRow>(),
    db.prepare('SELECT * FROM meeting_assists WHERE meeting_id = ? ORDER BY created_at, position').bind(meetingId).all<AssistRow>(),
  ]);
  const suggestions: { summaryId: string; name: string; email: string | null }[] = [];
  for (const s of (results ?? []).filter((x) => x.source === 'record')) {
    for (const p of await unmatchedPeople(db, s)) suggestions.push({ summaryId: s.id, ...p });
  }
  return c.json({
    summaries: (results ?? []).map(summaryJson),
    actions: await actionsJson(db, acts ?? []),
    items: (items.results ?? []).map(itemJson),
    assists: (assists.results ?? []).map(assistJson),
    suggestions,
  });
});

/** TipTap doc for the summary note — headings + paragraphs + bullet lists. */
function tiptapFromSections(sections: { heading: string; body: string }[]): string {
  const content: unknown[] = [];
  const text = (t: string) => (t ? [{ type: 'text', text: t }] : undefined);
  for (const s of sections) {
    if (!s.body.trim()) continue;
    content.push({ type: 'heading', attrs: { level: 2, textAlign: null }, content: text(s.heading) });
    let bullets: unknown[] = [];
    const flush = () => {
      if (bullets.length) content.push({ type: 'bulletList', content: bullets });
      bullets = [];
    };
    for (const raw of s.body.split('\n')) {
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      const m = /^(?:[-*•▪◦–]|\d+[.)]|\[\s?[xX ]?\s?\])\s*(.*)$/.exec(line);
      if (m) bullets.push({ type: 'listItem', content: [{ type: 'paragraph', attrs: { textAlign: null }, content: text(m[1]) }] });
      else {
        flush();
        content.push({ type: 'paragraph', attrs: { textAlign: null }, content: text(line) });
      }
    }
    flush();
  }
  return JSON.stringify({ type: 'doc', content: content.length ? content : [{ type: 'paragraph', attrs: { textAlign: null } }] });
}


/** Match an owner name to one of the meeting's people, else to a single
 * contact with that exact name. */
function matchPerson(owner: string, people: PersonRef[]): PersonRef | null {
  const o = owner.trim().toLowerCase();
  const exact = people.find((p) => p.name.trim().toLowerCase() === o);
  if (exact) return exact;
  const first = people.filter((p) => p.name.trim().toLowerCase().split(/\s+/)[0] === o.split(/\s+/)[0]);
  if (first.length === 1 && (o.split(/\s+/).length === 1 || first[0].name.toLowerCase().includes(o.split(/\s+/).slice(-1)[0]))) return first[0];
  return null;
}

/** Who one of Mike's own next steps is "with / for": a person on the
 * meeting named in the text ("send Elliott the deck"), else the only other
 * person on the meeting (a 1:1). */
export function mineContact(text: string, people: PersonRef[]): PersonRef | null {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}'’ ]+/gu, ' ')} `;
  const named = people.filter((p) => {
    const full = p.name.trim().toLowerCase();
    const first = firstName(p.name).toLowerCase();
    return t.includes(` ${full} `) || (first.length > 1 && t.includes(` ${first} `));
  });
  if (named.length === 1) return named[0];
  return people.length === 1 ? people[0] : null;
}

/** Insert the next steps found in a summary/note as pending meeting_actions. */
function actionInserts(
  db: D1Database,
  summaryId: string,
  meetingId: string,
  seriesKey: string,
  actions: ParsedAction[],
  mine: string[],
  people: PersonRef[],
  ts: string,
  status: 'pending' | 'noted' = 'pending'
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const a of actions) {
    const owners = a.owners.length ? a.owners : [''];
    // "Mike and Sarah will…" → one item each; Mike's copy is his task.
    for (const owner of owners) {
      const me = owner ? isMe(owner, mine) || isMe(firstName(owner), mine) : false;
      const person = owner && !me ? matchPerson(owner, people) : me ? mineContact(a.text, people) : null;
      stmts.push(
        db
          .prepare(
            `INSERT INTO meeting_actions (id, summary_id, meeting_id, series_key, text, owner_name, contact_id, is_mine, status, entity_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
          )
          .bind(uid(), summaryId, meetingId, seriesKey, a.text.slice(0, 1000), owner || null, person?.id ?? null, me ? 1 : 0, status, ts)
      );
    }
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// Mike's own meeting notes → next steps (migration 0114, noteScan.ts)
// ---------------------------------------------------------------------------

type ScanMeeting = { id: string; title: string; start: string; realm: Realm; people: PersonRef[] };
const actionKey = (owner: string | null, text: string) => `${(owner ?? '').trim().toLowerCase()}|${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;

/** Read one meeting's 📝 note for next steps and keep its own_note summary
 * row + pending actions in step with it. Items Mike already decided (task,
 * waiting, dismissed) are never touched; pending ones whose line is gone
 * from the note are removed; new lines become pending items. */
export async function syncOwnNote(db: D1Database, m: ScanMeeting, note: { id: string; content: string | null; updated_at: string }): Promise<void> {
  const mine = await myNames(db);
  const me = firstName(mine[0] ?? 'Mike');
  const known = [...mine, ...mine.map(firstName), ...m.people.map((p) => p.name), ...m.people.map((p) => firstName(p.name))];
  const lines = noteLines(note.content);
  const found = scanNoteActions(lines, known, me);
  const raw = lines.map((l) => l.text).join('\n');
  const seriesKey = seriesKeyOf(m.id);
  const ts = now();

  let row = await db.prepare(`SELECT * FROM meeting_summaries WHERE meeting_id = ? AND source = 'own_note'`).bind(m.id).first<SummaryRow>();
  if (!row) {
    const id = uid();
    await db
      .prepare(
        `INSERT INTO meeting_summaries (id, meeting_id, series_key, occurrence_start, meeting_title, realm, note_entity_id, summary, details, decisions, raw_text, source, created_at, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'own_note', ?, ?)`
      )
      .bind(id, m.id, seriesKey, m.start, m.title, m.realm, note.id, raw, ts, note.updated_at)
      .run();
    row = (await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(id).first<SummaryRow>())!;
  }

  const { results: existing } = await db.prepare(`SELECT * FROM meeting_actions WHERE summary_id = ?`).bind(row.id).all<ActionRow>();
  const have = new Map((existing ?? []).map((a) => [actionKey(a.owner_name, a.text), a]));
  const wanted = new Set<string>();
  const fresh: ParsedAction[] = [];
  for (const a of found) {
    const owners = a.owners.length ? a.owners : [''];
    const missing = owners.filter((o) => {
      const k = actionKey(o || null, a.text.slice(0, 1000));
      wanted.add(k);
      return !have.has(k);
    });
    if (missing.length) fresh.push({ text: a.text, owners: missing.filter(Boolean) });
  }
  const stmts: D1PreparedStatement[] = [];
  for (const [k, a] of have) if (a.status === 'pending' && !wanted.has(k)) stmts.push(db.prepare('DELETE FROM meeting_actions WHERE id = ?').bind(a.id));
  stmts.push(...actionInserts(db, row.id, m.id, seriesKey, fresh, mine, m.people, ts));
  stmts.push(db.prepare(`UPDATE meeting_summaries SET raw_text = ?, note_entity_id = ?, meeting_title = ?, scanned_at = ? WHERE id = ?`).bind(raw, note.id, m.title, note.updated_at, row.id));
  await db.batch(stmts);
}

/** Re-read the notes of these meetings that changed since their last read;
 * returns the meeting ids that were read. */
async function scanStaleNotes(db: D1Database, meetings: ScanMeeting[]): Promise<string[]> {
  if (!meetings.length) return [];
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const rows = await inChunks([...byId.keys()], async (ch, ph) =>
    (
      await db
        .prepare(
          `SELECT mn.meeting_id, e.id, e.content, e.updated_at FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id
           LEFT JOIN meeting_summaries s ON s.meeting_id = mn.meeting_id AND s.source = 'own_note'
           WHERE mn.meeting_id IN (${ph}) AND (s.id IS NULL OR s.scanned_at IS NULL OR s.scanned_at < e.updated_at OR s.note_entity_id != e.id)`
        )
        .bind(...ch)
        .all<{ meeting_id: string; id: string; content: string | null; updated_at: string }>()
    ).results ?? []
  );
  const done: string[] = [];
  for (const r of rows) {
    const m = byId.get(r.meeting_id);
    if (!m) continue;
    await syncOwnNote(db, m, r);
    done.push(m.id);
  }
  return done;
}

workRouter.post('/meetings/:meetingId/summaries', async (c) => {
  const meetingId = c.req.param('meetingId');
  const b = await c.req.json<{ text: string; title?: string; start?: string; realm?: string; peopleIds?: string[]; source?: string; date?: string; allDay?: boolean }>();
  const raw = (b.text ?? '').trim();
  if (raw.length < 10) return c.json({ error: 'Paste the meeting notes first' }, 400);
  if (raw.length > 400_000) return c.json({ error: 'That text is too long (400K characters max)' }, 400);
  const db = c.env.DB;
  const seriesKey = seriesKeyOf(meetingId);
  const start = b.start && !Number.isNaN(Date.parse(b.start)) ? new Date(b.start).toISOString() : now();
  const title = b.title?.trim() || 'Meeting';
  const realm: Realm = b.realm === 'personal' ? 'personal' : b.realm === 'work' ? 'work' : seriesKey.startsWith('ms-') ? 'work' : 'personal';

  // People on the meeting: given ids, else the series' people.
  let people: PersonRef[] = [];
  const pids = (b.peopleIds ?? []).filter(Boolean);
  if (pids.length) {
    people = await inChunks(pids, async (ch, ph) => (await db.prepare(`SELECT id, name FROM contacts WHERE id IN (${ph})`).bind(...ch).all<PersonRef>()).results ?? []);
  } else if (seriesKey.startsWith('ms-')) {
    people = (await db.prepare(`SELECT c.id, c.name FROM meeting_series_people sp JOIN contacts c ON c.id = sp.contact_id WHERE sp.series_id = ?`).bind(seriesKey.slice(3)).all<PersonRef>()).results ?? [];
  }

  // A brief from Mike's work Claude ends with a meeting-record block —
  // file it whole instead of reading it like Gemini notes.
  const ex = extractRecord(raw);
  if (ex.found) {
    if (!ex.record) return c.json({ error: ex.error ?? "Record couldn't be read — ask Claude to resend just the meeting-record block." }, 400);
    if (ex.record.kind === 'weekly' || ex.record.kind === 'thread') return c.json({ error: `This is a ${ex.record.kind} brief, not a meeting — use Paste Brief on Today instead.` }, 400);
    const date = b.date && DATE_RE.test(b.date) ? b.date : ex.record.meeting?.date ?? localDate(start);
    const r = await importRecord(db, ex.record, ex.note, raw, { meetingId, seriesKey, title, start, realm, people, date, allDay: b.allDay === true });
    return c.json(await summaryPayload(db, r.summaryId, r.existing), r.existing ? 200 : 201);
  }

  const mine = await myNames(db);
  const parsed = parseMeetingSummary(raw, [...mine, ...people.map((p) => p.name), ...people.map((p) => p.name.split(/\s+/)[0])]);

  // The full text becomes a real note (searchable; lives in Notes).
  const sections = [
    { heading: 'Summary', body: parsed.summary },
    { heading: 'Decisions', body: parsed.decisions },
    { heading: 'Next Steps', body: parsed.actions.map((a) => `- ${a.owners.length ? `[${a.owners.join(', ')}] ` : ''}${a.text}`).join('\n') },
    { heading: 'Details', body: parsed.details },
    ...parsed.other,
  ];
  const noteId = uid();
  const ts = now();
  const noteTitle = briefNoteTitle(b.date && DATE_RE.test(b.date) ? b.date : localDate(start), title);
  const plain = sections.filter((s) => s.body).map((s) => `${s.heading}\n${s.body}`).join('\n\n');
  await db
    .prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, realm)
       VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?, ?)`
    )
    .bind(noteId, noteTitle, tiptapFromSections(sections), ts, ts, ts, plain, realm)
    .run();

  const id = uid();
  await db
    .prepare(
      `INSERT INTO meeting_summaries (id, meeting_id, series_key, occurrence_start, meeting_title, realm, note_entity_id, summary, details, decisions, raw_text, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, meetingId, seriesKey, start, title, realm, noteId, parsed.summary, parsed.details, parsed.decisions, raw, b.source === 'manual' ? 'manual' : 'gemini', ts)
    .run();

  // Notes-first here too: next steps are recorded, not waiting to be sorted,
  // and a Review task comes due the next day.
  const stmts = actionInserts(db, id, meetingId, seriesKey, parsed.actions, mine, people, ts, 'noted');
  const date = b.date && DATE_RE.test(b.date) ? b.date : localDate(start);
  const today = easternToday();
  const reviewId = uid();
  const reviewTitle = `Review: ${title}`.slice(0, 300);
  const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>();
  stmts.push(
    db
      .prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
         VALUES (?, 'task', ?, ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(reviewId, reviewTitle, JSON.stringify({ action: 'open-note', noteId }), pos?.n ?? 0, addDays(date, 1) > today ? addDays(date, 1) : today, ts, ts, ts, reviewTitle, realm),
    db.prepare(`UPDATE meeting_summaries SET review_task_id = ? WHERE id = ?`).bind(reviewId, id)
  );
  await db.batch(stmts);

  const row = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(id).first<SummaryRow>();
  const { results: acts } = await db.prepare('SELECT * FROM meeting_actions WHERE summary_id = ? ORDER BY rowid').bind(id).all<ActionRow>();
  return c.json({ summary: summaryJson(row!), actions: await actionsJson(db, acts ?? []) }, 201);
});

workRouter.delete('/summaries/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(id).first<SummaryRow>();
  // Pending suggestions go with it; tasks/Waiting items already made stay.
  // A pasted brief (record) also takes its note, items, prompts and the
  // facts it put on contact cards.
  const stmts = [
    db.prepare(`DELETE FROM meeting_actions WHERE summary_id = ?`).bind(id),
    db.prepare(`DELETE FROM meeting_items WHERE summary_id = ?`).bind(id),
    db.prepare(`DELETE FROM meeting_assists WHERE summary_id = ?`).bind(id),
    db.prepare(`DELETE FROM contact_context WHERE summary_id = ?`).bind(id),
    db.prepare('DELETE FROM meeting_summaries WHERE id = ?').bind(id),
  ];
  if (row?.source === 'record' && row.note_entity_id) stmts.push(db.prepare(`DELETE FROM entities WHERE id = ? AND type = 'note'`).bind(row.note_entity_id));
  if (row?.review_task_id) stmts.push(db.prepare(`DELETE FROM entities WHERE id = ? AND type = 'task' AND status != 'done'`).bind(row.review_task_id));
  await db.batch(stmts);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Briefs from Mike's work Claude — "meeting-record" blocks (record.ts,
// migration 0120). One paste files the brief as a Work note, its next steps
// as pending items (Mike's: one-tap Add My Tasks; others': never automatic),
// decisions / open questions / watch-outs / materials as meeting_items, the
// "Where AI Can Help" prompts, and what was learned about each person onto
// their contact card.
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  summary_id: string;
  meeting_id: string;
  series_key: string;
  kind: string;
  text: string;
  extra: string | null;
  position: number;
  resolved_at: string | null;
  created_at: string;
}
interface AssistRow {
  id: string;
  summary_id: string;
  meeting_id: string;
  action_id: string | null;
  title: string;
  prompt: string;
  position: number;
  created_at: string;
}

function itemJson(r: ItemRow) {
  let extra: { type?: string; takeaway?: string; status?: string; owner?: string | null; note?: string | null } | null = null;
  try {
    extra = r.extra ? JSON.parse(r.extra) : null;
  } catch {
    extra = null;
  }
  return { id: r.id, summaryId: r.summary_id, meetingId: r.meeting_id, kind: r.kind, text: r.text, materialType: extra?.type ?? null, takeaway: extra?.takeaway ?? null, status: extra?.status ?? null, owner: extra?.owner ?? null, note: extra?.note ?? null, resolvedAt: r.resolved_at, createdAt: r.created_at };
}
function assistJson(r: AssistRow) {
  return { id: r.id, summaryId: r.summary_id, meetingId: r.meeting_id, actionId: r.action_id, title: r.title, prompt: r.prompt };
}

const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
type Ref = { name: string; email: string | null };

/** Mike's contacts for the names / emails in a record: email first (any
 * contact but the voter roll), then a meeting person by name (full, else a
 * unique first name), then the only non-roll contact with that exact full
 * name. Keyed by lower-cased name. */
async function matchRecordPeople(db: D1Database, refs: Ref[], people: PersonRef[]): Promise<Map<string, PersonRef>> {
  const out = new Map<string, PersonRef>();
  const emails = [...new Set(refs.map((r) => r.email).filter((x): x is string => !!x))];
  const byEmail = new Map<string, PersonRef>();
  if (emails.length) {
    const rows = await inChunks(emails, async (ch, ph) =>
      (
        await db
          .prepare(`SELECT c.id, c.name, lower(j.value) AS email FROM contacts c, json_each(c.emails) j WHERE c.source != 'voter_file' AND lower(j.value) IN (${ph})`)
          .bind(...ch)
          .all<{ id: string; name: string; email: string }>()
      ).results ?? []
    );
    for (const r of rows) if (!byEmail.has(r.email)) byEmail.set(r.email, { id: r.id, name: r.name });
  }
  for (const r of refs) {
    const k = nameKey(r.name);
    if (!k || out.has(k)) continue;
    let hit: PersonRef | null | undefined = r.email ? byEmail.get(r.email) : undefined;
    if (!hit) hit = matchPerson(r.name, people);
    if (!hit && /\s/.test(r.name.trim())) {
      const { results } = await db.prepare(`SELECT id, name FROM contacts WHERE source != 'voter_file' AND lower(name) = ? LIMIT 2`).bind(k).all<PersonRef>();
      if (results?.length === 1) hit = results[0];
    }
    if (hit) out.set(k, hit);
  }
  return out;
}

const isMineName = (n: string | null | undefined, mine: string[]) => !!n && (n.trim().toLowerCase() === 'me' || isMe(n, mine));

/** Everyone a record mentions (attendees, participants, people, owners),
 * minus Mike. */
function recordRefs(rec: MeetingRecord, mine: string[]): Ref[] {
  return [
    ...(rec.meeting?.attendees ?? []),
    ...(rec.thread?.participants ?? []),
    ...rec.people.map((p) => ({ name: p.name, email: p.email })),
    ...rec.actions.filter((a) => a.owner).map((a) => ({ name: a.owner!, email: a.ownerEmail })),
  ].filter((r) => !isMineName(r.name, mine));
}

interface RecordTarget {
  meetingId: string;
  seriesKey: string;
  title: string;
  start: string;
  realm: Realm;
  people: PersonRef[];
  /** The meeting's own calendar date (an all-day start is midnight UTC,
   * which is the day before in New York). */
  date: string;
  /** All-day: store the occurrence at noon New York time so every date
   * shown from it (prep history, contact cards) lands on the right day. */
  allDay?: boolean;
}

/** "2026.10.13 | Weekly Growth Team Lead Meeting" (Mike, 2026-10-13). */
export const briefNoteTitle = (ymd: string, name: string) => `${ymd.replace(/-/g, '.')} | ${name}`.slice(0, 300);

async function importRecord(db: D1Database, rec: MeetingRecord, note: string, raw: string, t: RecordTarget): Promise<{ summaryId: string; existing: boolean }> {
  const json = JSON.stringify(rec);
  // The same brief pasted twice → the first import, not a copy.
  const dup = await db.prepare(`SELECT id FROM meeting_summaries WHERE meeting_id = ? AND source = 'record' AND record_json = ?`).bind(t.meetingId, json).first<{ id: string }>();
  if (dup) return { summaryId: dup.id, existing: true };

  const mine = await myNames(db);
  const matched = await matchRecordPeople(db, recordRefs(rec, mine), t.people);
  const withPeople = [...new Map([...t.people, ...matched.values()].map((p) => [p.id, p])).values()];
  const ts = now();
  const date = DATE_RE.test(t.date) ? t.date : localDate(t.start);
  const occurrence = t.allDay ? easternToUtc(date, '12:00').toISOString() : t.start;
  // Mike's title format: "YYYY.MM.DD | Meeting Name".
  const label = rec.kind === 'thread' ? `${threadSourceLabel(rec.thread?.source ?? '')} · ${t.title}` : rec.kind === 'prep' ? `Prep · ${t.title}` : t.title;
  const noteTitle = briefNoteTitle(date, label);
  const body = note.trim() || (rec.tldr.length ? `## TL;DR\n${rec.tldr.map((x) => `- ${x}`).join('\n')}` : '');

  const noteId = uid();
  const id = uid();
  // Notes-first: the next day, a Work task asks Mike to read the brief and
  // act on it (highlight → task / waiting / project / list). Nothing waits
  // to be sorted in the meantime.
  const reviewId = rec.kind === 'debrief' || rec.kind === 'thread' ? uid() : null;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, realm)
         VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?, ?)`
      )
      .bind(noteId, noteTitle.slice(0, 300), markdownToTiptap(body), ts, ts, ts, markdownToPlain(body).slice(0, 200_000), t.realm),
    db
      .prepare(
        `INSERT INTO meeting_summaries (id, meeting_id, series_key, occurrence_start, meeting_title, realm, note_entity_id, summary, details, decisions, raw_text, source, created_at, kind, format, record_json, review_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'record', ?, ?, ?, ?, ?)`
      )
      .bind(id, t.meetingId, t.seriesKey, occurrence, t.title, t.realm, noteId, rec.tldr.join('\n') || null, rec.decisions.map((d) => `- ${d}`).join('\n') || null, raw.slice(0, 400_000), ts, rec.kind, rec.format, json, reviewId),
  ];
  if (reviewId) {
    const today = easternToday();
    const due = addDays(date, 1) > today ? addDays(date, 1) : today;
    const title = `Review: ${label}`;
    const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>();
    stmts.push(
      db
        .prepare(
          `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
           VALUES (?, 'task', ?, ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(reviewId, title.slice(0, 300), JSON.stringify({ action: 'open-note', noteId }), pos?.n ?? 0, due, ts, ts, ts, title, t.realm)
    );
  }

  const actionIds = new Map<string, string>();
  for (const a of rec.actions) {
    const me = isMineName(a.owner, mine);
    const person = me ? mineContact(a.text, withPeople) : a.owner ? matched.get(nameKey(a.owner)) ?? null : null;
    const aid = uid();
    if (!actionIds.has(a.id)) actionIds.set(a.id, aid);
    stmts.push(
      db
        .prepare(
          `INSERT INTO meeting_actions (id, summary_id, meeting_id, series_key, text, owner_name, contact_id, is_mine, status, entity_id, created_at, confidence, due_date, record_action_id, owner_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'noted', NULL, ?, ?, ?, ?, ?)`
        )
        .bind(aid, id, t.meetingId, t.seriesKey, a.text, me ? mine[0] ?? 'Me' : a.owner, person?.id ?? null, me ? 1 : 0, ts, a.confidence, a.due, a.id, me ? null : a.ownerEmail)
    );
  }

  let pos = 0;
  const item = (kind: string, text: string, extra: unknown = null) =>
    stmts.push(
      db
        .prepare(`INSERT INTO meeting_items (id, summary_id, meeting_id, series_key, kind, text, extra, position, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .bind(uid(), id, t.meetingId, t.seriesKey, kind, text, extra ? JSON.stringify(extra) : null, pos++, ts)
    );
  rec.decisions.forEach((x) => item('decision', x));
  rec.openQuestions.forEach((x) => item('question', x));
  rec.watchOuts.forEach((x) => item('watch_out', x));
  rec.materials.forEach((x) => item('material', x.name, { type: x.type, takeaway: x.takeaway }));
  rec.followThrough.forEach((x) => item('follow_through', x.text, { status: x.status, owner: x.owner, note: x.note }));
  rec.goals.forEach((x) => item('goal', x));
  rec.talkingPoints.forEach((x) => item('talking_point', x));
  rec.questions.forEach((x) => item('prep_question', x));

  rec.assists.forEach((a, i) =>
    stmts.push(
      db
        .prepare(`INSERT INTO meeting_assists (id, summary_id, meeting_id, action_id, title, prompt, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uid(), id, t.meetingId, a.actionId ? actionIds.get(a.actionId) ?? null : null, a.title, a.prompt, i, ts)
    )
  );

  for (const p of rec.people) {
    if (isMineName(p.name, mine)) continue;
    const hit = matched.get(nameKey(p.name));
    if (!hit) continue; // offered as "Add contact?" on the sheet instead
    for (const fact of p.context) {
      stmts.push(db.prepare(`INSERT INTO contact_context (id, contact_id, summary_id, meeting_id, date, fact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uid(), hit.id, id, t.meetingId, date, fact, ts));
    }
  }

  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  await collectKnowledge(db, body, briefNoteTitle(date, label), t.realm).catch((e) => console.error('knowledge collect failed', e));
  return { summaryId: id, existing: false };
}

/** The brief's "Update Project Knowledge" section, if any. */
export function knowledgeSection(md: string): string | null {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^#{1,6}\s*update project knowledge\s*:?\s*$/i.test(l.trim()));
  if (i < 0) return null;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[j]); j++) out.push(lines[j]);
  const body = out.join('\n').trim();
  return body || null;
}

export const KNOWLEDGE_NOTE_TITLE = 'Claude Project · Knowledge Updates';

/** Every brief's "Update Project Knowledge" lines pile up in ONE Work note,
 * so updating the work Claude Project's knowledge file is a weekly copy
 * (or a "merge these" prompt), not a per-meeting chore. */
async function collectKnowledge(db: D1Database, md: string, source: string, realm: Realm): Promise<void> {
  const body = knowledgeSection(md);
  if (!body) return;
  const add = (JSON.parse(markdownToTiptap(`### ${source}\n${body}`)) as { content: unknown[] }).content;
  const plain = markdownToPlain(`${source}\n${body}`);
  const ts = now();
  const id = await getSetting(db, 'knowledge_note_id', '');
  const row = id ? await db.prepare(`SELECT id, content, search_text FROM entities WHERE id = ? AND type = 'note'`).bind(id).first<{ id: string; content: string | null; search_text: string | null }>() : null;
  if (row) {
    let doc: { type: string; content: unknown[] };
    try {
      doc = JSON.parse(row.content || '{"type":"doc","content":[]}');
      if (!Array.isArray(doc.content)) doc.content = [];
    } catch {
      doc = { type: 'doc', content: [] };
    }
    doc.content.push(...add);
    await db
      .prepare(`UPDATE entities SET content = ?, search_text = ?, updated_at = ?, last_touched = ? WHERE id = ?`)
      .bind(JSON.stringify(doc), `${row.search_text ?? ''}\n${plain}`.slice(-200_000), ts, ts, row.id)
      .run();
    return;
  }
  const intro = JSON.parse(
    markdownToTiptap(
      "New facts your briefs flagged for the work Claude Project. Once a week, paste this into the project with: \"Merge these updates into the knowledge file and give me the whole updated file\" — then replace the file and clear this note."
    )
  ) as { content: unknown[] };
  const newId = uid();
  await db
    .prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, realm)
       VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?, ?)`
    )
    .bind(newId, KNOWLEDGE_NOTE_TITLE, JSON.stringify({ type: 'doc', content: [...intro.content, ...add] }), ts, ts, ts, plain, realm)
    .run();
  await db.prepare(`INSERT INTO work_settings (key, value) VALUES ('knowledge_note_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(newId).run();
}

/** People a record names that aren't in Contacts (and Mike hasn't waved
 * off) → "Add contact?" on the sheet. One-word names only when the record
 * gave an email (a bare "Zach" is too thin to make a card from). */
async function unmatchedPeople(db: D1Database, s: SummaryRow): Promise<Ref[]> {
  const rec = recordOf(s);
  if (!rec) return [];
  const mine = await myNames(db);
  const { results: linked } = await db
    .prepare(`SELECT DISTINCT lower(a.owner_name) AS n FROM meeting_actions a WHERE a.summary_id = ? AND a.contact_id IS NOT NULL AND a.owner_name IS NOT NULL`)
    .bind(s.id)
    .all<{ n: string }>();
  const { results: ignored } = await db.prepare(`SELECT lower(text) AS n FROM meeting_items WHERE summary_id = ? AND kind = 'ignored_person'`).bind(s.id).all<{ n: string }>();
  const skip = new Set([...(linked ?? []), ...(ignored ?? [])].map((x) => nameKey(x.n)));
  const refs = recordRefs(rec, mine).filter((r) => !skip.has(nameKey(r.name)) && (r.email || /\s/.test(r.name.trim())));
  const matched = await matchRecordPeople(db, refs, []);
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    const k = nameKey(r.name);
    if (matched.has(k) || seen.has(k)) continue;
    seen.add(k);
    const withEmail = refs.find((x) => nameKey(x.name) === k && x.email);
    out.push({ name: r.name.trim(), email: withEmail?.email ?? null });
  }
  return out;
}

async function summaryPayload(db: D1Database, summaryId: string, existing = false) {
  const row = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(summaryId).first<SummaryRow>();
  const [acts, items, assists] = await Promise.all([
    db.prepare('SELECT * FROM meeting_actions WHERE summary_id = ? ORDER BY created_at, rowid').bind(summaryId).all<ActionRow>(),
    db.prepare(`SELECT * FROM meeting_items WHERE summary_id = ? AND kind != 'ignored_person' ORDER BY position`).bind(summaryId).all<ItemRow>(),
    db.prepare('SELECT * FROM meeting_assists WHERE summary_id = ? ORDER BY position').bind(summaryId).all<AssistRow>(),
  ]);
  return {
    existing,
    summary: row ? summaryJson(row) : null,
    actions: await actionsJson(db, acts.results ?? []),
    items: (items.results ?? []).map(itemJson),
    assists: (assists.results ?? []).map(assistJson),
    suggestions: row ? (await unmatchedPeople(db, row)).map((p) => ({ summaryId, ...p })) : [],
  };
}

const titleKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TITLE_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'with', 'for', 'x', 'w', 'to', 'on', 'in']);
const titleWords = (s: string | null | undefined) => new Set(titleKey(s).split(' ').filter((w) => w && !TITLE_STOP.has(w)));
const BRIEF_ONEOFF = 'Added from a pasted brief.';

/** The calendar meeting a brief names: exact title first; else word overlap
 * — every word of the shorter title in the longer one ("Weekly Growth
 * Meeting" ⊂ "Weekly Growth Team Lead Meeting"), or ≥ 60% shared words.
 * Timed meetings beat all-day ones. */
function bestMeetingMatch<T extends EnrichedMeeting>(day: T[], names: (string | null | undefined)[], skipKey?: string): T | null {
  const wants = names.map((n) => ({ key: titleKey(n), words: titleWords(n) })).filter((w) => w.key);
  let best: { m: T; score: number } | null = null;
  for (const m of day) {
    if (skipKey && m.seriesKey === skipKey) continue;
    const key = titleKey(m.title);
    const words = titleWords(m.title);
    let score = 0;
    for (const w of wants) {
      if (w.key === key) score = Math.max(score, 3);
      else {
        const inter = [...w.words].filter((x) => words.has(x)).length;
        const small = Math.min(w.words.size, words.size);
        const union = new Set([...w.words, ...words]).size;
        if (small >= 2 && inter === small) score = Math.max(score, 2 + inter / Math.max(w.words.size, words.size));
        else if (union && inter / union >= 0.6) score = Math.max(score, 1 + inter / union);
      }
    }
    if (!score) continue;
    if (!m.allDay) score += 0.1;
    if (!best || score > best.score) best = { m, score };
  }
  return best?.m ?? null;
}

/** A brief that had to make its own all-day one-off (no calendar match at
 * the time) moves onto the real meeting once one matches — e.g. the invite
 * was named a little differently. Runs when Today loads and hourly. */
export async function rehomeBriefs(db: D1Database): Promise<number> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT s.*, ms.id AS oneoff_id FROM meeting_summaries s JOIN meeting_series ms ON ('ms-' || ms.id) = s.series_key
        WHERE s.source = 'record' AND s.kind IN ('debrief', 'prep') AND ms.description = ? AND ms.rrule IS NULL AND s.occurrence_start > ?`
    )
    .bind(BRIEF_ONEOFF, since)
    .all<SummaryRow & { oneoff_id: string }>();
  let moved = 0;
  for (const s of results ?? []) {
    const rec = recordOf(s);
    const date = localDate(s.occurrence_start);
    const day = await enrichMeetings(db, await loadMeetings(db, date, date), 'all');
    const m = bestMeetingMatch(day, [rec?.meeting?.series, rec?.meeting?.title, s.meeting_title], s.series_key);
    if (!m) continue;
    const occ = m.allDay ? easternToUtc(date, '12:00').toISOString() : m.start;
    const oldLabel = s.meeting_title;
    const stmts = [
      db.prepare(`UPDATE meeting_summaries SET meeting_id = ?, series_key = ?, occurrence_start = ?, meeting_title = ? WHERE id = ?`).bind(m.id, m.seriesKey, occ, m.title, s.id),
      db.prepare(`UPDATE meeting_actions SET meeting_id = ?, series_key = ? WHERE summary_id = ?`).bind(m.id, m.seriesKey, s.id),
      db.prepare(`UPDATE meeting_items SET meeting_id = ?, series_key = ? WHERE summary_id = ?`).bind(m.id, m.seriesKey, s.id),
      db.prepare(`UPDATE meeting_assists SET meeting_id = ? WHERE summary_id = ?`).bind(m.id, s.id),
      db.prepare(`UPDATE contact_context SET meeting_id = ? WHERE summary_id = ?`).bind(m.id, s.id),
    ];
    // Titles follow the real meeting — unless Mike renamed them himself.
    const prefix = s.kind === 'prep' ? 'Prep · ' : '';
    if (s.note_entity_id) {
      stmts.push(db.prepare(`UPDATE entities SET title = ? WHERE id = ? AND title = ?`).bind(briefNoteTitle(date, prefix + m.title), s.note_entity_id, briefNoteTitle(date, prefix + oldLabel)));
    }
    if (s.review_task_id) stmts.push(db.prepare(`UPDATE entities SET title = ? WHERE id = ? AND title = ?`).bind(`Review: ${m.title}`, s.review_task_id, `Review: ${oldLabel}`));
    await db.batch(stmts);
    // The stand-in meeting goes once nothing else is filed on it.
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM meeting_summaries WHERE series_key = ?`).bind(`ms-${s.oneoff_id}`).first<{ n: number }>();
    if (!left?.n) {
      await db.batch([
        db.prepare(`DELETE FROM meeting_series_people WHERE series_id = ?`).bind(s.oneoff_id),
        db.prepare(`DELETE FROM meeting_docs WHERE series_key = ?`).bind(`ms-${s.oneoff_id}`),
        db.prepare(`DELETE FROM meeting_series WHERE id = ?`).bind(s.oneoff_id),
      ]);
    }
    moved++;
  }
  return moved;
}

/** The meeting a debrief / prep belongs to: same title (or series name) on
 * that day, else a loose title match, else a new one-off Work meeting on
 * that date (all-day — the brief doesn't carry a time). */
async function meetingForRecord(db: D1Database, rec: MeetingRecord): Promise<{ meeting: EnrichedMeeting; created: boolean }> {
  const mt = rec.meeting!;
  const date = mt.date ?? easternToday();
  const day = await enrichMeetings(db, await loadMeetings(db, date, date), 'all');
  const loose = bestMeetingMatch(day, [mt.series, mt.title]);
  if (loose) return { meeting: loose, created: false };

  const id = uid();
  const ts = now();
  await db
    .prepare(
      `INSERT INTO meeting_series (id, title, realm, start_date, start_time, duration_min, rrule, until_date, skip_dates, location, link, project_id, description, active, created_at, updated_at)
       VALUES (?, ?, 'work', ?, NULL, 30, NULL, NULL, '[]', NULL, NULL, NULL, ?, 1, ?, ?)`
    )
    .bind(id, mt.title.slice(0, 200), date, 'Added from a pasted brief.', ts, ts)
    .run();
  // Inferred attendees stay off the meeting until Mike confirms them.
  if (mt.attendeesConfirmed !== false) {
    const mine = await myNames(db);
    const hits = await matchRecordPeople(db, mt.attendees.filter((a) => !isMineName(a.name, mine)), []);
    if (hits.size) await setSeriesPeople(db, id, [...hits.values()].map((p) => p.id));
  }
  const again = await enrichMeetings(db, await loadMeetings(db, date, date), 'all');
  const m = again.find((x) => x.seriesKey === `ms-${id}`);
  if (!m) throw new Error('The meeting could not be created');
  return { meeting: m, created: true };
}

/** A thread (Slack / email / doc comments) has no meeting — the sheet shows
 * it under a stand-in meeting id `thread-<uuid>`. */
function threadMeeting(s: { meeting_id: string; meeting_title: string; occurrence_start: string; record_json?: string | null }, pending: number) {
  let source = 'other';
  let channel: string | null = null;
  try {
    const r = JSON.parse(s.record_json || '{}') as MeetingRecord;
    source = r.thread?.source ?? 'other';
    channel = r.thread?.channel ?? null;
  } catch {
    /* keep defaults */
  }
  return {
    id: s.meeting_id,
    title: s.meeting_title,
    start: s.occurrence_start,
    end: s.occurrence_start,
    allDay: true,
    calendar: 'thread',
    gcalUrl: null,
    hasNote: false,
    attendees: [],
    location: channel,
    links: [],
    realm: 'work' as const,
    seriesKey: s.meeting_id,
    seriesId: null,
    recurring: false,
    people: [],
    summaryCount: 1,
    pendingActions: pending,
    projectId: null,
    docs: [],
    joinUrl: null,
    thread: { source, label: threadSourceLabel(source), channel },
  };
}

/** Weekly brief → this week's Work review: fills priorities / Start / Stop /
 * Continue only where they're still empty; highlights are added to. */
async function applyWeekly(db: D1Database, rec: MeetingRecord) {
  const week = mondayOf(rec.weekOf ?? easternToday());
  const cur = await db.prepare(`SELECT * FROM week_reviews WHERE week_start = ? AND realm = 'work'`).bind(week).first<Record<string, string>>();
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  const filled: string[] = [];
  const kept: string[] = [];
  const pick = (col: string, xs: string[], label: string) => {
    const old = cur?.[col] ?? '';
    if (!xs.length) return old;
    if (old.trim()) {
      kept.push(label);
      return old;
    }
    filled.push(label);
    return list(xs);
  };
  const priorities = pick('priorities', rec.priorities, 'Top Priorities');
  const start = pick('start_text', rec.start, 'Start');
  const stop = pick('stop_text', rec.stop, 'Stop');
  const cont = pick('continue_text', rec.continue, 'Continue');
  let highlights = cur?.highlights ?? '';
  const fresh = rec.highlights.filter((h) => !highlights.includes(h));
  if (fresh.length) {
    highlights = [highlights.trim(), list(fresh)].filter(Boolean).join('\n');
    filled.push('Highlights');
  }
  await db
    .prepare(
      `INSERT INTO week_reviews (week_start, realm, start_text, stop_text, continue_text, highlights, priorities, updated_at) VALUES (?, 'work', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start, realm) DO UPDATE SET start_text = excluded.start_text, stop_text = excluded.stop_text, continue_text = excluded.continue_text,
         highlights = excluded.highlights, priorities = excluded.priorities, updated_at = excluded.updated_at`
    )
    .bind(week, start, stop, cont, highlights, priorities, now())
    .run();
  return { kind: 'weekly' as const, week, filled, kept };
}

/** Paste Brief (Today / Notes, Work mode): Claude's whole response. Debrief
 * and prep land on their meeting (found by title on that date, else a new
 * one-off); a thread gets its own entry; a weekly brief fills the week's
 * Work review. */
workRouter.post('/import', async (c) => {
  const b = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  const raw = (b.text ?? '').trim();
  if (raw.length > 400_000) return c.json({ error: 'That text is too long (400K characters max)' }, 400);
  const ex = extractRecord(raw);
  if (!ex.found) return c.json({ error: "No meeting-record block found. Paste Claude's whole response — it ends with a meeting-record block. (Gemini notes go in a meeting's Add Meeting Notes.)" }, 400);
  if (!ex.record) return c.json({ error: ex.error }, 400);
  const rec = ex.record;
  const db = c.env.DB;

  if (rec.kind === 'weekly') return c.json(await applyWeekly(db, rec), 201);

  if (rec.kind === 'thread') {
    const t = rec.thread!;
    const date = t.date ?? easternToday();
    const prior = await db.prepare(`SELECT meeting_id FROM meeting_summaries WHERE source = 'record' AND kind = 'thread' AND record_json = ?`).bind(JSON.stringify(rec)).first<{ meeting_id: string }>();
    const meetingId = prior?.meeting_id ?? `thread-${uid()}`;
    const start = easternToUtc(date, '12:00').toISOString();
    const r = await importRecord(db, rec, ex.note, raw, { meetingId, seriesKey: meetingId, title: t.title, start, realm: 'work', people: [], date });
    const payload = await summaryPayload(db, r.summaryId, r.existing);
    const row = (await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(r.summaryId).first<SummaryRow>())!;
    return c.json({ kind: 'thread', created: false, meeting: threadMeeting(row, payload.actions.filter((a) => a.status === 'pending').length), ...payload }, r.existing ? 200 : 201);
  }

  const { meeting, created } = await meetingForRecord(db, rec);
  const date = (meeting as { date?: string }).date ?? localDate(meeting.start);
  const r = await importRecord(db, rec, ex.note, raw, { meetingId: meeting.id, seriesKey: meeting.seriesKey, title: meeting.title, start: meeting.start, realm: 'work', people: meeting.people, date, allDay: meeting.allDay });
  return c.json({ kind: rec.kind, created, meeting: { ...meeting, date }, ...(await summaryPayload(db, r.summaryId, r.existing)) }, r.existing ? 200 : 201);
});

/** Check off (or reopen) an open question / watch-out. */
workRouter.patch('/items/:id', async (c) => {
  const b = await c.req.json<{ resolved?: boolean }>().catch(() => ({}) as { resolved?: boolean });
  if (typeof b.resolved !== 'boolean') return c.json({ error: 'resolved (true/false) required' }, 400);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM meeting_items WHERE id = ?').bind(id).first<ItemRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('UPDATE meeting_items SET resolved_at = ? WHERE id = ?').bind(b.resolved ? now() : null, id).run();
  return c.json(itemJson({ ...row, resolved_at: b.resolved ? now() : null }));
});

/** "Add contact?" from a pasted brief: make a Work contact (or reuse one
 * with that email), point the brief's items for that name at it and copy
 * what was learned about them onto the card. */
workRouter.post('/summaries/:id/add-person', async (c) => {
  const db = c.env.DB;
  const s = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(c.req.param('id')).first<SummaryRow>();
  if (!s) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<{ name?: string; email?: string | null; ignore?: boolean }>().catch(() => ({}) as { name?: string; email?: string | null; ignore?: boolean });
  const name = (b.name ?? '').trim().slice(0, 200);
  if (!name) return c.json({ error: 'name required' }, 400);
  if (b.ignore) {
    await db
      .prepare(`INSERT INTO meeting_items (id, summary_id, meeting_id, series_key, kind, text, extra, position, resolved_at, created_at) VALUES (?, ?, ?, ?, 'ignored_person', ?, NULL, 0, NULL, ?)`)
      .bind(uid(), s.id, s.meeting_id, s.series_key, name, now())
      .run();
    return c.json(await summaryPayload(db, s.id));
  }
  const email = typeof b.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim()) ? b.email.trim().toLowerCase() : null;
  let contact = email
    ? await db
        .prepare(`SELECT c.id, c.name FROM contacts c, json_each(c.emails) j WHERE c.source != 'voter_file' AND lower(j.value) = ? LIMIT 1`)
        .bind(email)
        .first<PersonRef>()
    : null;
  // Already in Contacts under that exact name (e.g. added a moment ago)?
  if (!contact) {
    const { results } = await db.prepare(`SELECT id, name FROM contacts WHERE source != 'voter_file' AND lower(name) = ? LIMIT 2`).bind(nameKey(name)).all<PersonRef>();
    if (results?.length === 1) contact = results[0];
  }
  if (!contact) {
    const id = uid();
    const ts = now();
    await db
      .prepare(`INSERT INTO contacts (id, name, circle, emails, phones, pinned, source, created_at, updated_at, labels, realm) VALUES (?, ?, 'other', ?, '[]', 0, 'manual', ?, ?, ?, 'work')`)
      .bind(id, name, JSON.stringify(email ? [email] : []), ts, ts, JSON.stringify([await workLabel(db)]))
      .run();
    contact = { id, name };
  }
  const rec = recordOf(s);
  const k = nameKey(name);
  const stmts = [db.prepare(`UPDATE meeting_actions SET contact_id = ? WHERE summary_id = ? AND contact_id IS NULL AND is_mine = 0 AND lower(owner_name) = ?`).bind(contact.id, s.id, k)];
  const facts = rec?.people.find((p) => nameKey(p.name) === k)?.context ?? [];
  const have = new Set(
    ((await db.prepare(`SELECT fact FROM contact_context WHERE summary_id = ? AND contact_id = ?`).bind(s.id, contact.id).all<{ fact: string }>()).results ?? []).map((x) => x.fact)
  );
  for (const f of facts) {
    if (have.has(f)) continue;
    stmts.push(db.prepare(`INSERT INTO contact_context (id, contact_id, summary_id, meeting_id, date, fact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uid(), contact.id, s.id, s.meeting_id, localDate(s.occurrence_start), f, now()));
  }
  await db.batch(stmts);
  return c.json({ contact, ...(await summaryPayload(db, s.id)) });
});

/** Threads with next steps still to sort (Today → Wrap Up "From Threads"). */
workRouter.get('/threads', async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM meeting_actions a WHERE a.summary_id = s.id AND a.status = 'pending') AS pending
         FROM meeting_summaries s WHERE s.source = 'record' AND s.kind = 'thread'${realmSql(realmOf(c), 's')}
        ORDER BY s.occurrence_start DESC LIMIT 60`
    )
    .all<SummaryRow & { pending: number }>();
  const all = c.req.query('all') === '1';
  return c.json({ threads: (results ?? []).filter((r) => all || r.pending > 0).map((r) => threadMeeting(r, r.pending)) });
});

/** "Where AI Can Help" prompts tied to a task (made from a next step). */
workRouter.get('/assists', async (c) => {
  const entityId = c.req.query('entityId');
  if (!entityId) return c.json({ error: 'entityId required' }, 400);
  const { results } = await c.env.DB.prepare(`SELECT a.* FROM meeting_assists a JOIN meeting_actions m ON m.id = a.action_id WHERE m.entity_id = ? ORDER BY a.created_at, a.position`).bind(entityId).all<AssistRow>();
  return c.json({ assists: (results ?? []).map(assistJson) });
});

/** Forget one fact on a contact card ("What I've Learned" ✕). */
workRouter.delete('/context/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM contact_context WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/** Work contacts as a markdown table for the work Claude Project's People
 * knowledge file (Settings → Meetings → Copy People Table). Notes = the
 * latest things learned from briefs. */
workRouter.get('/people-table', async (c) => {
  const db = c.env.DB;
  const rs = await contactRealmSql(db, 'work', 'c');
  const { results } = await db
    .prepare(`SELECT c.id, c.name, c.title, c.company, c.emails FROM contacts c WHERE c.source != 'voter_file'${rs} ORDER BY c.name COLLATE NOCASE LIMIT 500`)
    .all<{ id: string; name: string; title: string | null; company: string | null; emails: string | null }>();
  const rows = results ?? [];
  const facts = await inChunks(
    rows.map((r) => r.id),
    async (ch, ph) => (await db.prepare(`SELECT contact_id, fact FROM contact_context WHERE contact_id IN (${ph}) ORDER BY date DESC, created_at DESC`).bind(...ch).all<{ contact_id: string; fact: string }>()).results ?? []
  );
  const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines = ['| Name | Title | Email | Notes |', '|---|---|---|---|'];
  for (const r of rows) {
    const email = safeJsonArray(r.emails).find((e) => e.includes('@')) ?? '';
    const notes = facts
      .filter((f) => f.contact_id === r.id)
      .slice(0, 2)
      .map((f) => f.fact)
      .join('; ');
    lines.push(`| ${cell(r.name)} | ${cell(r.title)} | ${cell(email)} | ${cell(notes)} |`);
  }
  return c.json({ count: rows.length, markdown: lines.join('\n') });
});


// ---------------------------------------------------------------------------
// Act on highlighted text in a note (NoteEditor's selection menu): a task due
// tomorrow, a Waiting check-back, a project, a list item, a jot or a link —
// in the note's realm, remembering the note it came from (source_note_id,
// migration 0121) so the next meeting's prep can show what came of it.
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

workRouter.post('/from-note', async (c) => {
  const b = await c.req
    .json<{ noteId?: string; text?: string; kind?: string; listId?: string; contactId?: string }>()
    .catch(() => ({}) as { noteId?: string; text?: string; kind?: string; listId?: string; contactId?: string });
  const db = c.env.DB;
  const text = (b.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•▪◦]|\d+[.)])\s+/, '');
  if (!text) return c.json({ error: 'Select some text first' }, 400);
  const note = b.noteId ? await db.prepare(`SELECT id, realm FROM entities WHERE id = ?`).bind(b.noteId).first<{ id: string; realm: string | null }>() : null;
  const realm: Realm = note ? (note.realm === 'work' ? 'work' : 'personal') : realmOf(c) === 'work' ? 'work' : 'personal';
  const src = note?.id ?? null;
  const ts = now();
  const id = uid();
  const today = easternToday();
  const tomorrow = addDays(today, 1);
  const title = text.slice(0, 300);
  const topPos = async () => (await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>())?.n ?? 0;

  switch (b.kind) {
    case 'task': {
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm, source_note_id)
           VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, title, await topPos(), tomorrow, ts, ts, ts, title, realm, src)
        .run();
      return c.json({ kind: 'task', id, title, dueDate: tomorrow, path: `/today/${tomorrow}` }, 201);
    }
    case 'waiting': {
      const t = `Check Back: ${title}`.slice(0, 300);
      const due = addDays(today, 7);
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, waiting_source_id, waiting_since, realm, source_note_id)
           VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, t, await topPos(), due, ts, ts, ts, t, id, today, realm, src)
        .run();
      return c.json({ kind: 'waiting', id, title: t, dueDate: due, path: '/waiting' }, 201);
    }
    case 'project': {
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, realm, source_note_id)
           VALUES (?, 'project', ?, '', NULL, 1, 'active', 0, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, title, ts, ts, ts, title, realm, src)
        .run();
      return c.json({ kind: 'project', id, title, dueDate: null, path: `/projects/${id}` }, 201);
    }
    case 'list': {
      const list = b.listId ? await db.prepare(`SELECT id, title FROM entities WHERE id = ? AND type = 'project' AND is_list = 1`).bind(b.listId).first<{ id: string; title: string }>() : null;
      if (!list) return c.json({ error: 'Pick a list' }, 400);
      const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id = ?`).bind(list.id).first<{ n: number }>();
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, source_note_id)
           VALUES (?, 'task', ?, ?, 0, 'open', ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, title, list.id, pos?.n ?? 0, ts, ts, ts, title, src)
        .run();
      return c.json({ kind: 'list', id, title, dueDate: null, listTitle: list.title, path: `/lists/${list.id}` }, 201);
    }
    case 'person': {
      const ct = b.contactId ? await db.prepare(`SELECT id, name FROM contacts WHERE id = ?`).bind(b.contactId).first<PersonRef>() : null;
      if (!ct) return c.json({ error: 'Pick a person' }, 400);
      await db
        .prepare(`INSERT INTO person_agenda (id, contact_id, text, source_note_id, realm, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .bind(id, ct.id, title, src, realm, ts)
        .run();
      return c.json({ kind: 'person', id, title, dueDate: null, contactName: ct.name, path: `/contacts/${ct.id}` }, 201);
    }
    case 'jot': {
      const content = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] });
      await db
        .prepare(
          `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, is_jot, realm, source_note_id)
           VALUES (?, 'note', '', ?, NULL, 1, NULL, 0, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(id, content, ts, ts, ts, title, realm, src)
        .run();
      return c.json({ kind: 'jot', id, title, dueDate: null, path: '/jots' }, 201);
    }
    case 'link': {
      const url = URL_RE.exec(text)?.[0]?.replace(/[.,;:]+$/, '');
      if (!url) return c.json({ error: 'No link in the selection' }, 400);
      let name = text.replace(url, '').replace(/[\s:–—-]+$/, '').trim();
      if (!name) {
        try {
          name = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          name = url;
        }
      }
      const maxPos = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM quick_links').first<{ n: number }>();
      await db
        .prepare(
          `INSERT INTO quick_links (id, name, url, type, icon, thumbnail_key, category, sort_order, created_at, updated_at, realm)
           VALUES (?, ?, ?, 'open', NULL, NULL, 'Links', ?, ?, ?, ?)`
        )
        .bind(id, name.slice(0, 200), url.slice(0, 2000), maxPos?.n ?? 0, ts, ts, realm)
        .run();
      return c.json({ kind: 'link', id, title: name, dueDate: null, path: '/links' }, 201);
    }
  }
  return c.json({ error: 'kind must be task, waiting, project, list, person, jot or link' }, 400);
});

// ---------------------------------------------------------------------------
// To raise with a person next time (migration 0122) — from a note highlight
// or typed on their card; open until checked off as discussed.
// ---------------------------------------------------------------------------

interface AgendaRow {
  id: string;
  contact_id: string;
  text: string;
  source_note_id: string | null;
  realm: string;
  created_at: string;
  done_at: string | null;
}
const agendaJson = (r: AgendaRow) => ({ id: r.id, contactId: r.contact_id, text: r.text, noteId: r.source_note_id, createdAt: r.created_at, doneAt: r.done_at });

async function agendaFor(db: D1Database, contactIds: string[]): Promise<AgendaRow[]> {
  return inChunks(contactIds, async (ch, ph) => (await db.prepare(`SELECT * FROM person_agenda WHERE done_at IS NULL AND contact_id IN (${ph}) ORDER BY created_at`).bind(...ch).all<AgendaRow>()).results ?? []);
}

workRouter.post('/agenda', async (c) => {
  const b = await c.req.json<{ contactId?: string; text?: string }>().catch(() => ({}) as { contactId?: string; text?: string });
  const text = (b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!b.contactId || !text) return c.json({ error: 'contactId and text required' }, 400);
  const ct = await c.env.DB.prepare(`SELECT id, realm FROM contacts WHERE id = ?`).bind(b.contactId).first<{ id: string; realm: string | null }>();
  if (!ct) return c.json({ error: 'not found' }, 404);
  const row: AgendaRow = { id: uid(), contact_id: ct.id, text, source_note_id: null, realm: realmOf(c) === 'personal' ? 'personal' : 'work', created_at: now(), done_at: null };
  await c.env.DB.prepare(`INSERT INTO person_agenda (id, contact_id, text, source_note_id, realm, created_at, done_at) VALUES (?, ?, ?, NULL, ?, ?, NULL)`)
    .bind(row.id, row.contact_id, row.text, row.realm, row.created_at)
    .run();
  return c.json(agendaJson(row), 201);
});

workRouter.patch('/agenda/:id', async (c) => {
  const b = await c.req.json<{ done?: boolean; text?: string }>().catch(() => ({}) as { done?: boolean; text?: string });
  const row = await c.env.DB.prepare(`SELECT * FROM person_agenda WHERE id = ?`).bind(c.req.param('id')).first<AgendaRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const next = { ...row };
  if (typeof b.done === 'boolean') next.done_at = b.done ? now() : null;
  if (typeof b.text === 'string' && b.text.trim()) next.text = b.text.trim().slice(0, 300);
  await c.env.DB.prepare(`UPDATE person_agenda SET done_at = ?, text = ? WHERE id = ?`).bind(next.done_at, next.text, row.id).run();
  return c.json(agendaJson(next));
});

workRouter.delete('/agenda/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM person_agenda WHERE id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

type Decision = { decision: string; text?: string; contactId?: string | null; dueDate?: string | null };

/** Turn one next step into a task / Waiting item / dismissal (or undo). */
async function decideAction(db: D1Database, a: ActionRow, b: Decision): Promise<ActionRow | { error: string }> {
  const id = a.id;
  const sum = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(a.summary_id).first<SummaryRow>();
  const realm = (sum?.realm as Realm) || 'work';
  const text = (b.text ?? a.text).trim() || a.text;
  const contactId = b.contactId !== undefined ? b.contactId || null : a.contact_id;
  const ts = now();
  if (!['task', 'waiting', 'dismissed', 'pending'].includes(b.decision)) return { error: 'decision must be task, waiting, dismissed or pending' };

  // Re-deciding: drop whatever was made before, if it's still open.
  if (a.entity_id) {
    await db.prepare(`DELETE FROM entities WHERE id = ? AND status != 'done'`).bind(a.entity_id).run();
  }
  let entityId: string | null = null;
  // A due date from the decision, else the one the record gave the item.
  const due =
    b.dueDate && DATE_RE.test(b.dueDate)
      ? b.dueDate
      : b.dueDate === undefined && a.due_date && DATE_RE.test(a.due_date)
        ? a.due_date
        : b.decision === 'task' && b.dueDate === undefined
          ? addDays(easternToday(), 1) // Mike's default: tomorrow
          : null;
  if (b.decision === 'task') {
    let parentId: string | null = null;
    if (a.series_key.startsWith('ms-')) {
      const s = await db.prepare('SELECT project_id FROM meeting_series WHERE id = ?').bind(a.series_key.slice(3)).first<{ project_id: string | null }>();
      if (s?.project_id && (await db.prepare('SELECT id FROM entities WHERE id = ?').bind(s.project_id).first())) parentId = s.project_id;
    }
    entityId = uid();
    const maxPos = parentId
      ? await db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?').bind(parentId).first<{ m: number }>()
      : await db.prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ m: number }>();
    await db
      .prepare(
        `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm, contact_id)
         VALUES (?, 'task', ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(entityId, text, parentId, parentId ? 0 : 1, (maxPos?.m ?? -1) + 1, due, ts, ts, ts, text, realm, contactId)
      .run();
  } else if (b.decision === 'waiting') {
    entityId = uid();
    const since = sum ? localDate(sum.occurrence_start) : easternToday();
    const who = contactId ? (await db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contactId).first<{ name: string }>())?.name : a.owner_name;
    const title = `Check Back: ${text}${who ? ` (${who})` : ''}`;
    const maxPos = await db.prepare(`SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ m: number }>();
    await db
      .prepare(
        `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, waiting_source_id, waiting_since, realm, contact_id)
         VALUES (?, 'task', ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(entityId, title, (maxPos?.m ?? -1) + 1, due ?? addDays(easternToday(), 7), ts, ts, ts, title, entityId, since, realm, contactId)
      .run();
  }

  await db
    .prepare('UPDATE meeting_actions SET status = ?, entity_id = ?, text = ?, contact_id = ? WHERE id = ?')
    .bind(b.decision, entityId, text, contactId, id)
    .run();
  return (await db.prepare('SELECT * FROM meeting_actions WHERE id = ?').bind(id).first<ActionRow>())!;
}

/** Decide a next step: { decision: 'task' | 'waiting' | 'dismissed' | 'pending',
 *  text?, contactId?, dueDate? }. 'task' → an open task for Mike (in the
 *  series' project if it has one); 'waiting' → a Waiting For check-back on
 *  the person; 'pending' undoes (removes the item made, if still open). */
workRouter.post('/actions/:id', async (c) => {
  const db = c.env.DB;
  const a = await db.prepare('SELECT * FROM meeting_actions WHERE id = ?').bind(c.req.param('id')).first<ActionRow>();
  if (!a) return c.json({ error: 'not found' }, 404);
  const r = await decideAction(db, a, await c.req.json<Decision>());
  if ('error' in r) return c.json(r, 400);
  return c.json((await actionsJson(db, [r]))[0]);
});

/** "Add My Tasks": every pending next step that's Mike's on this meeting
 * becomes a task at once. Other people's items are never touched here —
 * Mike checks those one by one (Waiting On / Dismiss). */
workRouter.post('/meetings/:meetingId/accept-mine', async (c) => {
  const db = c.env.DB;
  const meetingId = c.req.param('meetingId');
  const { results } = await db.prepare(`SELECT * FROM meeting_actions WHERE meeting_id = ? AND status = 'pending' AND is_mine = 1 ORDER BY created_at, rowid`).bind(meetingId).all<ActionRow>();
  for (const a of results ?? []) await decideAction(db, a, { decision: 'task' });
  const { results: acts } = await db.prepare('SELECT * FROM meeting_actions WHERE meeting_id = ? ORDER BY created_at, rowid').bind(meetingId).all<ActionRow>();
  return c.json({ accepted: (results ?? []).length, actions: await actionsJson(db, acts ?? []) });
});


// ---------------------------------------------------------------------------
// Day-of prep tasks (migration 0123): every recurring Work meeting today —
// a hand-entered series with a repeat, a recurring invite, or a meeting with
// an earlier brief under the same name — gets "Prep: <title>" due today.
// The task row's button copies the Prep packet for the work Claude.
// ---------------------------------------------------------------------------

export const PREP_STEPS = 'Tap 📋 Copy Prep for Claude, paste it into your work Claude Project, and read "Your Update" before the meeting.';

export async function ensureMeetingPrepTasks(db: D1Database): Promise<number> {
  const today = easternToday();
  const meetings = await enrichMeetings(db, await loadMeetings(db, today, today), 'work');
  const nowIso = now();
  let made = 0;
  for (const m of meetings) {
    if (m.allDay || m.end <= nowIso) continue;
    const have = await db.prepare(`SELECT entity_id FROM meeting_prep_tasks WHERE meeting_id = ?`).bind(m.id).first();
    if (have) continue;
    let recurring = m.recurring;
    if (!recurring) {
      const since = new Date(Date.parse(m.start) - 42 * 86_400_000).toISOString();
      recurring = !!(await db
        .prepare(`SELECT 1 FROM meeting_summaries WHERE source = 'record' AND meeting_title = ? COLLATE NOCASE AND occurrence_start < ? AND occurrence_start > ? LIMIT 1`)
        .bind(m.title, m.start, since)
        .first());
    }
    if (!recurring) continue;
    const id = uid();
    const title = `Prep: ${m.title}`.slice(0, 300);
    const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>();
    await db.batch([
      db
        .prepare(
          `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
           VALUES (?, 'task', ?, ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, 'work')`
        )
        .bind(id, title, JSON.stringify({ action: 'meeting-prep', meetingId: m.id, date: today, description: PREP_STEPS }), pos?.n ?? 0, today, nowIso, nowIso, nowIso, title),
      db.prepare(`INSERT INTO meeting_prep_tasks (meeting_id, entity_id, created_at) VALUES (?, ?, ?)`).bind(m.id, id, nowIso),
    ]);
    made++;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Prep: one meeting, or every meeting on a day (morning-of)
// ---------------------------------------------------------------------------

interface TaskLite {
  id: string;
  title: string;
  due_date: string | null;
  parent_id: string | null;
  blocked_reason: string | null;
  waiting_since: string | null;
  realm: string;
}

async function openItemsForPeople(db: D1Database, ids: string[], realm: RealmFilter) {
  const rows = await inChunks(ids, async (ch, ph) =>
    (
      await db
        .prepare(
          `${ARCHIVED_TREE_CTE} SELECT id, title, due_date, parent_id, blocked_reason, waiting_since, waiting_source_id, contact_id, realm FROM entities
           WHERE type = 'task' AND status = 'open' AND ${NOT_ARCHIVED} AND contact_id IN (${ph})${realmSql(realm)} ORDER BY due_date IS NULL, due_date, created_at`
        )
        .bind(...ch)
        .all<TaskLite & { waiting_source_id: string | null; contact_id: string }>()
    ).results ?? []
  );
  return rows;
}

async function buildPrep(db: D1Database, m: EnrichedMeeting, realm: RealmFilter) {
  const key = m.seriesKey;
  const [summaries, notes, actions, noteRow] = await Promise.all([
    db.prepare(`SELECT * FROM meeting_summaries WHERE series_key = ? AND source != 'own_note' AND occurrence_start < ? ORDER BY occurrence_start DESC LIMIT 6`).bind(key, m.start).all<SummaryRow>(),
    db
      .prepare(
        `SELECT mn.meeting_id, e.id AS entity_id, e.title, e.search_text, e.updated_at FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id
         WHERE mn.meeting_id = ? OR mn.meeting_id LIKE ?`
      )
      .bind(key, `${key}:%`)
      .all<{ meeting_id: string; entity_id: string; title: string; search_text: string | null; updated_at: string }>(),
    db.prepare(`SELECT * FROM meeting_actions WHERE series_key = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 60`).bind(key).all<ActionRow>(),
    db.prepare(`SELECT mn.note_entity_id, e.search_text FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id WHERE mn.meeting_id = ?`).bind(m.id).first<{ note_entity_id: string; search_text: string | null }>(),
  ]);

  // Past occurrences: summaries + Mike's own notes, newest first.
  const occStart = (meetingId: string) => {
    const i = meetingId.indexOf(':');
    return i === -1 ? null : meetingId.slice(i + 1);
  };
  const history = new Map<string, { meetingId: string; start: string; title: string; summary: ReturnType<typeof summaryJson> | null; myNote: { id: string; title: string; snippet: string } | null }>();
  for (const s of summaries.results ?? []) {
    if (!history.has(s.meeting_id)) history.set(s.meeting_id, { meetingId: s.meeting_id, start: s.occurrence_start, title: s.meeting_title, summary: summaryJson(s), myNote: null });
  }
  for (const n of notes.results ?? []) {
    if (n.meeting_id === m.id) continue;
    const st = occStart(n.meeting_id) ?? n.updated_at;
    if (st >= m.start) continue;
    const h = history.get(n.meeting_id) ?? { meetingId: n.meeting_id, start: st, title: m.title, summary: null, myNote: null };
    h.myNote = { id: n.entity_id, title: n.title, snippet: (n.search_text ?? '').slice(0, 400) };
    history.set(n.meeting_id, h);
  }
  const past = [...history.values()].sort((a, b) => b.start.localeCompare(a.start)).slice(0, 4);

  // Open next steps from this meeting series (made into tasks/waiting and
  // not done yet, or still undecided).
  const acts = await actionsJson(db, actions.results ?? []);
  const openActions = acts.filter((x) => x.status === 'pending' || ((x.status === 'task' || x.status === 'waiting') && x.entityId && !x.entityDone));

  // People: what Mike owes them, what they owe Mike, last time together.
  const pids = m.people.map((p) => p.id);
  const items = await openItemsForPeople(db, pids, 'all');
  const contactRows = await inChunks(pids, async (ch, ph) => (await db.prepare(`SELECT id, name, title, company, headline, emails FROM contacts WHERE id IN (${ph})`).bind(...ch).all<{ id: string; name: string; title: string | null; company: string | null; headline: string | null; emails: string | null }>()).results ?? []);
  const notesRows = await inChunks(pids, async (ch, ph) =>
    (await db.prepare(`SELECT contact_id, text, created_at FROM contact_notes WHERE contact_id IN (${ph}) ORDER BY created_at DESC LIMIT 60`).bind(...ch).all<{ contact_id: string; text: string; created_at: string }>()).results ?? []
  );
  const lastMetRows = await inChunks(pids, async (ch, ph) =>
    (
      await db
        .prepare(
          `SELECT sp.contact_id, MAX(s.occurrence_start) AS last FROM meeting_series_people sp JOIN meeting_summaries s ON s.series_key = 'ms-' || sp.series_id
           WHERE sp.contact_id IN (${ph}) AND s.occurrence_start < ? GROUP BY sp.contact_id`
        )
        .bind(...ch, m.start)
        .all<{ contact_id: string; last: string }>()
    ).results ?? []
  );
  const agendaRows = await agendaFor(db, pids);
  const people = contactRows.map((p) => ({
    agenda: agendaRows.filter((a) => a.contact_id === p.id).map(agendaJson),
    id: p.id,
    name: p.name,
    title: p.title,
    company: p.company,
    headline: p.headline,
    email: safeJsonArray(p.emails).find((e) => e.includes('@')) ?? null,
    iOwe: items.filter((t) => t.contact_id === p.id && !t.waiting_source_id).slice(0, 8),
    theyOwe: items.filter((t) => t.contact_id === p.id && t.waiting_source_id).slice(0, 8),
    pendingFromMeetings: acts.filter((x) => x.status === 'pending' && x.contactId === p.id).length,
    recentNotes: notesRows.filter((n) => n.contact_id === p.id).slice(0, 2),
    lastMet: lastMetRows.find((r) => r.contact_id === p.id)?.last ?? null,
  }));
  people.sort((a, b) => pids.indexOf(a.id) - pids.indexOf(b.id));

  let project: { id: string; title: string; openTasks: TaskLite[] } | null = null;
  if (m.projectId) {
    const p = await db.prepare(`SELECT id, title FROM entities WHERE id = ?`).bind(m.projectId).first<{ id: string; title: string }>();
    if (p) {
      const { results } = await db
        .prepare(
          `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT e.id FROM entities e JOIN tree t ON e.parent_id = t.id)
           SELECT id, title, due_date, parent_id, blocked_reason, waiting_since, realm FROM entities WHERE id IN (SELECT id FROM tree) AND type = 'task' AND status = 'open'
           ORDER BY due_date IS NULL, due_date, position LIMIT 10`
        )
        .bind(p.id)
        .all<TaskLite>();
      project = { ...p, openTasks: results ?? [] };
    }
  }
  const sameNameSince = new Date(Date.parse(m.start) - 42 * 86_400_000).toISOString();
  // From pasted briefs: open questions / watch-outs from earlier meetings
  // in this series (until checked off), and this occurrence's prep.
  const [openItemRows, prepRows] = await Promise.all([
    db
      .prepare(
        `SELECT i.* FROM meeting_items i JOIN meeting_summaries s ON s.id = i.summary_id
          WHERE (i.series_key = ? OR (s.source = 'record' AND s.meeting_title = ? COLLATE NOCASE AND s.occurrence_start > ?))
            AND i.kind IN ('question', 'watch_out') AND i.resolved_at IS NULL AND i.meeting_id != ? AND s.occurrence_start < ?
          ORDER BY s.occurrence_start DESC, i.position LIMIT 30`
      )
      .bind(key, m.title, sameNameSince, m.id, m.start)
      .all<ItemRow>(),
    db
      .prepare(`SELECT i.* FROM meeting_items i JOIN meeting_summaries s ON s.id = i.summary_id WHERE i.meeting_id = ? AND s.kind = 'prep' AND i.kind != 'ignored_person' ORDER BY s.created_at, i.position`)
      .bind(m.id)
      .all<ItemRow>(),
  ]);
  // Since Last Time: the previous brief in this series — every next step it
  // recorded (anyone's) and what Mike made from those notes by highlighting
  // (with done / open), for the update he gives this time.
  let carryForward: null | {
    meetingId: string;
    start: string;
    title: string;
    noteId: string | null;
    tldr: string[];
    commitments: { text: string; owner: string; isMine: boolean; due: string | null; status: string }[];
    myFollowUps: { id: string; title: string; kind: string; done: boolean; dueDate: string | null }[];
  } = null;
  // Same series, or simply the same meeting name in the last 6 weeks — so a
  // meeting Mike never set up as recurring still carries forward.
  const prevRec = await db
    .prepare(
      `SELECT * FROM meeting_summaries WHERE source = 'record' AND kind = 'debrief' AND occurrence_start < ? AND meeting_id != ?
         AND (series_key = ? OR (meeting_title = ? COLLATE NOCASE AND occurrence_start > ?)) ORDER BY occurrence_start DESC LIMIT 1`
    )
    .bind(m.start, m.id, key, m.title, sameNameSince)
    .first<SummaryRow>();
  if (prevRec) {
    const { results: prevActs } = await db.prepare(`SELECT * FROM meeting_actions WHERE summary_id = ? ORDER BY created_at, rowid`).bind(prevRec.id).all<ActionRow>();
    const { results: ownNotes } = await db.prepare(`SELECT note_entity_id FROM meeting_notes WHERE meeting_id = ?`).bind(prevRec.meeting_id).all<{ note_entity_id: string }>();
    const noteIds = [prevRec.note_entity_id, ...(ownNotes ?? []).map((n) => n.note_entity_id)].filter((x): x is string => !!x);
    const made = await inChunks(noteIds, async (ch, ph) =>
      (
        await db
          .prepare(`SELECT id, title, status, due_date, type, is_list, is_jot, waiting_source_id FROM entities WHERE source_note_id IN (${ph}) ORDER BY created_at`)
          .bind(...ch)
          .all<{ id: string; title: string; status: string | null; due_date: string | null; type: string; is_list: number; is_jot: number; waiting_source_id: string | null }>()
      ).results ?? []
    );
    carryForward = {
      meetingId: prevRec.meeting_id,
      start: prevRec.occurrence_start,
      title: prevRec.meeting_title,
      noteId: prevRec.note_entity_id,
      tldr: recordOf(prevRec)?.tldr ?? [],
      commitments: (prevActs ?? []).map((a) => ({ text: a.text, owner: a.is_mine ? 'Me' : a.owner_name ?? 'Unowned', isMine: a.is_mine === 1, due: a.due_date ?? null, status: a.status })),
      myFollowUps: made.map((e) => ({
        id: e.id,
        title: e.title,
        kind: e.waiting_source_id ? 'waiting' : e.type === 'project' ? (e.is_list ? 'list' : 'project') : e.is_jot ? 'jot' : 'task',
        done: e.status === 'done',
        dueDate: e.due_date,
      })),
    };
  }
  void realm;
  return {
    carryForward,
    meeting: m,
    agendaNoteId: noteRow?.note_entity_id ?? null,
    agendaNoteText: noteRow?.search_text ?? null,
    past,
    openActions,
    people,
    project,
    stillOpenItems: (openItemRows.results ?? []).map(itemJson),
    prepItems: (prepRows.results ?? []).map(itemJson),
  };
}

workRouter.get('/prep', async (c) => {
  const date = c.req.query('date') || easternToday();
  // Today loading its preps also makes sure today's Prep tasks exist.
  if (date === easternToday() && !c.req.query('id')) {
    await rehomeBriefs(c.env.DB).catch((e) => console.error('rehome briefs failed', e));
    await ensureMeetingPrepTasks(c.env.DB).catch((e) => console.error('prep tasks failed', e));
  }
  const realm = realmOf(c);
  const meetings = await enrichMeetings(c.env.DB, await loadMeetings(c.env.DB, date, date), realm);
  const id = c.req.query('id');
  if (id) {
    const m = meetings.find((x) => x.id === id);
    if (!m) return c.json({ error: 'meeting not found on that date' }, 404);
    return c.json(await buildPrep(c.env.DB, m, realm));
  }
  const preps = [];
  for (const m of meetings) {
    if (m.allDay) continue;
    preps.push(await buildPrep(c.env.DB, m, realm));
  }
  return c.json({ date, preps });
});

// ---------------------------------------------------------------------------
// A person's work picture (contact card)
// ---------------------------------------------------------------------------

workRouter.get('/person/:contactId', async (c) => {
  const id = c.req.param('contactId');
  const db = c.env.DB;
  const today = easternToday();
  const [items, series, actions, summaries] = await Promise.all([
    openItemsForPeople(db, [id], 'all'),
    db.prepare(`SELECT s.* FROM meeting_series s JOIN meeting_series_people sp ON sp.series_id = s.id WHERE sp.contact_id = ? AND s.active = 1 ORDER BY s.title`).bind(id).all<SeriesRow>(),
    db.prepare(`SELECT * FROM meeting_actions WHERE contact_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20`).bind(id).all<ActionRow>(),
    db
      .prepare(
        `SELECT s.* FROM meeting_summaries s WHERE (s.series_key IN (SELECT 'ms-' || series_id FROM meeting_series_people WHERE contact_id = ?)
         OR s.id IN (SELECT summary_id FROM meeting_actions WHERE contact_id = ?) OR s.id IN (SELECT summary_id FROM contact_context WHERE contact_id = ?)) AND s.source != 'own_note'
         ORDER BY s.occurrence_start DESC LIMIT 6`
      )
      .bind(id, id, id)
      .all<SummaryRow>(),
  ]);
  const seriesIds = new Set((series.results ?? []).map((s) => `ms-${s.id}`));
  let upcoming: EnrichedMeeting[] = [];
  try {
    const all = await enrichMeetings(db, await loadMeetings(db, today, addDays(today, 30)), 'all');
    const seen = new Set<string>();
    // The next occurrence of each meeting they're on.
    upcoming = all
      .filter((m) => (seriesIds.has(m.seriesKey) || m.people.some((p) => p.id === id)) && m.end >= now())
      .filter((m) => (seen.has(m.seriesKey) ? false : (seen.add(m.seriesKey), true)))
      .slice(0, 6);
  } catch {
    upcoming = [];
  }
  const { results: learned } = await db
    .prepare(
      `SELECT cc.id, cc.fact, cc.date, cc.meeting_id, s.meeting_title, s.kind FROM contact_context cc LEFT JOIN meeting_summaries s ON s.id = cc.summary_id
        WHERE cc.contact_id = ? ORDER BY cc.date DESC, cc.created_at DESC LIMIT 40`
    )
    .bind(id)
    .all<{ id: string; fact: string; date: string; meeting_id: string; meeting_title: string | null; kind: string | null }>();
  const { results: agendaRows } = await db
    .prepare(`SELECT * FROM person_agenda WHERE contact_id = ? AND (done_at IS NULL OR done_at > ?) ORDER BY done_at IS NOT NULL, created_at`)
    .bind(id, new Date(Date.now() - 7 * 86_400_000).toISOString())
    .all<AgendaRow>();
  return c.json({
    agenda: (agendaRows ?? []).map(agendaJson),
    learned: (learned ?? []).map((l) => ({ id: l.id, fact: l.fact, date: l.date, meetingId: l.meeting_id, title: l.meeting_title, kind: l.kind })),
    iOwe: items.filter((t) => !t.waiting_source_id),
    theyOwe: items.filter((t) => t.waiting_source_id),
    series: await seriesJson(db, series.results ?? []),
    pendingActions: await actionsJson(db, actions.results ?? []),
    recentMeetings: (summaries.results ?? []).map(summaryJson),
    upcoming: upcoming.map((m) => ({ id: m.id, title: m.title, start: m.start, end: m.end, allDay: m.allDay, realm: m.realm })),
  });
});

// ---------------------------------------------------------------------------
// Weekly briefs
// ---------------------------------------------------------------------------

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

interface BriefTask {
  id: string;
  title: string;
  due_date: string | null;
  parent_id: string | null;
  blocked_reason: string | null;
  waiting_since: string | null;
  contact_id: string | null;
  realm: string;
  project: { id: string; title: string } | null;
  contactName: string | null;
  pushCount?: number;
}

async function decorate(db: D1Database, rows: Omit<BriefTask, 'project' | 'contactName'>[]): Promise<BriefTask[]> {
  // Project = the top-level ancestor (one walk per distinct parent).
  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter((x): x is string => !!x))];
  const topOf = new Map<string, { id: string; title: string } | null>();
  for (const pid of parentIds) {
    const row = await db
      .prepare(
        `WITH RECURSIVE up(id, parent_id, title, is_top_level, type, is_list) AS (
           SELECT id, parent_id, title, is_top_level, type, is_list FROM entities WHERE id = ?
           UNION ALL SELECT e.id, e.parent_id, e.title, e.is_top_level, e.type, e.is_list FROM entities e JOIN up ON e.id = up.parent_id)
         SELECT id, title, type FROM up WHERE parent_id IS NULL LIMIT 1`
      )
      .bind(pid)
      .first<{ id: string; title: string; type: string }>();
    topOf.set(pid, row && row.type === 'project' ? { id: row.id, title: row.title } : null);
  }
  const cids = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const names = await inChunks(cids, async (ch, ph) => (await db.prepare(`SELECT id, name FROM contacts WHERE id IN (${ph})`).bind(...ch).all<{ id: string; name: string }>()).results ?? []);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((r) => ({ ...r, project: r.parent_id ? topOf.get(r.parent_id) ?? null : null, contactName: r.contact_id ? nameOf.get(r.contact_id) ?? null : null }));
}

const TASK_COLS = 'id, title, due_date, parent_id, blocked_reason, waiting_since, contact_id, realm';

workRouter.get('/brief', async (c) => {
  const db = c.env.DB;
  const realm = realmOf(c);
  const today = easternToday();
  const week = mondayOf(c.req.query('week') && DATE_RE.test(c.req.query('week')!) ? c.req.query('week')! : today);
  const weekEnd = addDays(week, 6);
  const nextStart = addDays(week, 7);
  const nextEnd = addDays(week, 13);
  const rs = realmSql(realm);
  const open = `${ARCHIVED_TREE_CTE} SELECT ${TASK_COLS} FROM entities WHERE type = 'task' AND status = 'open' AND ${NOT_ARCHIVED}${rs}`;

  const [overdue, dueThisWeek, dueNextWeek, blocked, waiting, completions, pushes, reviewRow, pendingActions, meetings] = await Promise.all([
    db.prepare(`${open} AND waiting_source_id IS NULL AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date`).bind(week).all<BriefTask>(),
    db.prepare(`${open} AND waiting_source_id IS NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date, due_position IS NULL, due_position, position`).bind(week, weekEnd).all<BriefTask>(),
    db.prepare(`${open} AND waiting_source_id IS NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date, position`).bind(nextStart, nextEnd).all<BriefTask>(),
    db.prepare(`${open} AND blocked_reason IS NOT NULL ORDER BY due_date IS NULL, due_date`).all<BriefTask>(),
    db.prepare(`${open} AND waiting_source_id IS NOT NULL ORDER BY waiting_since, due_date`).all<BriefTask>(),
    db
      .prepare(
        `SELECT tc.entity_id, tc.title, tc.completed_date, e.parent_id, e.contact_id, e.realm, e.waiting_source_id FROM task_completions tc LEFT JOIN entities e ON e.id = tc.entity_id
         WHERE tc.completed_date >= ? AND tc.completed_date <= ?${realm === 'all' ? '' : ` AND e.realm = '${realm}'`} ORDER BY tc.completed_at`
      )
      .bind(week, weekEnd)
      .all<{ entity_id: string; title: string; completed_date: string; parent_id: string | null; contact_id: string | null; realm: string | null; waiting_source_id: string | null }>(),
    db
      .prepare(
        `SELECT r.entity_id, COUNT(*) AS n, MIN(r.from_due_date) AS first_due, MAX(r.rescheduled_at) AS last_at,
                (SELECT COUNT(*) FROM journal_task_reschedules r2 WHERE r2.entity_id = r.entity_id) AS total
           FROM journal_task_reschedules r JOIN entities e ON e.id = r.entity_id
          WHERE r.rescheduled_date >= ? AND r.rescheduled_date <= ? AND e.status = 'open' AND r.to_due_date > r.from_due_date${realmSql(realm, 'e')}
          GROUP BY r.entity_id`
      )
      .bind(week, weekEnd)
      .all<{ entity_id: string; n: number; first_due: string; last_at: string; total: number }>(),
    db.prepare(`SELECT * FROM week_reviews WHERE week_start = ? AND realm = ?`).bind(week, realm).first<Record<string, string>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM meeting_actions a JOIN meeting_summaries s ON s.id = a.summary_id WHERE a.status = 'pending'${realmSql(realm, 's')}`).first<{ n: number }>(),
    loadMeetings(db, week, weekEnd)
      .then((ms) => enrichMeetings(db, ms, realm))
      .catch(() => [] as EnrichedMeeting[]),
  ]);

  // Pushed this week: tasks moved later and still open.
  const pushIds = (pushes.results ?? []).map((p) => p.entity_id);
  const pushedRows = await inChunks(pushIds, async (ch, ph) => (await db.prepare(`SELECT ${TASK_COLS} FROM entities WHERE id IN (${ph})`).bind(...ch).all<BriefTask>()).results ?? []);
  const pushMeta = new Map((pushes.results ?? []).map((p) => [p.entity_id, p]));
  const pushed = (await decorate(db, pushedRows)).map((t) => ({ ...t, pushCount: pushMeta.get(t.id)?.n ?? 1, totalPushes: pushMeta.get(t.id)?.total ?? 1, firstDue: pushMeta.get(t.id)?.first_due ?? null }));

  // Due this week but still open once the week has passed = slipped.
  const dueWeek = await decorate(db, dueThisWeek.results ?? []);
  const slipped = dueWeek.filter((t) => t.due_date! < today && !pushMeta.has(t.id));

  // Accomplished, grouped by project; received check-backs listed apart.
  const compRows = completions.results ?? [];
  const compParents = await decorate(
    db,
    compRows.map((r) => ({ id: r.entity_id, title: r.title, due_date: null, parent_id: r.parent_id, blocked_reason: null, waiting_since: null, contact_id: r.contact_id, realm: r.realm ?? 'personal' }))
  );
  const received = compParents.filter((_, i) => compRows[i].waiting_source_id);
  const done = compParents.filter((_, i) => !compRows[i].waiting_source_id && !/^Check Back: /.test(compRows[i].title));

  const timed = meetings.filter((m) => !m.allDay);
  const meetingMinutes = timed.reduce((sum, m) => sum + Math.max(0, (Date.parse(m.end) - Date.parse(m.start)) / 60000), 0);
  // Each meeting's notes headline (brief TL;DR or Gemini summary) — for
  // Copy Week for Claude.
  const sumRows = await inChunks(
    meetings.filter((m) => m.summaryCount > 0).map((m) => m.id),
    async (ch, ph) => (await db.prepare(`SELECT meeting_id, summary FROM meeting_summaries WHERE source != 'own_note' AND summary IS NOT NULL AND meeting_id IN (${ph}) ORDER BY created_at`).bind(...ch).all<{ meeting_id: string; summary: string }>()).results ?? []
  );
  const headline = new Map<string, string>();
  for (const r of sumRows) if (!headline.has(r.meeting_id)) headline.set(r.meeting_id, r.summary.slice(0, 1200));
  const meetingsOut = meetings.map((m) => ({ id: m.id, title: m.title, start: m.start, end: m.end, allDay: m.allDay, date: (m as { date?: string }).date ?? localDate(m.start), realm: m.realm, people: m.people, summaryCount: m.summaryCount, hasNote: m.hasNote, summary: headline.get(m.id) ?? null }));

  // Rule-based Start / Stop / Continue suggestions.
  const suggestions: { kind: 'start' | 'stop' | 'continue'; text: string }[] = [];
  for (const t of pushed.filter((p) => p.totalPushes >= 3 || p.pushCount >= 2).slice(0, 3)) {
    suggestions.push({ kind: 'stop', text: `Stop carrying "${t.title}" — pushed ${t.totalPushes}×. Do it, delegate it, or drop it.` });
  }
  if (meetingMinutes >= 15 * 60) suggestions.push({ kind: 'stop', text: `${Math.round(meetingMinutes / 60)} hours in meetings this week — cut or shorten one recurring meeting.` });
  const waitingRows = await decorate(db, waiting.results ?? []);
  for (const w of waitingRows.filter((w) => w.waiting_since && w.waiting_since <= addDays(today, -14)).slice(0, 2)) {
    suggestions.push({ kind: 'start', text: `Start escalating: waiting on ${w.contactName ?? 'a reply'} since ${w.waiting_since} — ${w.title.replace(/^Check Back: /, '')}` });
  }
  const blockedRows = await decorate(db, blocked.results ?? []);
  for (const b of blockedRows.slice(0, 2)) suggestions.push({ kind: 'start', text: `Start unblocking "${b.title}"${b.blocked_reason ? ` (${b.blocked_reason})` : ''}.` });
  const byProject = new Map<string, number>();
  for (const d of done) if (d.project) byProject.set(d.project.title, (byProject.get(d.project.title) ?? 0) + 1);
  const topProjects = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [title, n] of topProjects) suggestions.push({ kind: 'continue', text: `Continue the momentum on ${title} (${n} done this week).` });
  if (done.length && !topProjects.length) suggestions.push({ kind: 'continue', text: `Continue clearing the list — ${done.length} done this week.` });

  return c.json({
    week,
    weekEnd,
    today,
    realm,
    review: {
      priorities: reviewRow?.priorities ?? '',
      highlights: reviewRow?.highlights ?? '',
      start: reviewRow?.start_text ?? '',
      stop: reviewRow?.stop_text ?? '',
      continue: reviewRow?.continue_text ?? '',
      updatedAt: reviewRow?.updated_at ?? null,
    },
    overdue: await decorate(db, overdue.results ?? []),
    dueThisWeek: dueWeek,
    dueNextWeek: await decorate(db, dueNextWeek.results ?? []),
    blocked: blockedRows,
    waiting: waitingRows,
    done,
    received,
    pushed,
    slipped,
    meetings: meetingsOut,
    meetingHours: Math.round(meetingMinutes / 6) / 10,
    pendingActions: pendingActions?.n ?? 0,
    suggestions,
  });
});

workRouter.put('/review', async (c) => {
  const week = mondayOf(c.req.query('week') || easternToday());
  const realm = realmOf(c);
  const b = await c.req.json<Partial<{ priorities: string; highlights: string; start: string; stop: string; continue: string }>>();
  const cur = await c.env.DB.prepare(`SELECT * FROM week_reviews WHERE week_start = ? AND realm = ?`).bind(week, realm).first<Record<string, string>>();
  const v = (k: keyof typeof b, col: string) => (b[k] !== undefined ? String(b[k]).slice(0, 20000) : cur?.[col] ?? '');
  await c.env.DB.prepare(
    `INSERT INTO week_reviews (week_start, realm, start_text, stop_text, continue_text, highlights, priorities, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_start, realm) DO UPDATE SET start_text = excluded.start_text, stop_text = excluded.stop_text, continue_text = excluded.continue_text,
       highlights = excluded.highlights, priorities = excluded.priorities, updated_at = excluded.updated_at`
  )
    .bind(week, realm, v('start', 'start_text'), v('stop', 'stop_text'), v('continue', 'continue_text'), v('highlights', 'highlights'), v('priorities', 'priorities'), now())
    .run();
  return c.json({ ok: true, week, realm });
});
