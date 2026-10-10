/**
 * Voter Insight — everything the contact card's Voter Insight panel shows,
 * derived rule-based from one voter_records row's raw_data (the full
 * original county-file row). No AI, no stored derivations: the raw row is
 * the source of truth, so a better rule here re-applies to every voter on
 * the next page load without a backfill.
 *
 * Column facts (confirmed against Mike's real Bedford export, 2026-10-10):
 * - Election columns are named YY + 3-letter code: 18NOV … 26NOV (generals;
 *   odd years are the town/local elections), 16PRE/20PRE/24PRE
 *   (presidential primaries), 20JUN/22AUG/24APR/… (primaries), 25FEB
 *   (special), 20MAR … 26MAR (village elections — almost nobody in Bedford
 *   has one). A voted cell holds the code itself; a missed one is blank.
 * - "VOTE METHOD 24NOV" holds how they voted (MAC machine, EAR early, ABS
 *   absentee, AFF affidavit, EMG emergency, or combos like ABS/EAR).
 * - Values may carry a CSV formula escape (="10/07/2021").
 * - NYSVOTERID is the stable statewide id (VOTERID is the county's) — the
 *   durable key personal contacts are linked to the roll by (see
 *   contact_voter_links, migration 0097).
 * - The file also carries modeled ethnicity columns; this module never
 *   reads them.
 */

export const ELECTION_CODE_RE = /^(\d{2})(NOV|PRE|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|DEC)$/;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export type ElectionKind = 'general' | 'local' | 'primary' | 'presidentialPrimary' | 'special' | 'village';

export interface VoterElection {
  code: string;
  /** Approximate election day (ISO date) — exact for generals. */
  date: string;
  kind: ElectionKind;
  voted: boolean;
  /** Counted in this voter's turnout (registered by then, and a primary
   * only when their party actually has one — see eligibility below). */
  eligible: boolean;
  method: string | null;
}

export interface TurnoutCount {
  voted: number;
  eligible: number;
}

export interface VoterInsight {
  voterKey: string | null;
  partyCode: string | null;
  partyName: string | null;
  born: string | null;
  registered: string | null;
  elections: VoterElection[];
  turnout: TurnoutCount;
  splits: { general: TurnoutCount; local: TurnoutCount; primary: TurnoutCount };
  lastVoted: string | null;
  methods: Record<string, number>;
  ed: string | null;
  townCode: string | null;
  status: string | null;
  partyChange: string | null;
  partyPositions: string[];
  electedOffice: string | null;
  cellPhone: string | null;
  insights: string[];
}

/** NY party enrollment codes → display names. Full names pass through. */
const PARTY_NAMES: Record<string, string> = {
  DEM: 'Democrat',
  REP: 'Republican',
  CON: 'Conservative',
  WOR: 'Working Families',
  WFP: 'Working Families',
  NON: 'Unaffiliated',
  BLK: 'Unaffiliated',
  IND: 'Independence',
  GRE: 'Green',
  LBT: 'Libertarian',
  OTH: 'Other',
};

export function partyCodeOf(party: string | null | undefined): string | null {
  const p = (party ?? '').trim().toUpperCase();
  if (!p) return null;
  if (PARTY_NAMES[p]) return p;
  for (const [code, name] of Object.entries(PARTY_NAMES)) {
    if (name.toUpperCase() === p) return code;
  }
  if (p.startsWith('DEMOC')) return 'DEM';
  if (p.startsWith('REPUB')) return 'REP';
  if (p.startsWith('CONSERV')) return 'CON';
  if (p.startsWith('WORKING')) return 'WOR';
  if (p.startsWith('UNAFF') || p === 'NO PARTY' || p === 'BLANK') return 'NON';
  return p.slice(0, 3);
}

export function partyNameOf(party: string | null | undefined): string | null {
  const code = partyCodeOf(party);
  if (!code) return null;
  return PARTY_NAMES[code] ?? (party ?? '').trim();
}

/** Lean of a registration: D, R or null (no lean / minor party with no
 * clear side). CON leans R and WOR leans D — they cross-endorse. */
