import { Hono } from 'hono';
import type { Env } from '../types';
import type { ParsedMeeting } from '../ics';
import { isMe, parseMeetingSummary } from './gemini';
import { realmMatches, realmOf, realmSql, workLabel, type Realm, type RealmFilter } from './realm';

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
};

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
    inChunks(seriesIds, async (ch, ph) => (await db.prepare(`SELECT id, realm, rrule, project_id FROM meeting_series WHERE id IN (${ph})`).bind(...ch).all<{ id: string; realm: string; rrule: string | null; project_id: string | null }>()).results ?? []),
    inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT mn.meeting_id FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id WHERE mn.meeting_id IN (${ph})`).bind(...ch).all<{ meeting_id: string }>()).results ?? []),
    inChunks(ids, async (ch, ph) => (await db.prepare(`SELECT meeting_id, COUNT(*) AS n FROM meeting_summaries WHERE meeting_id IN (${ph}) GROUP BY meeting_id`).bind(...ch).all<{ meeting_id: string; n: number }>()).results ?? []),
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
    });
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

workRouter.get('/settings', async (c) => c.json({ myNames: (await myNames(c.env.DB)).join(', '), workLabel: await workLabel(c.env.DB) }));

workRouter.put('/settings', async (c) => {
  const body = await c.req.json<{ myNames?: string; workLabel?: string }>();
  const put = (key: string, value: string) =>
    c.env.DB.prepare(`INSERT INTO work_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
  if (typeof body.myNames === 'string') await put('my_names', body.myNames.trim());
  if (typeof body.workLabel === 'string' && body.workLabel.trim()) await put('work_label', body.workLabel.trim());
  return c.json({ myNames: (await myNames(c.env.DB)).join(', '), workLabel: await workLabel(c.env.DB) });
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
      dueDate: e?.due_date ?? null,
    };
  });
}

function summaryJson(s: SummaryRow) {
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
  };
}

workRouter.get('/meetings/:meetingId/summaries', async (c) => {
  const meetingId = c.req.param('meetingId');
  const { results } = await c.env.DB.prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ? ORDER BY created_at').bind(meetingId).all<SummaryRow>();
  const { results: acts } = await c.env.DB.prepare('SELECT * FROM meeting_actions WHERE meeting_id = ? ORDER BY created_at, rowid').bind(meetingId).all<ActionRow>();
  return c.json({ summaries: (results ?? []).map(summaryJson), actions: await actionsJson(c.env.DB, acts ?? []) });
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

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: HOME_TZ, month: '2-digit', day: '2-digit', year: 'numeric' });
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

workRouter.post('/meetings/:meetingId/summaries', async (c) => {
  const meetingId = c.req.param('meetingId');
  const b = await c.req.json<{ text: string; title?: string; start?: string; realm?: string; peopleIds?: string[]; source?: string }>();
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
  const noteTitle = `Meeting Notes · ${title} · ${shortDate(start)}`;
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

  const stmts: D1PreparedStatement[] = [];
  for (const a of parsed.actions) {
    const owners = a.owners.length ? a.owners : [''];
    // "Mike and Sarah will…" → one item each; Mike's copy is his task.
    for (const owner of owners) {
      const me = owner ? isMe(owner, mine) : false;
      const person = owner && !me ? matchPerson(owner, people) : null;
      stmts.push(
        db
          .prepare(
            `INSERT INTO meeting_actions (id, summary_id, meeting_id, series_key, text, owner_name, contact_id, is_mine, status, entity_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`
          )
          .bind(uid(), id, meetingId, seriesKey, a.text.slice(0, 1000), owner || null, person?.id ?? null, me ? 1 : 0, ts)
      );
    }
  }
  if (stmts.length) await db.batch(stmts);

  const row = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(id).first<SummaryRow>();
  const { results: acts } = await db.prepare('SELECT * FROM meeting_actions WHERE summary_id = ? ORDER BY rowid').bind(id).all<ActionRow>();
  return c.json({ summary: summaryJson(row!), actions: await actionsJson(db, acts ?? []) }, 201);
});

