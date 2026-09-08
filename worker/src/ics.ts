import { RRule, RRuleSet } from 'rrule';

/** Mike's home timezone — matches the Week/Day weather widget's Bedford
 * Hills, NY location. Used both to resolve any "floating" (no TZID, no Z)
 * ICS datetime and to compute the UTC window a viewed calendar day maps
 * to, since "today's meetings" means Mike's local day, not a UTC one. */
const HOME_TZ = 'America/New_York';

export interface ParsedMeeting {
  id: string;
  title: string;
  start: string; // ISO instant (UTC)
  end: string;
  allDay: boolean;
  calendar: string;
  gcalUrl: string | null;
}

// ---- Timezone math ----
//
// Cloudflare Workers' V8 ships full ICU, so Intl.DateTimeFormat with an
// arbitrary IANA `timeZone` works the same as in a browser — no separate
// tz database or nodejs_compat flag needed. The "double conversion" trick
// below is the standard DST-safe way to turn a wall-clock time in a named
// zone into the correct UTC instant without a dedicated tz library: guess
// the instant assuming UTC, ask Intl what that instant looks like in the
// target zone, and correct by the difference — this converges correctly
// across a DST transition because we're sampling the real offset near the
// actual date in question, not a fixed year-round offset.
function zonedWallTimeToUtc(y: number, month: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, month - 1, d, h, mi, s);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  // A 24-hour formatter can print "24" for local midnight depending on
  // locale/engine quirks — normalize that back to 0 before reassembling.
  const hh = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh, Number(parts.minute), Number(parts.second));
  return new Date(guess - (asIfUtc - guess));
}

function dayWindowUtc(dateIso: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = dateIso.split('-').map(Number);
  return {
    start: zonedWallTimeToUtc(y, m, d, 0, 0, 0, tz),
    end: zonedWallTimeToUtc(y, m, d, 24, 0, 0, tz),
  };
}

/** Which local calendar date (in `tz`) a UTC instant falls on — the inverse
 * of zonedWallTimeToUtc, used to bucket a multi-day range's occurrences by
 * day for the Week/Month views. en-CA's locale format is the one built-in
 * Intl option that already prints as YYYY-MM-DD. */
function localDateOf(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// ---- Minimal RFC5545 parsing — just enough of ICS to read a Google
// Calendar export: line unfolding, VEVENT properties (UID, SUMMARY,
// DTSTART/DTEND, RRULE, EXDATE, RECURRENCE-ID, STATUS), and the handful of
// datetime encodings Google actually emits (UTC "Z", a TZID-qualified
// local time, or an all-day VALUE=DATE). Anything else in the feed
// (VTIMEZONE blocks, VALARM, etc.) is simply never matched by a case below
// and ignored. ----

interface RawProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfoldLines(ics: string): string[] {
  const raw = ics.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function parseLine(line: string): RawProp | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...paramParts] = left.split(';');
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeIcsText(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcsDateTime(value: string, params: Record<string, string>): { date: Date; allDay: boolean } {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6));
    const d = Number(value.slice(6, 8));
    return { date: new Date(Date.UTC(y, m - 1, d)), allDay: true };
  }
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(4, 6));
  const d = Number(value.slice(6, 8));
  const h = Number(value.slice(9, 11));
  const mi = Number(value.slice(11, 13));
  const s = Number(value.slice(13, 15)) || 0;
  if (value.endsWith('Z')) return { date: new Date(Date.UTC(y, m - 1, d, h, mi, s)), allDay: false };
  const tz = params.TZID || HOME_TZ;
  return { date: zonedWallTimeToUtc(y, m, d, h, mi, s, tz), allDay: false };
}

interface VEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule?: string;
  exdates: Date[];
  recurrenceId?: Date;
  status?: string;
}

function parseIcsEvents(ics: string): VEvent[] {
  const lines = unfoldLines(ics);
  const events: VEvent[] = [];
  let cur: Partial<VEvent> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start && cur.end) events.push(cur as VEvent);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        cur.uid = prop.value;
        break;
      case 'SUMMARY':
        cur.summary = unescapeIcsText(prop.value);
        break;
      case 'DTSTART': {
        const { date, allDay } = parseIcsDateTime(prop.value, prop.params);
        cur.start = date;
        cur.allDay = allDay;
        break;
      }
      case 'DTEND': {
        const { date } = parseIcsDateTime(prop.value, prop.params);
        cur.end = date;
        break;
      }
      case 'RRULE':
        cur.rrule = prop.value;
        break;
      case 'EXDATE':
        for (const part of prop.value.split(',')) {
          if (part) cur.exdates!.push(parseIcsDateTime(part, prop.params).date);
        }
        break;
      case 'RECURRENCE-ID':
        cur.recurrenceId = parseIcsDateTime(prop.value, prop.params).date;
        break;
      case 'STATUS':
        cur.status = prop.value;
        break;
    }
  }
  return events;
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The "eid" link trick Google Calendar's own UI uses under the hood for a
// direct link to one event — reverse-engineered and undocumented (there is
// no official API for this), so treated as best-effort: eid is the
// base64 of "<event id> <calendar id>", where the event id is the ICS UID
// with any trailing "@google.com" stripped. If this format ever changes on
// Google's end, worst case the link 404s; there's no way to detect that
// server-side without an extra authenticated round trip, which defeats the
// point of the lightweight ICS approach Mike chose over full OAuth.
function buildGcalUrl(uid: string, calendarId: string): string {
  const eventId = uid.replace(/@google\.com$/i, '');
  const eid = btoa(`${eventId} ${calendarId}`).replace(/=+$/, '');
  return `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eid)}`;
}

