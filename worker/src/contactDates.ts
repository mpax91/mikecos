// Contact dates — birthdays, anniversaries and "other dates" (contact_dates,
// migration 0108) for the Today page's Important Dates.
//
// Mike (2026-10-12): contacts labeled **Family** get every date on their card
// at the top of the list, plus a 7-day heads-up ("Coming Up") so there's time
// for a card or a call. Everyone else still shows on the day itself (voter-
// roll rows stay folded below). A couple who share an anniversary — connected
// on either card, or with the same last name — shows as ONE row
// ("Joe & Stacie Palladino").

export const FAMILY_LABEL = 'family';
export const HEADS_UP_DAYS = 7;

export interface DateParts {
  month: number | null;
  day: number | null;
  year: number | null;
}

export interface ContactEvent {
  label: string;
  month: number;
  day: number;
  year: number | null;
}

export interface ImportantDate {
  key: string;
  kind: 'birthday' | 'anniversary' | 'event';
  /** "Birthday", "Anniversary", or the event's own label ("Wedding"). */
  label: string;
  contactIds: string[];
  name: string;
  family: boolean;
  /** 'voter_file' only when every person on the row came from the roll. */
  source: string;
  year: number | null;
  /** Age they're turning / years married / years since — null without a year. */
  years: number | null;
  /** Days from the viewed date (0 = that day). */
  inDays: number;
  /** The occurrence's own date (YYYY-MM-DD). */
  date: string;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** A date's month/day/year, or nulls. Year-less forms: Google CSV "--10-12",
 * vCard "--1012"; Apple writes 1604 for "no year". */
export function cleanDateParts(month: number | null, day: number | null, year: number | null): DateParts {
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return { month: null, day: null, year: null };
  const y = year && year > 1800 && year < 2200 ? year : null;
  return { month, day, year: y };
}

export function parseYearlessDate(value: string): DateParts | null {
  const m = value.trim().match(/^--(\d{1,2})-?(\d{2})$/);
  return m ? cleanDateParts(+m[1], +m[2], null) : null;
}

/** "Anniversary" in any of the forms exporters use (Apple's _$!<Anniversary>!$_). */
export function normalizeEventLabel(raw: string): string {
  const l = raw
    .replace(/^_\$!<|>!\$_$/g, '')
    .replace(/^\*\s*/, '')
    .trim();
  if (!l) return 'Other';
  return l.charAt(0).toUpperCase() + l.slice(1);
}

export const isAnniversaryLabel = (label: string) => /^(wedding )?anniversary$/i.test(label.trim());

export function isFamily(labelsJson: string | null, circle: string | null): boolean {
  let labels: unknown = [];
  try {
    labels = JSON.parse(labelsJson || '[]');
  } catch {
    labels = [];
  }
  const list = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [];
  if (list.some((l) => l.trim().toLowerCase() === FAMILY_LABEL)) return true;
  return list.length === 0 && circle === 'family';
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** month*100+day keys for each offset 0..days; Feb 29 dates fall on Feb 28 in other years. */
function windowKeys(date: string, days: number): Map<number, number> {
  const keys = new Map<number, number>();
  for (let i = 0; i <= days; i++) {
    const d = addDays(date, i);
    const [y, m, dd] = d.split('-').map(Number);
    const k = m * 100 + dd;
    if (!keys.has(k)) keys.set(k, i);
    if (m === 2 && dd === 28 && !isLeap(y) && !keys.has(229)) keys.set(229, i);
  }
  return keys;
}

const lastName = (name: string) => name.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
const firstNames = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : name.trim();
};

export function coupleName(a: string, b: string): string {
  if (lastName(a) && lastName(a) === lastName(b)) {
    return `${firstNames(a)} & ${firstNames(b)} ${a.trim().split(/\s+/).pop()}`;
  }
  return `${a} & ${b}`;
}

interface Row {
  id: string;
  name: string;
  labels: string | null;
  circle: string | null;
  source: string;
  m: number;
  d: number;
  y: number | null;
  label?: string;
}

/**
 * Important dates around `date`: everything on that day (any contact in the
 * realm) plus Family dates in the next `HEADS_UP_DAYS` days.
 * `realmClause` is contactRealmSql(..., 'c').
 */
export async function importantDates(db: D1Database, date: string, realmClause: string): Promise<{ today: ImportantDate[]; upcoming: ImportantDate[] }> {
  const keys = windowKeys(date, HEADS_UP_DAYS);
  const keyList = [...keys.keys()];
  const ph = keyList.map(() => '?').join(', ');
  const cols = 'c.id, c.name, c.labels, c.circle, c.source';
  const [bdays, annivs, events] = await Promise.all([
    db
      .prepare(`SELECT ${cols}, c.birthday_month AS m, c.birthday_day AS d, c.birthday_year AS y FROM contacts c WHERE (c.birthday_month * 100 + c.birthday_day) IN (${ph})${realmClause}`)
      .bind(...keyList)
      .all<Row>(),
    db
      .prepare(`SELECT ${cols}, c.anniversary_month AS m, c.anniversary_day AS d, c.anniversary_year AS y FROM contacts c WHERE (c.anniversary_month * 100 + c.anniversary_day) IN (${ph})${realmClause}`)
      .bind(...keyList)
      .all<Row>(),
    db
      .prepare(`SELECT ${cols}, cd.month AS m, cd.day AS d, cd.year AS y, cd.label AS label FROM contact_dates cd JOIN contacts c ON c.id = cd.contact_id WHERE (cd.month * 100 + cd.day) IN (${ph})${realmClause}`)
      .bind(...keyList)
      .all<Row>(),
  ]);

  type Single = { row: Row; kind: ImportantDate['kind']; label: string; family: boolean; inDays: number };
  const singles: Single[] = [];
  const push = (rows: Row[] | undefined, kind: ImportantDate['kind']) => {
    for (const row of rows ?? []) {
      const inDays = keys.get(row.m * 100 + row.d);
      if (inDays === undefined) continue;
      const family = isFamily(row.labels, row.circle);
      if (inDays > 0 && !family) continue; // heads-up is Family only
      const label = kind === 'birthday' ? 'Birthday' : kind === 'anniversary' ? 'Anniversary' : normalizeEventLabel(row.label ?? '');
      singles.push({ row, kind, label, family, inDays });
    }
  };
  push(bdays.results, 'birthday');
  push(annivs.results, 'anniversary');
  push(events.results, 'event');

  // Couples: same anniversary (or same-labeled event) on the same day, and
  // connected on either card or sharing a last name.
  const pairable = singles.filter((s) => s.kind !== 'birthday');
  const connected = new Set<string>();
  const ids = [...new Set(pairable.map((s) => s.row.id))];
  if (ids.length > 1) {
    const idPh = ids.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT contact_id, related_contact_id FROM contact_connections WHERE contact_id IN (${idPh}) AND related_contact_id IN (${idPh})`)
      .bind(...ids, ...ids)
      .all<{ contact_id: string; related_contact_id: string }>();
    for (const r of results ?? []) {
      connected.add(`${r.contact_id}|${r.related_contact_id}`);
      connected.add(`${r.related_contact_id}|${r.contact_id}`);
    }
  }
  const used = new Set<Single>();
  const out: ImportantDate[] = [];
  const occurrence = (inDays: number) => addDays(date, inDays);
  const yearsFor = (y: number | null, inDays: number) => {
    if (!y) return null;
    const n = Number(occurrence(inDays).slice(0, 4)) - y;
    return n >= 0 && n < 130 ? n : null;
  };

  const sorted = [...singles].sort((a, b) => a.row.name.localeCompare(b.row.name));
  for (const s of sorted) {
    if (used.has(s)) continue;
    used.add(s);
    let partner: Single | undefined;
    if (s.kind !== 'birthday') {
      partner = sorted.find(
        (o) =>
          !used.has(o) &&
          o.kind === s.kind &&
          o.label.toLowerCase() === s.label.toLowerCase() &&
          o.row.m === s.row.m &&
          o.row.d === s.row.d &&
          o.row.id !== s.row.id &&
          (connected.has(`${s.row.id}|${o.row.id}`) || lastName(o.row.name) === lastName(s.row.name))
      );
      if (partner) used.add(partner);
    }
    const people = partner ? [s, partner] : [s];
    const year = s.row.y ?? partner?.row.y ?? null;
    out.push({
      key: `${s.kind}:${s.label}:${people.map((p) => p.row.id).join('+')}`,
      kind: s.kind,
      label: s.label,
      contactIds: people.map((p) => p.row.id),
      name: partner ? coupleName(s.row.name, partner.row.name) : s.row.name,
      family: people.some((p) => p.family),
      source: people.every((p) => p.row.source === 'voter_file') ? 'voter_file' : people.find((p) => p.row.source !== 'voter_file')!.row.source,
      year,
      years: yearsFor(year, s.inDays),
      inDays: s.inDays,
      date: occurrence(s.inDays),
    });
  }

  const today = out.filter((d) => d.inDays === 0).sort((a, b) => Number(b.family) - Number(a.family) || a.name.localeCompare(b.name));
  const upcoming = out.filter((d) => d.inDays > 0).sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
  return { today, upcoming };
}
