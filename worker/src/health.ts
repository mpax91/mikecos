// Parser for Google Health's weekly-report emails (Gmail PDF export). The
// format is a plain, consistent template across every real sample checked
// (16 consecutive weeks, May–Sep 2026) — see the migration's header comment
// for the overall design rationale (self-computed deltas, per-metric null
// handling, upsert-by-week_start).
//
// Text extraction (client-side, pdfjs-dist) groups text items into lines by
// y-position before sending raw text here, the same way pdfplumber's
// extract_text() does — so this parser is written against that line-based
// shape. A real sample, verbatim (page 2 of the PDF, after the header):
//
//   0 26.59 2,821
//   total floors total miles avg. calories burned
//   same as previous week 8.18 over last week 373 over last week
//   660 7h 4m 7 of 9h
//   total active zone minutes avg. restful sleep avg. hrs with 250+ steps
//   183 since last week 0hrs 22min over last week same as previous week
//   66 bpm 166.7lb
//   avg. resting heart rate avg. weight
//   1bpm since last week 2.8lb since last week
//
// i.e. each stat-grid row is three lines: values, labels, deltas (deltas
// are parsed only to confirm alignment — never stored, see migration doc).

export interface ParsedHealthWeek {
  weekStart: string; // YYYY-MM-DD
  weekEnd: string; // YYYY-MM-DD
  totalSteps: number | null;
  avgStepsPerDay: number | null;
  bestDaySteps: number | null;
  bestDayWeekday: string | null;
  totalFloors: number | null;
  totalMiles: number | null;
  avgCaloriesBurned: number | null;
  avgActiveZoneMinutes: number | null;
  avgRestfulSleepMinutes: number | null;
  avgHoursWith250Steps: number | null;
  avgRestingHeartRate: number | null;
  avgWeightLb: number | null;
}

