/** US federal holidays, common cultural observances, two family-relevant
 * professional observances (Mike has family in law enforcement and as a
 * PA), and a wide set of lighter fixed-date fun/awareness observances
 * (National Dog Day, Pi Day, and the like) — Mike explicitly wants the net
 * cast wide here since the Day view's Important Dates section has the room
 * for it, and it might surface something worth knowing about. All computed
 * purely from date-math rules — no API, no stored data, so this never needs
 * updating and never goes stale. Multi-day observances (Police Week, PA
 * Week) produce one entry per day in the range; everything else is a single
 * date. */

export interface Holiday {
  date: string; // 'YYYY-MM-DD'
  name: string;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The nth (1-indexed) occurrence of `weekday` (0=Sunday) in a given
 * month — e.g. nthWeekday(2026, 1, 1, 3) is the 3rd Monday of January
 * 2026 (MLK Day). */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(year, month - 1, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return iso(year, month, day);
}

/** The last occurrence of `weekday` in a given month — Memorial Day is the
 * last Monday of May, not a fixed nth one. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const last = new Date(year, month - 1, lastDayOfMonth);
  const offset = (last.getDay() - weekday + 7) % 7;
  return iso(year, month, lastDayOfMonth - offset);
}

/** Easter Sunday via the standard Anonymous Gregorian / Meeus-Jones-Butcher
 * algorithm — the one holiday here without a simple "nth weekday" rule. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** All 7 dates in the Sunday–Saturday calendar week containing `monthDay`
 * (month/day in the given year) — the actual legal basis for Police Week
 * ("the calendar week during which May 15 occurs", Pub. L. 87-726), and
 * confirmed against the White House's 2026 proclamation (May 10–16, 2026,
 * for a May 15 that falls on a Friday). */
function calendarWeekContaining(year: number, month: number, day: number): string[] {
  const d = new Date(year, month - 1, day);
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(sunday);
    dt.setDate(sunday.getDate() + i);
    days.push(iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  }
  return days;
}

/** All 7 dates from `startMonth/startDay` through 6 days later, same year —
 * PA Week is a fixed October 6–12 every year (AAPA), not week-relative. */
function fixedWeekStarting(year: number, month: number, day: number): string[] {
  const start = new Date(year, month - 1, day);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start);
    dt.setDate(start.getDate() + i);
    days.push(iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  }
  return days;
}

function holidaysForYear(year: number): Holiday[] {
  const list: Holiday[] = [
    // Federal / major cultural holidays
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: 'MLK Day' },
    { date: iso(year, 2, 14), name: "Valentine's Day" },
    { date: nthWeekday(year, 2, 1, 3), name: "Presidents' Day" },
    { date: easterSunday(year), name: 'Easter' },
    { date: nthWeekday(year, 5, 0, 2), name: "Mother's Day" },
    { date: lastWeekday(year, 5, 1), name: 'Memorial Day' },
    { date: iso(year, 5, 15), name: "Peace Officers Memorial Day" },
    { date: nthWeekday(year, 6, 0, 3), name: "Father's Day" },
    { date: iso(year, 6, 19), name: 'Juneteenth' },
    { date: iso(year, 7, 4), name: 'Independence Day' },
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    { date: iso(year, 10, 31), name: 'Halloween' },
    { date: iso(year, 11, 11), name: 'Veterans Day' },
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving' },
    { date: iso(year, 12, 24), name: 'Christmas Eve' },
    { date: iso(year, 12, 25), name: 'Christmas' },
    { date: iso(year, 12, 31), name: "New Year's Eve" },
    ...calendarWeekContaining(year, 5, 15).map((date) => ({ date, name: 'Police Week' })),
    ...fixedWeekStarting(year, 10, 6).map((date) => ({ date, name: 'PA Week' })),

    // Lighter fixed-date observances — Mike's OK with the extra noise here
    // since there's room in the Day view's Important Dates section and it
    // might surface something worth knowing about. Every date below is a
    // fixed month/day observed the same day every year (verified, not
    // guessed), so none of these need a special rule function.
    { date: iso(year, 1, 21), name: 'National Hug Day' },
    { date: iso(year, 2, 2), name: 'Groundhog Day' },
    { date: iso(year, 3, 14), name: 'Pi Day' },
    { date: iso(year, 3, 17), name: "St. Patrick's Day" },
    { date: iso(year, 3, 20), name: 'International Day of Happiness' },
    { date: iso(year, 4, 1), name: "April Fools' Day" },
    { date: iso(year, 4, 10), name: 'National Siblings Day' },
    { date: iso(year, 4, 22), name: 'Earth Day' },
    { date: iso(year, 4, 26), name: 'National Pretzel Day' },
    { date: iso(year, 5, 4), name: 'Star Wars Day' },
    { date: iso(year, 5, 5), name: 'Cinco de Mayo' },
    { date: iso(year, 6, 8), name: 'World Oceans Day' },
    { date: iso(year, 6, 21), name: 'International Yoga Day' },
    { date: iso(year, 7, 17), name: 'World Emoji Day' },
    { date: iso(year, 8, 8), name: 'International Cat Day' },
    { date: iso(year, 8, 19), name: 'World Photography Day' },
    { date: iso(year, 8, 26), name: 'National Dog Day' },
    { date: iso(year, 8, 26), name: "Women's Equality Day" },
    { date: iso(year, 9, 19), name: 'International Talk Like a Pirate Day' },
    { date: iso(year, 9, 21), name: 'International Day of Peace' },
    { date: iso(year, 10, 1), name: 'International Coffee Day' },
    { date: iso(year, 10, 4), name: 'World Animal Day' },
    { date: iso(year, 10, 16), name: 'World Food Day' },
    { date: iso(year, 11, 13), name: 'World Kindness Day' },
    { date: iso(year, 12, 10), name: 'Human Rights Day' },
  ];
  return list;
}

const cache = new Map<number, Holiday[]>();
function holidaysForYearCached(year: number): Holiday[] {
  let list = cache.get(year);
  if (!list) {
    list = holidaysForYear(year);
    cache.set(year, list);
  }
  return list;
}

/** Every holiday/observance name that lands on `iso` (e.g. both "Peace
 * Officers Memorial Day" and "Police Week" on May 15). Empty for an
 * ordinary day. */
export function getHolidays(dateIso: string): string[] {
  const year = Number(dateIso.slice(0, 4));
  return holidaysForYearCached(year)
    .filter((h) => h.date === dateIso)
    .map((h) => h.name);
}
