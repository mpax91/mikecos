/** Google-Calendar-style recurrence presets for the Recurring Tasks form —
 * translates a friendly choice ("Weekly on Monday") plus the start date
 * into the RRULE string the backend actually stores, and can reverse-match
 * an existing RRULE back to a preset when editing. "Custom" is the escape
 * hatch for anything these presets can't express — the raw RRULE text box
 * only shows up for that case. */

export type RecurrencePreset = 'daily' | 'weekly' | 'monthly' | 'annually' | 'weekday' | 'custom';

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function weekdayCodeOf(iso: string): string {
  return WEEKDAY_CODES[parseIso(iso).getDay()];
}

function weekdayNameOf(iso: string): string {
  return parseIso(iso).toLocaleDateString('en-US', { weekday: 'long' });
}

function monthDayNameOf(iso: string): string {
  return parseIso(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/** Which occurrence of its weekday `iso` is within its month (1st Monday,
 * 2nd Monday, ...), and whether it's also the LAST such occurrence — Google
 * Calendar's own dropdown prefers "last" when a date happens to be both
 * (e.g. the 4th Monday of a 4-Monday month) since that reads more naturally
 * and keeps matching in months with only 4. */
function nthWeekdayOfMonth(iso: string): { n: number; isLast: boolean } {
  const dt = parseIso(iso);
  const day = dt.getDate();
  const n = Math.ceil(day / 7);
  const daysInMonth = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  const isLast = day + 7 > daysInMonth;
  return { n, isLast };
}

export function presetToRrule(preset: RecurrencePreset, dtstart: string): string {
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${weekdayCodeOf(dtstart)}`;
    case 'monthly': {
      const { n, isLast } = nthWeekdayOfMonth(dtstart);
      const pos = isLast ? -1 : n;
      return `FREQ=MONTHLY;BYDAY=${pos}${weekdayCodeOf(dtstart)}`;
    }
    case 'annually':
      return 'FREQ=YEARLY';
    case 'weekday':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'custom':
      return '';
  }
}

export function presetLabel(preset: RecurrencePreset, dtstart: string): string {
  switch (preset) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return `Weekly on ${weekdayNameOf(dtstart)}`;
    case 'monthly': {
      const { n, isLast } = nthWeekdayOfMonth(dtstart);
      const word = isLast ? 'last' : ORDINALS[n - 1] ?? `${n}th`;
      return `Monthly on the ${word} ${weekdayNameOf(dtstart)}`;
    }
    case 'annually':
      return `Annually on ${monthDayNameOf(dtstart)}`;
    case 'weekday':
      return 'Every weekday (Monday to Friday)';
    case 'custom':
      return 'Custom…';
  }
}

export const RECURRENCE_PRESETS: RecurrencePreset[] = ['daily', 'weekly', 'monthly', 'annually', 'weekday', 'custom'];

/** Reverse-matches a stored RRULE string back to one of the presets above
 * (ignoring whitespace/case), for pre-selecting the right dropdown option
 * when editing an existing definition — anything that doesn't match one of
 * these exactly falls back to 'custom' with the raw string shown as-is. */
export function detectPreset(rrule: string, dtstart: string): RecurrencePreset {
  const normalized = rrule.trim().toUpperCase();
  for (const preset of RECURRENCE_PRESETS) {
    if (preset === 'custom') continue;
    if (presetToRrule(preset, dtstart) === normalized) return preset;
  }
  return 'custom';
}