export class HealthParseError extends Error {}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function num(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// "Sep 5" + year 2026 -> "2026-09-05". Handles the Dec/Jan wrap by letting
// the caller pass the year already resolved per-field (see parseHealthWeek).
function monthDayToIso(monthDay: string, year: number): string {
  const m = monthDay.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (!m) throw new HealthParseError(`Unrecognized date "${monthDay}"`);
  const month = MONTHS[m[1]];
  if (month === undefined) throw new HealthParseError(`Unrecognized month "${m[1]}"`);
  return `${year}-${pad2(month + 1)}-${pad2(Number(m[2]))}`;
}

/** Parses the full raw text of one Google Health weekly-report PDF (all
 * pages concatenated, one line per array element after y-grouping) into a
 * structured week. Throws HealthParseError with a specific reason if the
 * text doesn't look like this template at all, so the caller can show a
 * clear "couldn't recognize this file" message rather than importing junk. */
export function parseHealthWeek(rawText: string): ParsedHealthWeek {
  const text = rawText.replace(/\r\n/g, '\n');

  // --- Year, from the email's own send date header, e.g.:
  // "Google Health <google-health-noreply@google.com> Tue, Sep 15, 2026 at 10:45 AM"
  const sentMatch = text.match(/,\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s+at\s+\d{1,2}:\d{2}\s*[AP]M/);
  if (!sentMatch) throw new HealthParseError("Couldn't find the email's send date — this doesn't look like a Google Health weekly report.");
  const sentMonth = MONTHS[sentMatch[1]];
  const sentYear = Number(sentMatch[3]);
  if (sentMonth === undefined || !Number.isFinite(sentYear)) throw new HealthParseError('Unrecognized send-date format.');

  // --- Week range, e.g. "Here are your stats for Sep 5 - Sep 11"
  const rangeMatch = text.match(/Here are your stats for\s+([A-Za-z]{3}\s+\d{1,2})\s*-\s*([A-Za-z]{3}\s+\d{1,2})/);
  if (!rangeMatch) throw new HealthParseError("Couldn't find \"Here are your stats for ...\" — this doesn't look like a Google Health weekly report.");
  const startMonth = MONTHS[rangeMatch[1].slice(0, 3)];
  // A week's start month can be one year earlier than the email's send
  // month only at a Dec->Jan wrap (e.g. sent in Jan, week starts in Dec).
  const startYear = startMonth === 11 && sentMonth === 0 ? sentYear - 1 : sentYear;
  const endMonth = MONTHS[rangeMatch[2].slice(0, 3)];
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  const weekStart = monthDayToIso(rangeMatch[1], startYear);
  const weekEnd = monthDayToIso(rangeMatch[2], endYear);

  // --- Best-day weekday, from the ring row: seven weekday abbreviations in
  // order, with exactly one replaced by the literal "Best day!" — e.g.
  // "Sun Mon Tue Wed Best day! Fri Sat" -> Thu was best (position 4).
  const ringMatch = text.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Best day!)(?:\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Best day!)){6}$/m);
  let bestDayWeekday: string | null = null;
  if (ringMatch) {
    // NOT a plain whitespace split — "Best day!" itself contains a space,
    // so splitting on \s+ would break it into two tokens ("Best", "day!")
    // and indexOf('Best day!') would never match.
    const slots: string[] = ringMatch[0].match(/Sun|Mon|Tue|Wed|Thu|Fri|Sat|Best day!/g) ?? [];
    const idx = slots.indexOf('Best day!');
    if (idx !== -1) bestDayWeekday = WEEKDAYS[idx] ?? null;
  }

  // --- Steps summary line: "Best day · 13,849 Avg 8,308 steps/day 5,387 more than last week"
  const stepsLine = text.match(/Best day\s*·\s*([\d,]+)\s+Avg\s+([\d,]+)\s+steps\/day/);
  const bestDaySteps = stepsLine ? num(stepsLine[1]) : null;
  const avgStepsPerDay = stepsLine ? num(stepsLine[2]) : null;

  // Weekly total steps — the number directly above the "total steps" label
  // line (the big headline number, distinct from the smaller best-day
  // number that appears just before it in reading order).
  const totalStepsMatch = text.match(/\n([\d,]+)\s*\ntotal steps\b/);
  const totalSteps = totalStepsMatch ? num(totalStepsMatch[1]) : null;

  // --- Stat grid: three label groups, each preceded by its value line.
  // Values line has 2 or 3 space-separated tokens matching the label count.
  function gridValues(labelsPattern: RegExp, count: number): (string | null)[] {
    const m = text.match(labelsPattern);
    if (!m) return new Array(count).fill(null);
    const lineStart = text.lastIndexOf('\n', m.index! - 1) + 1;
    const valuesLine = text.slice(lineStart, m.index!).trim();
    // Tokens may themselves contain spaces (e.g. "7h 4m", "4 of 9h") — the
    // grid always has exactly `count` fields, so split conservatively by
    // matching the known shapes rather than naive whitespace splitting.
    return splitGridLine(valuesLine, count);
  }

  const [floorsRaw, milesRaw, caloriesRaw] = gridValues(/\ntotal floors\s+total miles\s+avg\. calories burned\n/, 3);
  const [azmRaw, sleepRaw, hrs250Raw] = gridValues(/\ntotal active zone minutes\s+avg\. restful sleep\s+avg\. hrs with 250\+ steps\n/, 3);
  const [hrRaw, weightRaw] = gridValues(/\navg\. resting heart rate\s+avg\. weight\n/, 2);

  const totalFloors = num(floorsRaw);
  const totalMiles = milesRaw != null ? Number(milesRaw) : null;
  const avgCaloriesBurned = num(caloriesRaw);

  const avgActiveZoneMinutesRaw = num(azmRaw);
  const avgActiveZoneMinutes = avgActiveZoneMinutesRaw === 0 ? null : avgActiveZoneMinutesRaw;

  const sleepMatch = sleepRaw?.match(/(\d+)h\s*(\d+)m/);
  const sleepMinutesRaw = sleepMatch ? Number(sleepMatch[1]) * 60 + Number(sleepMatch[2]) : null;
  const avgRestfulSleepMinutes = sleepMinutesRaw === 0 ? null : sleepMinutesRaw;

  const hrs250Match = hrs250Raw?.match(/([\d.]+)\s+of\s+9h/);
  const avgHoursWith250Steps = hrs250Match ? Number(hrs250Match[1]) : null;

  const hrMatch = hrRaw?.match(/(\d+)\s*bpm/);
  const heartRateRaw = hrMatch ? Number(hrMatch[1]) : null;
  const avgRestingHeartRate = heartRateRaw === 0 ? null : heartRateRaw;

  const weightMatch = weightRaw?.match(/([\d.]+)\s*lb/);
  const avgWeightLb = weightMatch ? Number(weightMatch[1]) : null;

  return {
    weekStart,
    weekEnd,
    totalSteps,
    avgStepsPerDay,
    bestDaySteps,
    bestDayWeekday,
    totalFloors,
    totalMiles,
    avgCaloriesBurned,
    avgActiveZoneMinutes,
    avgRestfulSleepMinutes,
    avgHoursWith250Steps,
    avgRestingHeartRate,
    avgWeightLb,
  };
}

// Splits a grid's value line into exactly `count` fields, where a field can
// itself contain a space ("7h 4m", "4 of 9h", "166.7lb"). Works by matching
// each field's known shape greedily from the left rather than a naive
// whitespace split, since whitespace alone can't tell "7h 4m" (one field)
// apart from "660 7h" (two fields).
function splitGridLine(line: string, count: number): (string | null)[] {
  const tokens = line.split(/\s+/).filter(Boolean);
  const out: (string | null)[] = [];
  let i = 0;
  while (out.length < count && i < tokens.length) {
    const t = tokens[i];
    if (/^\d+h$/.test(t) && tokens[i + 1] && /^\d+m$/.test(tokens[i + 1])) {
      out.push(`${t} ${tokens[i + 1]}`);
      i += 2;
    } else if (/^[\d.]+$/.test(t) && tokens[i + 1] === 'of' && tokens[i + 2] === '9h') {
      out.push(`${t} of 9h`);
      i += 3;
    } else if (/^\d+$/.test(t) && tokens[i + 1] === 'bpm') {
      out.push(`${t} bpm`);
      i += 2;
    } else {
      out.push(t);
      i += 1;
    }
  }
  while (out.length < count) out.push(null);
  return out;
}
