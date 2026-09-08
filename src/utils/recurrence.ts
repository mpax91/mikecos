/** Google-Calendar-style recurrence presets for the Recurring Tasks form —
 * translates a friendly choice ("Weekly on Monday") plus the start date
 * into the RRULE string the backend actually stores, and can reverse-match
 * an existing RRULE back to a preset when editing. "Custom" is the escape
 * hatch for anything these presets can't express — the raw RRULE text box
 * only shows up for that case. */

export type RecurrencePreset = 'daily' | 'weekly' | 'monthly' | 'annually' | 'weekday' | 'custom';

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Sunday-first single-letter chip labels for the Custom recurrence
 * dialog's "Repeat on" row, matching Google Calendar's own S M T W T F S
 * (index-aligned with WEEKDAY_CODES). */
export const WEEKDAY_SHORT_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

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

// ---- Custom recurrence dialog (Google-Calendar-style "Custom recurrence…"
// popup) — the friendly presets above cover the common cases, but picking
// "Custom…" from the dropdown used to just drop Mike into a raw RRULE text
// box (FREQ=WEEKLY;BYDAY=MO and the like), which he found unintuitive. This
// gives the same "Repeat every N ___, repeat on, ends" builder Google
// Calendar itself uses for its own Custom recurrence dialog, still
// producing a plain RRULE string underneath so the backend/DB shape and the
// live preview (api.previewRrule) don't need to know this exists. ----

export type CustomFreqUnit = 'day' | 'week' | 'month' | 'year';

export interface CustomRecurrenceRule {
  interval: number;
  unit: CustomFreqUnit;
  /** Only meaningful when unit === 'week' — which weekdays (WEEKDAY_CODES
   * values) the rule repeats on. */
  byDay: string[];
  ends: { type: 'never' } | { type: 'on'; date: string } | { type: 'after'; count: number };
}

const FREQ_BY_UNIT: Record<CustomFreqUnit, string> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const UNIT_BY_FREQ: Record<string, CustomFreqUnit> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

export function defaultCustomRule(dtstart: string): CustomRecurrenceRule {
  return { interval: 1, unit: 'week', byDay: [weekdayCodeOf(dtstart)], ends: { type: 'never' } };
}

// RRULE's UNTIL needs a full datetime when paired with a DTSTART that (as
// far as the `rrule` package we round-trip through is concerned) resolves
// to a UTC instant — plain "YYYYMMDD" was rejected as before dtstart in
// testing once the time-of-day components didn't line up. Midnight UTC on
// the chosen date keeps it unambiguous and always >= a same-day dtstart.
function untilToRruleValue(dateIso: string): string {
  return `${dateIso.replace(/-/g, '')}T000000Z`;
}

function rruleValueToIsoDate(value: string): string {
  const digits = value.replace(/[^0-9]/g, '').slice(0, 8);
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** Turns a Custom recurrence dialog's selections into the plain RRULE
 * string that's actually saved — INTERVAL is only written when it's not
 * the implicit default of 1, matching how Google Calendar's own generated
 * rules look. */
export function customRuleToRrule(rule: CustomRecurrenceRule): string {
  const parts = [`FREQ=${FREQ_BY_UNIT[rule.unit]}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.unit === 'week' && rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.ends.type === 'on') parts.push(`UNTIL=${untilToRruleValue(rule.ends.date)}`);
  else if (rule.ends.type === 'after') parts.push(`COUNT=${rule.ends.count}`);
  return parts.join(';');
}

/** Best-effort reverse parse of an existing RRULE string back into the
 * Custom recurrence dialog's fields, for reopening the dialog on a
 * definition that's already using a custom rule. Falls back to a plain
 * weekly-on-the-start-weekday default for anything it can't confidently map
 * back (BYMONTHDAY, positional BYDAY like "2MO", multiple non-weekly
 * quirks) — the dialog is still fully usable from there, it just doesn't
 * pre-fill exactly where Mike left off. */
export function rruleToCustomRule(rrule: string, dtstart: string): CustomRecurrenceRule {
  const fallback = defaultCustomRule(dtstart);
  try {
    const parts: Record<string, string> = {};
    for (const kv of rrule.split(';')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) parts[k.toUpperCase()] = v;
    }
    const unit = UNIT_BY_FREQ[parts.FREQ];
    if (!unit) return fallback;
    const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
    const byDay =
      unit === 'week' && parts.BYDAY ? parts.BYDAY.split(',').filter((d) => WEEKDAY_CODES.includes(d)) : [];
    let ends: CustomRecurrenceRule['ends'] = { type: 'never' };
    if (parts.UNTIL) ends = { type: 'on', date: rruleValueToIsoDate(parts.UNTIL) };
    else if (parts.COUNT) ends = { type: 'after', count: Number(parts.COUNT) };
    return {
      interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
      unit,
      byDay: unit === 'week' ? (byDay.length ? byDay : [weekdayCodeOf(dtstart)]) : [],
      ends,
    };
  } catch {
    return fallback;
  }
}

/** Plain-English summary of a custom rule, e.g. "Every 2 weeks on Monday,
 * Wednesday, ends Dec 7, 2026" — used for the Recurring Tasks list row,
 * where fetching the worker's own live preview for every row just to
 * render the list would be one round trip per definition. The in-form
 * live preview (api.previewRrule) is still the source of truth shown while
 * actually editing; this is only for the closed-form list summary. */
export function describeCustomRrule(rrule: string, dtstart: string): string {
  const rule = rruleToCustomRule(rrule, dtstart);
  const unitLabel = rule.interval === 1 ? rule.unit : `${rule.unit}s`;
  let text = rule.interval === 1 ? `Every ${unitLabel}` : `Every ${rule.interval} ${unitLabel}`;
  if (rule.unit === 'week' && rule.byDay.length > 0) {
    const names = WEEKDAY_CODES.filter((c) => rule.byDay.includes(c)).map(
      (c) => weekdayNameOf(dtstartForWeekdayCode(dtstart, c))
    );
    text += ` on ${names.join(', ')}`;
  }
  if (rule.ends.type === 'on') text += `, ends ${monthDayNameOf(rule.ends.date)}`;
  else if (rule.ends.type === 'after') text += `, ${rule.ends.count} time${rule.ends.count === 1 ? '' : 's'}`;
  return text;
}

// Finds some date that falls on weekday `code`, near `anchorIso`, purely so
// weekdayNameOf (which reads a date's own weekday) can be reused to name an
// arbitrary BYDAY code rather than duplicating a code->name table.
function dtstartForWeekdayCode(anchorIso: string, code: string): string {
  const targetDow = WEEKDAY_CODES.indexOf(code);
  const anchor = parseIso(anchorIso);
  const delta = (targetDow - anchor.getDay() + 7) % 7;
  anchor.setDate(anchor.getDate() + delta);
  return `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`;
}