function registrationLean(code: string | null): 'D' | 'R' | null {
  if (code === 'DEM' || code === 'WOR') return 'D';
  if (code === 'REP' || code === 'CON') return 'R';
  return null;
}

function modeledLean(calculated: string | null): 'D' | 'R' | null {
  const c = (calculated ?? '').toLowerCase();
  if (/democrat|\bdem\b/.test(c)) return 'D';
  if (/republican|\bgop\b|\brep\b/.test(c)) return 'R';
  return null;
}

export function cleanRaw(v: string | null | undefined): string | null {
  if (v == null) return null;
  let s = String(v).trim();
  if (s.startsWith('=')) s = s.slice(1);
  s = s.replace(/^"+|"+$/g, '').trim();
  return s || null;
}

function rawGet(raw: Record<string, string>, ...names: string[]): string | null {
  for (const n of names) {
    if (n in raw) {
      const v = cleanRaw(raw[n]);
      if (v) return v;
    }
  }
  // Case/spacing-insensitive fallback.
  const want = names.map((n) => n.toUpperCase().replace(/[\s_]+/g, ' '));
  for (const k of Object.keys(raw)) {
    if (want.includes(k.toUpperCase().replace(/[\s_]+/g, ' '))) {
      const v = cleanRaw(raw[k]);
      if (v) return v;
    }
  }
  return null;
}

/** Stable key for linking a person on the roll across re-imports. */
export function voterKeyOf(raw: Record<string, string>): string | null {
  return rawGet(raw, 'NYSVOTERID', 'NYS VOTER ID', 'SBOEID') ?? rawGet(raw, 'VOTERID', 'VOTER ID');
}