interface FeedSource {
  ics: string;
  calendar: string;
  calendarId: string;
}

/** A meeting occurrence tagged with which local calendar date (HOME_TZ) it
 * falls on — meetingsForDate's single-day callers already know the date
 * they asked for, but the Week/Month views span many days at once and need
 * each occurrence bucketed by its own day, the same way MonthResponse
 * buckets tasks by due_date. */
export interface RangeMeeting extends ParsedMeeting {
  date: string;
}

/** Every meeting from the given feeds falling anywhere in [startIso,
 * endIso] (inclusive, Mike's local days per HOME_TZ) — recurring events
 * expanded via RRULE/EXDATE across the whole window in one pass per feed
 * (rather than once per day), with RECURRENCE-ID overrides (a moved/
 * renamed single occurrence) substituted in place of the rule-generated
 * one, and CANCELLED events/occurrences dropped. meetingsForDate below is
 * just this with startIso === endIso. */
export function meetingsForRange(sources: FeedSource[], startIso: string, endIso: string): RangeMeeting[] {
  const { start: rangeStart } = dayWindowUtc(startIso, HOME_TZ);
  const { end: rangeEnd } = dayWindowUtc(endIso, HOME_TZ);
  const results: RangeMeeting[] = [];

  for (const src of sources) {
    const events = parseIcsEvents(src.ics);
    const overridesByUid = new Map<string, VEvent[]>();
    const bases: VEvent[] = [];
    for (const ev of events) {
      if (ev.recurrenceId) {
        const list = overridesByUid.get(ev.uid);
        if (list) list.push(ev);
        else overridesByUid.set(ev.uid, [ev]);
      } else {
        bases.push(ev);
      }
    }

    const toMeeting = (ev: VEvent, occurrenceKey: Date | null): ParsedMeeting => ({
      id: occurrenceKey ? `${ev.uid}:${occurrenceKey.toISOString()}` : ev.uid,
      title: ev.summary || 'Untitled',
      start: ev.start.toISOString(),
      end: ev.end.toISOString(),
      allDay: ev.allDay,
      calendar: src.calendar,
      gcalUrl: buildGcalUrl(ev.uid, src.calendarId),
    });

    for (const base of bases) {
      if (base.status === 'CANCELLED') continue;
      const overrides = overridesByUid.get(base.uid) ?? [];

      if (base.rrule) {
        const opts = RRule.parseString(base.rrule);
        opts.dtstart = base.start;
        const rule = new RRule(opts);
        const set = new RRuleSet();
        set.rrule(rule);
        for (const ex of base.exdates) set.exdate(ex);
        const duration = base.end.getTime() - base.start.getTime();

        for (const occStart of set.between(rangeStart, rangeEnd, true)) {
          const override = overrides.find((o) => o.recurrenceId!.getTime() === occStart.getTime());
          if (override) {
            if (override.status === 'CANCELLED') continue;
            results.push({ ...toMeeting(override, occStart), date: localDateOf(occStart, HOME_TZ) });
          } else {
            const occMeeting = toMeeting({ ...base, start: occStart, end: new Date(occStart.getTime() + duration) }, occStart);
            results.push({ ...occMeeting, date: localDateOf(occStart, HOME_TZ) });
          }
        }
      } else if (base.allDay) {
        const d = isoDateOnly(base.start);
        if (d >= startIso && d <= endIso) results.push({ ...toMeeting(base, null), date: d });
      } else if (base.start >= rangeStart && base.start < rangeEnd) {
        results.push({ ...toMeeting(base, null), date: localDateOf(base.start, HOME_TZ) });
      }
    }
  }

  // Mike has more than one active feed (his own calendar plus a shared
  // one), and the same real-world event can legitimately come back once
  // per feed — an invite he accepted that also lives on the shared
  // calendar, say — which read as unexplained duplicates ("2 events on
  // SUN... these aren't on my Google calendars at all") even though each
  // copy is individually correct. There's no reliable cross-calendar id to
  // key on, so collapse anything with the same title + start + end
  // (whichever feed it happened to come from) down to one occurrence.
  const seen = new Set<string>();
  const deduped = results.filter((m) => {
    const key = `${m.title.trim().toLowerCase()}|${m.start}|${m.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.start.localeCompare(b.start));
  return deduped;
}

/** Every meeting from the given feeds that falls on `dateIso` (Mike's
 * local day, per HOME_TZ) — a thin single-day wrapper around
 * meetingsForRange. */
export function meetingsForDate(sources: FeedSource[], dateIso: string): ParsedMeeting[] {
  return meetingsForRange(sources, dateIso, dateIso);
}

/** Pulls the calendar id straight out of a Google "secret address" ICS
 * URL (…/ical/<calendar id, URL-encoded>/private-…/basic.ics) — the same
 * id Google's own eid links need, so there's nothing extra for Mike to
 * supply beyond the URL he already copied out of Calendar settings. */
export function calendarIdFromIcsUrl(url: string): string | null {
  const match = url.match(/\/ical\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}
