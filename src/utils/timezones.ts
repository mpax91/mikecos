// A "what time is it for them" lookup from a plain-text city, inspired by
// "Thanks Bud" (heythanksbud.com)'s HomeSky — a small always-on reminder
// of someone's local time so you don't call at a bad hour, without asking
// for location access or geocoding anything server-side. Deliberately a
// static keyword table, not a geocoding API call: Contacts' `city` field
// is free text ("Denver, CO", "Denver", "London"), so this is a best-effort
// match, not authoritative — good enough for "is it late there right now",
// not for anything that needs to be exactly right.

// U.S. state/territory abbreviation -> IANA zone. Covers the common case
// (a two-letter state on the end of a "City, ST" address) in one lookup.
// A few states straddle two zones in reality (western TX, the FL
// panhandle, northern ID) — mapped to whichever zone covers the larger
// share of the state's population, since a free-text city field has no
// finer signal to go on.
const US_STATE_TZ: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York',
  MI: 'America/Detroit', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
  NC: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  DC: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago',
  OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Denver', MT: 'America/Denver',
  NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu', PR: 'America/Puerto_Rico',
};

// Major-city keyword fallback for when there's no recognizable "City, ST"
// shape — matched by substring against the lowercased city text, longest
// key first so "new york city" doesn't get shadowed by a shorter partial
// match. Intentionally short: this is a fallback for non-U.S. cities and
// U.S. cities entered without a state, not an attempt at a full gazetteer.
const CITY_KEYWORD_TZ_RAW: [string, string][] = [
  ['new york', 'America/New_York'], ['nyc', 'America/New_York'], ['boston', 'America/New_York'],
  ['chicago', 'America/Chicago'], ['denver', 'America/Denver'], ['phoenix', 'America/Phoenix'],
  ['los angeles', 'America/Los_Angeles'], ['san francisco', 'America/Los_Angeles'], ['seattle', 'America/Los_Angeles'],
  ['toronto', 'America/Toronto'], ['vancouver', 'America/Vancouver'], ['mexico city', 'America/Mexico_City'],
  ['london', 'Europe/London'], ['dublin', 'Europe/Dublin'], ['paris', 'Europe/Paris'], ['berlin', 'Europe/Berlin'],
  ['madrid', 'Europe/Madrid'], ['rome', 'Europe/Rome'], ['amsterdam', 'Europe/Amsterdam'], ['zurich', 'Europe/Zurich'],
  ['moscow', 'Europe/Moscow'], ['dubai', 'Asia/Dubai'], ['mumbai', 'Asia/Kolkata'], ['delhi', 'Asia/Kolkata'],
  ['singapore', 'Asia/Singapore'], ['hong kong', 'Asia/Hong_Kong'], ['shanghai', 'Asia/Shanghai'],
  ['beijing', 'Asia/Shanghai'], ['tokyo', 'Asia/Tokyo'], ['seoul', 'Asia/Seoul'],
  ['sydney', 'Australia/Sydney'], ['melbourne', 'Australia/Melbourne'], ['auckland', 'Pacific/Auckland'],
];
const CITY_KEYWORD_TZ: [string, string][] = [...CITY_KEYWORD_TZ_RAW].sort((a, b) => b[0].length - a[0].length);

/** Best-effort IANA zone for a free-text city string, or null when nothing
 * matches. Tries a trailing U.S. state abbreviation first (highest
 * confidence), then falls back to the keyword list. */
export function timezoneForCity(city: string | null | undefined): string | null {
  if (!city) return null;
  const stateMatch = city.match(/\b([A-Za-z]{2})\b\s*$/);
  if (stateMatch) {
    const tz = US_STATE_TZ[stateMatch[1].toUpperCase()];
    if (tz) return tz;
  }
  const lower = city.toLowerCase();
  for (const [keyword, tz] of CITY_KEYWORD_TZ) {
    if (lower.includes(keyword)) return tz;
  }
  return null;
}

/** Short local time for a resolved zone (e.g. "2:14 PM") — always computed
 * live from the current instant, never cached, so it stays correct as time
 * passes without a re-render trigger of its own (callers that show it for
 * more than a moment should re-render on an interval). */
export function localTimeInZone(tz: string, now: Date = new Date()): string {
  return now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

/** Whether `tz`'s local hour falls outside a normal 8am-9pm window right
 * now — used to flag "probably not a great time to call" without being
 * preachy about it. */
export function isUnsociableHour(tz: string, now: Date = new Date()): boolean {
  const hour = Number(now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  return hour < 8 || hour >= 21;
}