/** MM/DD/YYYY (or ISO) → YYYY-MM-DD. */
function isoDate(v: string | null): string | null {
  if (!v) return null;
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** General election day: the Tuesday after the first Monday of November. */
function generalElectionDay(year: number): string {
  const d = new Date(Date.UTC(year, 10, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // first Monday
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function electionMeta(code: string): { date: string; kind: ElectionKind; year: number } | null {
  const m = code.trim().toUpperCase().match(ELECTION_CODE_RE);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const tag = m[2];
  if (tag === 'NOV') return { date: generalElectionDay(year), kind: year % 2 === 1 ? 'local' : 'general', year };
  // Presidential primaries moved around (Apr 2016, Jun 2020, Apr 2024);
  // late April is close enough for "registered by then" / "has it happened".
  if (tag === 'PRE') return { date: `${year}-04-28`, kind: 'presidentialPrimary', year };
  const month = MONTHS[tag];
  // Late in the month: NY's June primary is the 4th Tuesday.
  const date = `${year}-${String(month).padStart(2, '0')}-28`;
  if (tag === 'MAR') return { date, kind: 'village', year };
  if (tag === 'FEB') return { date, kind: 'special', year };
  return { date, kind: 'primary', year };
}

const KIND_ORDER: Record<ElectionKind, number> = {
  general: 0,
  local: 0,
  presidentialPrimary: 1,
  primary: 1,
  special: 2,
  village: 3,
};

/**
 * @param today ISO date — elections after it (e.g. 26NOV before Nov 3 2026)
 *   are left out entirely rather than counted as missed.
 */
export function buildVoterInsight(
  rawData: string | Record<string, string>,
  record: { party?: string | null; calculated_party?: string | null; household_party?: string | null; registered_date?: string | null },
  today: string
): VoterInsight {
  let raw: Record<string, string> = {};
  if (typeof rawData === 'string') {
    try {
      raw = JSON.parse(rawData) as Record<string, string>;
    } catch {
      raw = {};
    }
  } else raw = rawData;

  const partyRaw = record.party ?? rawGet(raw, 'PARTY');
  const partyCode = partyCodeOf(partyRaw);
  const registered = isoDate(cleanRaw(record.registered_date) ?? rawGet(raw, 'REG_DT', 'REG DT'));
  const born = isoDate(rawGet(raw, 'BIRTHDATE', 'DOB'));

  // Election columns, in file order, de-duplicated.
  const codes: string[] = [];
  for (const k of Object.keys(raw)) {
    const code = k.trim().toUpperCase();
    if (ELECTION_CODE_RE.test(code) && !codes.includes(code)) codes.push(code);
  }

  const votedVillage = codes.some((c) => c.endsWith('MAR') && !!cleanRaw(raw[c]));
  const hasPrimaries = partyCode === 'DEM' || partyCode === 'REP';

  const elections: VoterElection[] = [];
  const methods: Record<string, number> = {};
  for (const code of codes) {
    const meta = electionMeta(code)!;
    if (meta.date > today) continue; // hasn't happened yet
    const voted = !!cleanRaw(raw[code]);
    const method = rawGet(raw, `VOTE METHOD ${code}`);
    if (voted && method) methods[method] = (methods[method] ?? 0) + 1;
    let eligible = true;
    if (registered && meta.date < registered) eligible = false;
    // NY primaries are closed: unaffiliated and minor-party voters usually
    // have nothing to vote in, so a blank there isn't a miss.
    if ((meta.kind === 'primary' || meta.kind === 'presidentialPrimary') && !hasPrimaries) eligible = false;
    if (meta.kind === 'village' && !votedVillage) eligible = false;
    // Specials only cover part of the town (one district) — not a miss.
    if (meta.kind === 'special') eligible = false;
    if (voted) eligible = true; // a vote always counts
    elections.push({ code, date: meta.date, kind: meta.kind, voted, eligible, method });
  }

  // Grouped generals → primaries → specials → village, oldest first in
  // each group — the same rows the Voter Intelligence app shows.
  elections.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.date.localeCompare(b.date));

  const count = (pred: (e: VoterElection) => boolean): TurnoutCount => {
    const set = elections.filter((e) => e.eligible && pred(e));
    return { voted: set.filter((e) => e.voted).length, eligible: set.length };
  };
  const turnout = count(() => true);
  const splits = {
    general: count((e) => e.kind === 'general'),
    local: count((e) => e.kind === 'local'),
    primary: count((e) => e.kind === 'primary' || e.kind === 'presidentialPrimary'),
  };

  const votedSorted = elections.filter((e) => e.voted).sort((a, b) => b.date.localeCompare(a.date));
  const lastVoted = votedSorted[0]?.code ?? null;

  // Party changes: "2025 CHANGE" style columns carry "DEM>REP".
  const changes: string[] = [];
  for (const k of Object.keys(raw)) {
    const m = k.trim().toUpperCase().match(/^(\d{4}) CHANGE$/);
    const v = cleanRaw(raw[k]);
    if (m && v && v.toUpperCase() !== k.trim().toUpperCase()) changes.push(`${v} (${m[1]})`);
  }
  const partyChange = changes.length > 0 ? changes.join(', ') : null;

  const partyPositions = [rawGet(raw, 'PARTY POSITION1'), rawGet(raw, 'PARTY POSITION2')].filter((v): v is string => !!v);
  const electedOffice = [rawGet(raw, 'ELECTED OFFICIAL POSITION'), rawGet(raw, 'ELECTED OFFICIAL')].find((v) => !!v && v.toUpperCase() !== 'ELECTED OFFICIAL') ?? null;

  // ---- Rule-based insights (plain sentences, most useful first) ----
  const insights: string[] = [];
  const pct = (t: TurnoutCount) => (t.eligible > 0 ? t.voted / t.eligible : null);

  const lastGeneral = elections
    .filter((e) => e.kind === 'general' && e.eligible)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastLocal = elections
    .filter((e) => e.kind === 'local' && e.eligible)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  if (turnout.eligible === 0) {
    insights.push('No elections on file since they registered.');
  } else if (turnout.voted === 0) {
    insights.push("Hasn't voted in any election on file.");
  }

  const localPct = pct(splits.local);
  const generalPct = pct(splits.general);
  if (localPct != null && splits.local.eligible >= 2) {
    if (localPct === 1) insights.push(`Votes in every local (odd-year) election — ${splits.local.voted} of ${splits.local.eligible}.`);
    else if (localPct === 0) insights.push(`Skips local (odd-year) town elections — 0 of ${splits.local.eligible}.`);
    else if (generalPct != null && generalPct - localPct >= 0.5) insights.push('Votes in even-year generals but mostly skips local elections.');
  }
  if (lastGeneral && !lastGeneral.voted) insights.push(`Missed the last general election (${lastGeneral.code}).`);
  if (lastLocal && lastLocal.voted) insights.push(`Voted in the last town election (${lastLocal.code}).`);

  const regLean = registrationLean(partyCode);
  const calcLean = modeledLean(record.calculated_party ?? null);
  const partyName = partyNameOf(partyRaw);
  if (calcLean && regLean && calcLean !== regLean) {
    insights.push(`Registered ${partyName}, but modeled ${record.calculated_party} — cross-pressured.`);
  } else if (calcLean && !regLean && partyCode) {
    insights.push(`Registered ${partyName}; modeled ${record.calculated_party}.`);
  }
  const hhLean = modeledLean(record.household_party ?? null);
  if (hhLean && regLean && hhLean !== regLean) insights.push(`Household leans ${record.household_party}.`);

  if (!hasPrimaries && partyCode) {
    const votedPrimaries = splits.primary.voted;
    insights.push(
      votedPrimaries > 0
        ? `${partyName} — voted in ${votedPrimaries} primar${votedPrimaries === 1 ? 'y' : 'ies'} (NY primaries are closed; others aren't counted as missed).`
        : `${partyName} — NY primaries are closed, so primaries aren't counted against their turnout.`
    );
  }

  const earlyOrAbs = Object.entries(methods)
    .filter(([m]) => /EAR|ABS/.test(m.toUpperCase()))
    .reduce((s, [, n]) => s + n, 0);
  const methodTotal = Object.values(methods).reduce((s, n) => s + n, 0);
  if (methodTotal >= 2 && earlyOrAbs / methodTotal >= 0.5) insights.push(`Usually votes early or absentee (${earlyOrAbs} of ${methodTotal}).`);

  if (registered) {
    const regYear = Number(registered.slice(0, 4));
    const thisYear = Number(today.slice(0, 4));
    if (thisYear - regYear <= 2) insights.push(`New registrant (${registered.slice(0, 4)}).`);
  }
  if (partyChange) insights.push(`Party change on file: ${partyChange}.`);
  if (partyPositions.length > 0) insights.push(`Party position: ${partyPositions.join(', ')}.`);
  if (electedOffice) insights.push(`Elected official: ${electedOffice}.`);

  return {
    voterKey: voterKeyOf(raw),
    partyCode,
    partyName,
    born,
    registered,
    elections,
    turnout,
    splits,
    lastVoted,
    methods,
    ed: rawGet(raw, 'ED CODE', 'ED'),
    townCode: rawGet(raw, 'TOWN CODE'),
    status: rawGet(raw, 'STATUS'),
    partyChange,
    partyPositions,
    electedOffice,
    cellPhone: rawGet(raw, 'CELL PHONE'),
    insights,
  };
}

// ---- Card vs. voter file differences (the "check before overwriting") ----

export type VoterDiffField = 'address' | 'city' | 'birthday';

export interface VoterDiff {
  field: VoterDiffField;
  label: string;
  mine: string;
  voter: string;
  /** What "Use Voter File" writes — server-side only, re-derived on apply. */
  apply: Record<string, string | number | null>;
}

const STREET_ABBR: [RegExp, string][] = [
  [/\broad\b/g, 'rd'],
  [/\bstreet\b/g, 'st'],
  [/\bavenue\b/g, 'ave'],
  [/\blane\b/g, 'ln'],
  [/\bdrive\b/g, 'dr'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\bboulevard\b/g, 'blvd'],
  [/\bcircle\b/g, 'cir'],
  [/\bterrace\b/g, 'ter'],
  [/\bhighway\b/g, 'hwy'],
  [/\bparkway\b/g, 'pkwy'],
  [/\bnorth\b/g, 'n'],
  [/\bsouth\b/g, 's'],
  [/\beast\b/g, 'e'],
  [/\bwest\b/g, 'w'],
  [/\bapartment\b|\bapt\b|\bunit\b|#/g, ' '],
];

/** "18 BIRCH LN, KATONAH, NY 10536" → "18 Birch Ln, Katonah, NY 10536".
 * Only applied to text written onto (or shown against) Mike's own cards —
 * bare voter-roll contacts keep the file's text as-is. Leaves mixed-case
 * text alone (someone already typed it properly). */
export function titleCaseVoterText(v: string | null | undefined): string | null {
  if (!v) return v ?? null;
  if (v !== v.toUpperCase()) return v;
  return v
    .toLowerCase()
    .replace(/\b([a-z])([a-z']*)/g, (_m, a: string, b: string) => a.toUpperCase() + b)
    .replace(/\b(Ny|Nj|Ct|Us|Po|Apt|Nw|Ne|Sw|Se)\b/g, (m) => (m === 'Apt' ? 'Apt' : m.toUpperCase()))
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_m, n: string, suf: string) => n + suf.toLowerCase());
}

export function normalizeStreet(addr: string | null | undefined): string {
  let s = (addr ?? '').split(',')[0].toLowerCase();
  s = s.replace(/[.]/g, '');
  for (const [re, rep] of STREET_ABBR) s = s.replace(re, rep);
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtBirthday(m: number | null, d: number | null, y: number | null): string {
  if (!m || !d) return '';
  return `${MONTH_NAMES[m - 1]} ${d}${y ? `, ${y}` : ''}`;
}

/**
 * Where a personal contact's own fields disagree with the voter file.
 * A blank on the card isn't a difference (merges already fill blanks);
 * this only reports cases where applying the voter value would REPLACE
 * something Mike has — plus a missing birth year, which is an addition
 * but worth a confirm because a mismatched year usually means a
 * different person (parent/child with the same name).
 */
export function voterDiffs(
  contact: { address: string | null; city: string | null; birthday_month: number | null; birthday_day: number | null; birthday_year: number | null },
  voter: { address: string | null; city: string | null; birthday_month: number | null; birthday_day: number | null; birthday_year: number | null }
): VoterDiff[] {
  const diffs: VoterDiff[] = [];
  if (contact.address && voter.address && normalizeStreet(contact.address) !== normalizeStreet(voter.address)) {
    const v = titleCaseVoterText(voter.address)!;
    diffs.push({ field: 'address', label: 'Address', mine: contact.address, voter: v, apply: { address: v } });
  }
  if (contact.city && voter.city && contact.city.trim().toLowerCase() !== voter.city.trim().toLowerCase()) {
    const v = titleCaseVoterText(voter.city)!;
    diffs.push({ field: 'city', label: 'City', mine: contact.city, voter: v, apply: { city: v } });
  }
  if (contact.birthday_month && voter.birthday_month) {
    const sameDay = contact.birthday_month === voter.birthday_month && contact.birthday_day === voter.birthday_day;
    const yearConflict = !!contact.birthday_year && !!voter.birthday_year && contact.birthday_year !== voter.birthday_year;
    const yearMissing = !contact.birthday_year && !!voter.birthday_year;
    if (!sameDay || yearConflict || yearMissing) {
      diffs.push({
        field: 'birthday',
        label: !sameDay || yearConflict ? 'Birthday' : 'Birth Year',
        mine: fmtBirthday(contact.birthday_month, contact.birthday_day, contact.birthday_year),
        voter: fmtBirthday(voter.birthday_month, voter.birthday_day, voter.birthday_year),
        apply: { birthday_month: voter.birthday_month, birthday_day: voter.birthday_day, birthday_year: voter.birthday_year },
      });
    }
  }
  return diffs;
}