workRouter.delete('/summaries/:id', async (c) => {
  const id = c.req.param('id');
  // Pending suggestions go with it; tasks/Waiting items already made stay.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM meeting_actions WHERE summary_id = ?`).bind(id),
    c.env.DB.prepare('DELETE FROM meeting_summaries WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/** Decide a next step: { decision: 'task' | 'waiting' | 'dismissed' | 'pending',
 *  text?, contactId?, dueDate? }. 'task' → an open task for Mike (in the
 *  series' project if it has one); 'waiting' → a Waiting For check-back on
 *  the person; 'pending' undoes (removes the item made, if still open). */
workRouter.post('/actions/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const a = await db.prepare('SELECT * FROM meeting_actions WHERE id = ?').bind(id).first<ActionRow>();
  if (!a) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<{ decision: string; text?: string; contactId?: string | null; dueDate?: string | null }>();
  const sum = await db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').bind(a.summary_id).first<SummaryRow>();
  const realm = (sum?.realm as Realm) || 'work';
  const text = (b.text ?? a.text).trim() || a.text;
  const contactId = b.contactId !== undefined ? b.contactId || null : a.contact_id;
  const ts = now();

  // Re-deciding: drop whatever was made before, if it's still open.
  if (a.entity_id) {
    await db.prepare(`DELETE FROM entities WHERE id = ? AND status != 'done'`).bind(a.entity_id).run();
  }
  let entityId: string | null = null;
  const due = b.dueDate && DATE_RE.test(b.dueDate) ? b.dueDate : null;

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
  } else if (b.decision !== 'dismissed' && b.decision !== 'pending') {
    return c.json({ error: 'decision must be task, waiting, dismissed or pending' }, 400);
  }

  await db
    .prepare('UPDATE meeting_actions SET status = ?, entity_id = ?, text = ?, contact_id = ? WHERE id = ?')
    .bind(b.decision, entityId, text, contactId, id)
    .run();
  const row = await db.prepare('SELECT * FROM meeting_actions WHERE id = ?').bind(id).first<ActionRow>();
  return c.json((await actionsJson(db, [row!]))[0]);
});

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
    db.prepare(`SELECT * FROM meeting_summaries WHERE series_key = ? AND occurrence_start < ? ORDER BY occurrence_start DESC LIMIT 6`).bind(key, m.start).all<SummaryRow>(),
    db
      .prepare(
        `SELECT mn.meeting_id, e.id AS entity_id, e.title, e.search_text, e.updated_at FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id
         WHERE mn.meeting_id = ? OR mn.meeting_id LIKE ?`
      )
      .bind(key, `${key}:%`)
      .all<{ meeting_id: string; entity_id: string; title: string; search_text: string | null; updated_at: string }>(),
    db.prepare(`SELECT * FROM meeting_actions WHERE series_key = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 60`).bind(key).all<ActionRow>(),
    db.prepare(`SELECT mn.note_entity_id FROM meeting_notes mn JOIN entities e ON e.id = mn.note_entity_id WHERE mn.meeting_id = ?`).bind(m.id).first<{ note_entity_id: string }>(),
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
  const contactRows = await inChunks(pids, async (ch, ph) => (await db.prepare(`SELECT id, name, title, company, headline FROM contacts WHERE id IN (${ph})`).bind(...ch).all<{ id: string; name: string; title: string | null; company: string | null; headline: string | null }>()).results ?? []);
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
  const people = contactRows.map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    company: p.company,
    headline: p.headline,
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
  void realm;
  return { meeting: m, agendaNoteId: noteRow?.note_entity_id ?? null, past, openActions, people, project };
}

workRouter.get('/prep', async (c) => {
  const date = c.req.query('date') || easternToday();
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
        `SELECT s.* FROM meeting_summaries s WHERE s.series_key IN (SELECT 'ms-' || series_id FROM meeting_series_people WHERE contact_id = ?)
         OR s.id IN (SELECT summary_id FROM meeting_actions WHERE contact_id = ?) ORDER BY s.occurrence_start DESC LIMIT 6`
      )
      .bind(id, id)
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
  return c.json({
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
  const meetingsOut = meetings.map((m) => ({ id: m.id, title: m.title, start: m.start, end: m.end, allDay: m.allDay, date: (m as { date?: string }).date ?? localDate(m.start), realm: m.realm, people: m.people, summaryCount: m.summaryCount, hasNote: m.hasNote }));

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
