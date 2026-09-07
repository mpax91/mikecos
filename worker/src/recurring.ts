import { RRule } from 'rrule';

export interface RecurringTaskDefinition {
  id: string;
  title: string;
  project_id: string | null;
  rrule: string; // full RFC5545 RRULE string (no "RRULE:" prefix), e.g. "FREQ=WEEKLY;BYDAY=MO"
  dtstart: string; // 'YYYY-MM-DD'
  active: number; // 0 | 1
  current_task_id: string | null;
  last_spawned_due_date: string | null;
  created_at: string;
  updated_at: string;
}

function isoToUtcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = isoToUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateToIso(d);
}

/** Human-readable summary of an RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO" ->
 * "every week on Monday" — used for the live preview in the Settings form so
 * Mike can sanity-check a raw RRULE before saving it. Throws if the string
 * doesn't parse; callers should catch and show a "can't parse that" message
 * instead of a summary. */
export function describeRrule(rruleStr: string, dtstart: string): string {
  const rule = new RRule({ ...RRule.parseString(rruleStr), dtstart: isoToUtcDate(dtstart) });
  return rule.toText();
}

/** Validates an RRULE string parses at all (without needing a dtstart) —
 * used for cheap field-level validation as Mike types. */
export function isValidRrule(rruleStr: string): boolean {
  try {
    RRule.parseString(rruleStr);
    return true;
  } catch {
    return false;
  }
}

/** The single next occurrence date (inclusive) strictly after
 * `lastSpawnedDueDate` (or on/after `dtstart` if nothing's been spawned yet)
 * and on or before `todayIso`. Returns null if none is due yet. Only ever
 * the EARLIEST such occurrence — a definition spawns at most one task at a
 * time (see spawnDueRecurringTasks), so if several occurrences were missed
 * while the previous instance sat open, the oldest one is what gets spawned
 * next; it lands with a due_date in the past and rolls straight into
 * Overdue, same as any other dated task. */
export function nextDueOccurrenceDate(
  rruleStr: string,
  dtstart: string,
  lastSpawnedDueDate: string | null,
  todayIso: string
): string | null {
  const rule = new RRule({ ...RRule.parseString(rruleStr), dtstart: isoToUtcDate(dtstart) });
  const windowStartIso = lastSpawnedDueDate ? addDaysIso(lastSpawnedDueDate, 1) : dtstart;
  if (windowStartIso > todayIso) return null;
  const windowStart = isoToUtcDate(windowStartIso);
  const windowEnd = isoToUtcDate(todayIso);
  const occurrences = rule.between(windowStart, windowEnd, true);
  if (occurrences.length === 0) return null;
  return utcDateToIso(occurrences[0]);
}
