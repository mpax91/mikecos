import type { Bureau, CreditAccount, CreditReport } from './types';

/** Everything on Finance → Credit Reports is derived here on read from the
 * stored reports (no AI, no stored rollups). The key step is MERGING: the
 * same account shows up once per bureau per year, under different creditor
 * spellings ("CITI CARDS CBNA" / "CITIBANK NA"), so records are clustered by
 * brand (aliases below) + the month the account was opened. */

export const REAL_BUREAUS: Bureau[] = ['equifax', 'experian', 'transunion'];
export const BUREAU_LABEL: Record<Bureau, string> = { equifax: 'Equifax', experian: 'Experian', transunion: 'TransUnion', other: 'Other' };
/** Late payments stay on a report 7 years; hard inquiries 2 years. */
export const LATE_YEARS = 7;
export const INQUIRY_YEARS = 2;
/** Reports pulled within this many days of the newest one count as "the
 * latest pull" (Mike pulls all three the same day, but not always). */
const LATEST_SET_DAYS = 120;

// ── Brands ───────────────────────────────────────────────────────────────
const ALIASES: [RegExp, string][] = [
  // Store cards first — "CAP1/KOHLS", "THD/CBNA", "SYNCB/LOWES" belong to the store, not the bank.
  [/\bKOHLS\b|\bKOHL S\b/, 'KOHLS'],
  [/\bTHD\b|\bHOME DEPOT\b/, 'HOMEDEPOT'],
  [/\bLOWES\b|\bLOWE S\b/, 'LOWES'],
  [/\bDELL\b/, 'DELL'],
  [/\bLL ?BEAN\b|\bL L BEAN\b|\bLLBMC\b/, 'LLBEAN'],
  [/\bBROOKS BROTHERS\b|\bBBROS\b/, 'BROOKSBROTHERS'],
  [/\bPNC\b|\bACS\b|\bAFSA\b|\bCES\b/, 'PNC'],
  [/\bDOVENMUEHLE?\b/, 'DOVENMUEHLE'],
  [/\bIMPRINT/, 'IMPRINT'],
  [/\bCOMM?ENITY/, 'COMENITY'],
  [/\bVOLKSWAGEN\b|\bVW\b|\bVCI\b/, 'VW'],
  [/\bAMERICAN EXPRESS\b|\bAMEX\b/, 'AMEX'],
  [/\bBANK OF AMERICA\b|\bBK OF AMER\b|\bBANKAMERICA\b|\bBOFA\b|\bBANK OF AMER\b|\bBOA\b/, 'BOFA'],
  [/\bJPMCB\b|\bCHASE\b|\bJP MORGAN\b|\bJPMORGAN\b/, 'CHASE'],
  [/\bCITI\b|\bCBNA\b|\bCITIBANK\b|\bCITICORP\b|\bCITICARDS\b/, 'CITI'],
  [/\bCAPITAL ONE\b|\bCAP ONE\b|\bCAPONE\b|\bCAPITAL 1\b/, 'CAPONE'],
  [/\bDISCOVER\b|\bDISCOVERBANK\b|\bDFS\b/, 'DISCOVER'],
  [/\bWELLS FARGO\b|\bWF\b|\bWFB\b|\bWFFNB\b|\bWELLSFARGO\b|\bWFBNA\b/, 'WELLS'],
  [/\bSYNCHRONY\b|\bSYNCB\b|\bGECRB\b|\bGE CAPITAL\b|\bGEMB\b/, 'SYNCB'],
  [/\bTARGET\b|\bTD RCS\b|\bTDRCS\b|\bTD BANK USA\b/, 'TARGET'],
  [/\bU ?S BANK\b|\bUSB\b|\bUS BK\b/, 'USBANK'],
  [/\bUSAA\b/, 'USAA'],
  [/\bALLY\b/, 'ALLY'],
  [/\bNAVIENT\b|\bSALLIE MAE\b|\bSLM\b/, 'NAVIENT'],
  [/\bNELNET\b/, 'NELNET'],
  [/\bGREAT LAKES\b|\bGLELSI\b/, 'GREATLAKES'],
  [/\bDEPT OF ED\b|\bDEPT OF EDUCATION\b|\bUS DEPT OF ED\b|\bDEPTEDNELNET\b/, 'DEPTED'],
  [/\bROCKET\b|\bQUICKEN\b/, 'ROCKET'],
  [/\bBARCLAY|\bBARCLAYS\b/, 'BARCLAYS'],
  [/\bGOLDMAN\b|\bGS BANK\b|\bAPPLE CARD\b/, 'GOLDMAN'],
  [/\bTOYOTA\b|\bTFS\b/, 'TOYOTA'],
  [/\bHONDA\b|\bAHFC\b/, 'HONDA'],
  [/\bPAYPAL\b/, 'PAYPAL'],
  [/\bSCHWAB\b/, 'SCHWAB'],
  [/\bMERRILL\b/, 'MERRILL'],
  [/\bVERIZON\b/, 'VERIZON'],
  [/\bT ?MOBILE\b/, 'TMOBILE'],
  [/\bMACYS\b|\bMACY S\b/, 'MACYS'],
];
const STORE_BRANDS = new Set(['KOHLS', 'HOMEDEPOT', 'LOWES', 'DELL', 'LLBEAN', 'BROOKSBROTHERS', 'TARGET', 'MACYS']);
const STOP = new Set([
  'THE',
  'BANK',
  'BK',
  'NA',
  'N',
  'A',
  'USA',
  'US',
  'CARD',
  'CARDS',
  'CRD',
  'SERVICES',
  'SERVICE',
  'SVCS',
  'SVC',
  'CORP',
  'CO',
  'INC',
  'LLC',
  'FSB',
  'OF',
  'FINANCIAL',
  'FIN',
  'CREDIT',
  'NATIONAL',
  'NATL',
  'ASSOCIATION',
  'ASSN',
  'AND',
  'LOAN',
  'LOANS',
  'MORTGAGE',
  'MTG',
  'AUTO',
  'GROUP',
  'CENTER',
]);

export function brandKey(name: string): string {
  const s = ` ${name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  for (const [re, key] of ALIASES) if (re.test(s)) return key;
  const words = s
    .trim()
    .split(' ')
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
  return words[0] ?? s.trim().split(' ')[0] ?? 'UNKNOWN';
}

/** "CITI CARDS CBNA" → "Citi Cards CBNA": all-caps names get Title Case,
 * short tokens (NA, TD, USA, CBNA) stay upper. */
const SMALL_WORDS = new Set(['OF', 'AND', 'THE', 'FOR']);
export function tidyName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .split(' ')
    .map((w) => (SMALL_WORDS.has(w) ? w.toLowerCase() : w.length <= 3 || !/[AEIOUY]/.test(w) || /\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');
}

// ── Dates ────────────────────────────────────────────────────────────────
const ym = (d: string | null) => (d ? d.slice(0, 7) : null);
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const addYears = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10).padEnd(10, '-01').replace(/-$/, '')) - Date.parse(a.slice(0, 10).padEnd(10, '-01').replace(/-$/, ''))) / 86400000);
function dayOf(d: string): string {
  return d.length === 7 ? `${d}-01` : d;
}
function yearsSince(d: string, today: string): number {
  return (Date.parse(today) - Date.parse(dayOf(d))) / (365.25 * 86400000);
}

// ── Output shapes ────────────────────────────────────────────────────────
export interface ReportRow {
  id: string;
  bureau: Bureau;
  source: string | null;
  pulledOn: string;
  fileId: string | null;
  fileName: string | null;
  unreadable: boolean;
  partial: boolean;
  scores: { value: number; model: string | null; bureau: Bureau | null }[];
  accounts: number;
  open: number;
  hardInquiries: number;
  lateMarks: number;
  notes: string | null;
  inLatest: boolean;
}

export interface AccountRecordView {
  reportId: string;
  bureau: Bureau;
  pulledOn: string;
  creditor: string;
  status: string | null;
  statusText: string | null;
  balance: number | null;
  limit: number | null;
  highBalance: number | null;
  monthlyPayment: number | null;
  lastReported: string | null;
  lateCounts: CreditAccount['late_counts'];
  owner: string | null;
  remarks: string[];
}

export interface MergedAccount {
  key: string;
  name: string;
  brand: string;
  kind: string;
  type: string | null;
  owner: string | null;
  opened: string | null;
  closed: string | null;
  /** open | closed | paid | … from the latest pull; 'gone' = no longer on any report. */
  status: string;
  statusText: string | null;
  limit: number | null;
  highBalance: number | null;
  balance: number | null;
  monthlyPayment: number | null;
  lastReported: string | null;
  last4s: string[];
  bureausLatest: Bureau[];
  bureausEver: Bureau[];
  firstSeen: string;
  lastSeen: string;
  onLatest: boolean;
  lates: { month: string; days: number; bureaus: Bureau[]; dropsOff: string; onFile: boolean }[];
  worstLate: number;
  /** What it matches in MikeOS (Wallet card / statements folder), else null. */
  inMikeOS: string | null;
  known: boolean;
  records: AccountRecordView[];
}

export interface MergedInquiry {
  key: string;
  name: string;
  date: string | null;
  type: 'hard' | 'soft';
  bureaus: Bureau[];
  dropsOff: string | null;
  onFile: boolean;
}

export interface CreditCheck {
  key: string;
  tone: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
  accountKey?: string;
}

export interface CreditStats {
  latestPull: string | null;
  latestBureaus: Bureau[];
  openAccounts: number;
  openCards: number;
  totalAccountsEver: number;
  oldestOpened: { name: string; opened: string; years: number } | null;
  avgAgeOpenYears: number | null;
  revolvingLimit: number | null;
  revolvingBalance: number | null;
  utilization: number | null;
  totalDebt: number | null;
  hardInquiries2y: number;
  latesOnFile: number;
  latesEver: number;
  negatives: number;
  nextPull: string;
}

export interface MikeOSMatchSource {
  cards: { nickname: string; issuer: string | null; last4: string | null; active: boolean }[];
  folders: { name: string }[];
  known: Set<string>;
}

export interface CreditSummary {
  reports: ReportRow[];
  years: { year: number; reports: { id: string; bureau: Bureau; pulledOn: string }[] }[];
  accounts: MergedAccount[];
  inquiries: MergedInquiry[];
  addresses: { address: string; firstSeen: string; lastSeen: string; bureaus: Bureau[]; current: boolean }[];
  employers: { name: string; firstSeen: string; lastSeen: string; bureaus: Bureau[] }[];
  names: { name: string; firstSeen: string; lastSeen: string; bureaus: Bureau[] }[];
  scores: { pulledOn: string; bureau: Bureau | null; value: number; model: string | null; reportId: string }[];
  negatives: {
    reportId: string;
    bureau: Bureau;
    pulledOn: string;
    kind: string;
    creditor: string | null;
    date: string | null;
    amount: number | null;
    status: string | null;
    removalDate: string | null;
  }[];
  stats: CreditStats;
  checks: CreditCheck[];
}

/** The next Feb 22 on or after today. */
export function nextPullDate(today: string): string {
  const y = Number(today.slice(0, 4));
  const thisYear = `${y}-02-22`;
  return today <= thisYear ? thisYear : `${y + 1}-02-22`;
}

function isOpenStatus(a: CreditAccount): boolean {
  if (a.closed) return false;
  if (a.status === 'open') return true;
  if (a.status === null) return !/closed|paid|transferred/i.test(a.status_text ?? '');
  return false;
}

function isRevolving(kind: string, type: string | null): boolean {
  return type === 'revolving' || kind === 'credit_card' || kind === 'retail' || kind === 'heloc';
}

const normAddr = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(STREET)\b/g, 'ST')
    .replace(/\b(ROAD)\b/g, 'RD')
    .replace(/\b(AVENUE)\b/g, 'AVE')
    .replace(/\b(DRIVE)\b/g, 'DR')
    .replace(/\b(LANE)\b/g, 'LN')
    .replace(/\b(APARTMENT|APT)\b/g, 'APT')
    .replace(/\b\d{5}(\d{4})?\b/g, (z) => z.slice(0, 5))
    .replace(/\s+/g, ' ')
    .trim();

// ── The summary ──────────────────────────────────────────────────────────
export function summarizeCredit(reportsIn: CreditReport[], match: MikeOSMatchSource, today: string): CreditSummary {
  const reports = [...reportsIn].sort((a, b) => a.pulled_on.localeCompare(b.pulled_on) || a.bureau.localeCompare(b.bureau));
  const readable = reports.filter((r) => !r.unreadable);

  // Latest pull: newest report per real bureau, within LATEST_SET_DAYS of the newest overall.
  const newest = readable.length ? readable[readable.length - 1].pulled_on : null;
  const latestByBureau = new Map<Bureau, CreditReport>();
  for (const r of readable) {
    if (r.bureau === 'other' || !newest) continue;
    if (daysBetween(r.pulled_on, newest) > LATEST_SET_DAYS) continue;
    latestByBureau.set(r.bureau, r);
  }
  const latestIds = new Set([...latestByBureau.values()].map((r) => r.id));
  const latestBureaus = REAL_BUREAUS.filter((b) => latestByBureau.has(b));

  // ── Cluster accounts ──
  type Rec = { a: CreditAccount; r: CreditReport };
  type Cluster = { brand: string; months: number[]; last4s: Set<string>; kind: string; recs: Rec[] };
  const clusters: Cluster[] = [];
  for (const r of readable) {
    for (const a of r.accounts) {
      const brand = brandKey(a.creditor);
      const om = ym(a.opened);
      const mi = om ? monthIndex(om) : null;
      const kind = a.kind ?? 'other';
      let target: Cluster | undefined;
      if (mi !== null) target = clusters.find((c) => c.brand === brand && c.months.some((m) => Math.abs(m - mi) <= 1) && (!a.last4 || c.last4s.size === 0 || c.last4s.has(a.last4) || true));
      if (!target && a.last4) target = clusters.find((c) => c.brand === brand && c.last4s.has(a.last4!));
      if (!target && mi === null) {
        const same = clusters.filter((c) => c.brand === brand && c.kind === kind);
        if (same.length === 1) target = same[0];
      }
      if (!target) {
        target = { brand, months: [], last4s: new Set(), kind, recs: [] };
        clusters.push(target);
      }
      // Two different accounts from one report can't share a cluster.
      if (target.recs.some((x) => x.r.id === r.id) && mi !== null) {
        const alt = clusters.find((c) => c !== target && c.brand === brand && c.months.some((m) => Math.abs(m - mi) <= 1) && !c.recs.some((x) => x.r.id === r.id));
        target = alt ?? { brand, months: [], last4s: new Set(), kind, recs: [] };
        if (!alt) clusters.push(target);
      }
      if (mi !== null && !target.months.includes(mi)) target.months.push(mi);
      if (a.last4) target.last4s.add(a.last4);
      if (target.kind === 'other' && kind !== 'other') target.kind = kind;
      target.recs.push({ a, r });
    }
  }

  // Second pass: one bureau may name a store card only by its bank ("CBNA")
  // while another prints the store — merge clusters that share an exact
  // open DAY and limit and never appear on the same report.
  const exactOpen = (c: Cluster) => new Set(c.recs.map((x) => x.a.opened).filter((d): d is string => !!d && d.length === 10));
  const limitOf = (c: Cluster) => c.recs.map((x) => x.a.limit ?? x.a.high_balance).find((n) => n !== null) ?? null;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      const da = exactOpen(a);
      if (![...exactOpen(b)].some((d) => da.has(d))) continue;
      const la = limitOf(a);
      const lb = limitOf(b);
      if (la !== null && lb !== null && la !== lb) continue;
      const ra = new Set(a.recs.map((x) => x.r.id));
      if (b.recs.some((x) => ra.has(x.r.id))) continue;
      a.recs.push(...b.recs);
      for (const m of b.months) if (!a.months.includes(m)) a.months.push(m);
      for (const l of b.last4s) a.last4s.add(l);
      // Keep the more specific (store) brand.
      if (STORE_BRANDS.has(b.brand) && !STORE_BRANDS.has(a.brand)) a.brand = b.brand;
      clusters.splice(j, 1);
      j--;
    }
  }

  const accounts: MergedAccount[] = clusters.map((c) => {
    const recs = [...c.recs].sort((x, y) => x.r.pulled_on.localeCompare(y.r.pulled_on));
    const latestRecs = recs.filter((x) => latestIds.has(x.r.id));
    const last = recs[recs.length - 1];
    const ref = latestRecs.length ? latestRecs : [last];
    // Opened = the most common printed open date (bureaus mostly agree).
    const openedCounts = new Map<string, number>();
    for (const x of recs) if (x.a.opened) openedCounts.set(x.a.opened, (openedCounts.get(x.a.opened) ?? 0) + 1);
    const opened = [...openedCounts.entries()].sort((p, q) => q[1] - p[1] || q[0].length - p[0].length)[0]?.[0] ?? null;
    const closedDates = recs.map((x) => x.a.closed).filter((d): d is string => !!d);
    const anyOpenLatest = latestRecs.some((x) => isOpenStatus(x.a));
    const status = !latestRecs.length ? 'gone' : anyOpenLatest ? 'open' : (ref.find((x) => x.a.status)?.a.status ?? 'closed');
    const nameCounts = new Map<string, number>();
    for (const x of ref) nameCounts.set(x.a.creditor, (nameCounts.get(x.a.creditor) ?? 0) + 1);
    const name = tidyName([...nameCounts.entries()].sort((p, q) => q[1] - p[1])[0][0]);
    const maxOf = (f: (a: CreditAccount) => number | null) => {
      const v = ref.map((x) => f(x.a)).filter((n): n is number => n !== null);
      return v.length ? Math.max(...v) : null;
    };
    // Lates: union of every month marked late on any report (worst days).
    const lateMap = new Map<string, { days: number; bureaus: Set<Bureau> }>();
    for (const x of recs) {
      for (const l of x.a.late_months) {
        const e = lateMap.get(l.month) ?? { days: 0, bureaus: new Set<Bureau>() };
        e.days = Math.max(e.days, l.days);
        e.bureaus.add(x.r.bureau);
        lateMap.set(l.month, e);
      }
    }
    // Late counts printed with no month grid still count (worst level only).
    let worstCount = 0;
    for (const x of recs) {
      const lc = x.a.late_counts;
      if (lc['120']) worstCount = Math.max(worstCount, 120);
      else if (lc['90']) worstCount = Math.max(worstCount, 90);
      else if (lc['60']) worstCount = Math.max(worstCount, 60);
      else if (lc['30']) worstCount = Math.max(worstCount, 30);
    }
    const lates = [...lateMap.entries()]
      .sort((p, q) => p[0].localeCompare(q[0]))
      .map(([month, e]) => {
        const dropsOff = addYears(month, LATE_YEARS);
        return { month, days: e.days, bureaus: REAL_BUREAUS.filter((b) => e.bureaus.has(b)), dropsOff, onFile: dropsOff > today.slice(0, 7) };
      });
    const worstLate = Math.max(worstCount, ...lates.map((l) => l.days), 0);
    const last4s = [...c.last4s];
    const key = `${c.brand}:${opened ? opened.slice(0, 7) : (last4s[0] ?? name.toUpperCase().replace(/\W+/g, ''))}`;
    const kind = c.kind;
    const type = ref.find((x) => x.a.type)?.a.type ?? null;
    return {
      key,
      name,
      brand: c.brand,
      kind,
      type,
      owner: ref.find((x) => x.a.owner)?.a.owner ?? null,
      opened,
      closed: anyOpenLatest ? null : (closedDates.sort().pop() ?? null),
      status,
      statusText: ref.find((x) => x.a.status_text)?.a.status_text ?? null,
      limit: maxOf((a) => a.limit),
      highBalance: maxOf((a) => a.high_balance),
      balance: maxOf((a) => a.balance),
      monthlyPayment: maxOf((a) => a.monthly_payment),
      lastReported:
        ref
          .map((x) => x.a.last_reported)
          .filter((d): d is string => !!d)
          .sort()
          .pop() ?? null,
      last4s,
      bureausLatest: REAL_BUREAUS.filter((b) => latestRecs.some((x) => x.r.bureau === b)),
      bureausEver: REAL_BUREAUS.filter((b) => recs.some((x) => x.r.bureau === b)),
      firstSeen: recs[0].r.pulled_on,
      lastSeen: last.r.pulled_on,
      onLatest: latestRecs.length > 0,
      lates,
      worstLate,
      inMikeOS: null,
      known: false,
      records: recs.map((x) => ({
        reportId: x.r.id,
        bureau: x.r.bureau,
        pulledOn: x.r.pulled_on,
        creditor: x.a.creditor,
        status: x.a.status,
        statusText: x.a.status_text,
        balance: x.a.balance,
        limit: x.a.limit,
        highBalance: x.a.high_balance,
        monthlyPayment: x.a.monthly_payment,
        lastReported: x.a.last_reported,
        lateCounts: x.a.late_counts,
        owner: x.a.owner,
        remarks: x.a.remarks,
      })),
    };
  });
  // Unique keys (two accounts could collide on brand + month).
  const seenKeys = new Map<string, number>();
  for (const a of accounts) {
    const n = seenKeys.get(a.key) ?? 0;
    seenKeys.set(a.key, n + 1);
    if (n) a.key = `${a.key}#${n + 1}`;
  }
  accounts.sort((a, b) => (a.opened ?? '9999').localeCompare(b.opened ?? '9999') || a.name.localeCompare(b.name));

  // ── Match open accounts to MikeOS (Wallet cards, statement folders) ──
  const cardBrands = match.cards.map((c) => ({ c, brands: new Set([brandKey(c.nickname), c.issuer ? brandKey(c.issuer) : '']) }));
  const folderBrands = match.folders.map((f) => ({ f, brand: brandKey(f.name) }));
  for (const a of accounts) {
    a.known = match.known.has(a.key);
    const byLast4 = match.cards.find((c) => c.last4 && a.last4s.includes(c.last4));
    if (byLast4) {
      a.inMikeOS = `Wallet · ${byLast4.nickname}`;
      continue;
    }
    const byBrand = cardBrands.find((x) => x.brands.has(a.brand));
    if (byBrand && isRevolving(a.kind, a.type)) {
      a.inMikeOS = `Wallet · ${byBrand.c.nickname}`;
      continue;
    }
    const folder = folderBrands.find((x) => x.brand === a.brand);
    if (folder) a.inMikeOS = `Statements · ${folder.f.name}`;
  }

  // ── Inquiries (merged across bureaus: same lender within 7 days) ──
  const inquiries: MergedInquiry[] = [];
  for (const r of readable) {
    for (const q of r.inquiries) {
      const brand = brandKey(q.name);
      const hit = inquiries.find((x) => x.type === q.type && brandKey(x.name) === brand && (x.date && q.date ? Math.abs(daysBetween(x.date, q.date)) <= 7 : x.date === q.date));
      if (hit) {
        if (!hit.bureaus.includes(r.bureau)) hit.bureaus.push(r.bureau);
        continue;
      }
      const dropsOff = q.date ? addYears(dayOf(q.date), INQUIRY_YEARS) : null;
      inquiries.push({
        key: `${brand}:${q.date ?? r.id}:${q.type}`,
        name: tidyName(q.name),
        date: q.date,
        type: q.type,
        bureaus: [r.bureau],
        dropsOff,
        onFile: q.type === 'hard' && !!dropsOff && dropsOff > today,
      });
    }
  }
  inquiries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // ── Personal info ──
  const addrMap = new Map<string, { address: string; firstSeen: string; lastSeen: string; bureaus: Set<Bureau>; current: boolean }>();
  const empMap = new Map<string, { name: string; firstSeen: string; lastSeen: string; bureaus: Set<Bureau> }>();
  const nameMap = new Map<string, { name: string; firstSeen: string; lastSeen: string; bureaus: Set<Bureau> }>();
  for (const r of readable) {
    for (const ad of r.personal.addresses) {
      const k = normAddr(ad.address);
      const e = addrMap.get(k) ?? { address: ad.address, firstSeen: r.pulled_on, lastSeen: r.pulled_on, bureaus: new Set<Bureau>(), current: false };
      e.lastSeen = r.pulled_on;
      e.bureaus.add(r.bureau);
      if (latestIds.has(r.id) && ad.current) e.current = true;
      addrMap.set(k, e);
    }
    for (const em of r.personal.employers) {
      const k = em.name.toUpperCase().replace(/[^A-Z0-9]+/g, '');
      const e = empMap.get(k) ?? { name: tidyName(em.name), firstSeen: r.pulled_on, lastSeen: r.pulled_on, bureaus: new Set<Bureau>() };
      e.lastSeen = r.pulled_on;
      e.bureaus.add(r.bureau);
      empMap.set(k, e);
    }
    for (const n of r.personal.names) {
      const k = n
        .toUpperCase()
        .replace(/[^A-Z ]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const e = nameMap.get(k) ?? { name: n, firstSeen: r.pulled_on, lastSeen: r.pulled_on, bureaus: new Set<Bureau>() };
      e.lastSeen = r.pulled_on;
      e.bureaus.add(r.bureau);
      nameMap.set(k, e);
    }
  }
  const list = <T extends { bureaus: Set<Bureau> }>(m: Map<string, T>) =>
    [...m.values()]
      .map((e) => ({ ...e, bureaus: REAL_BUREAUS.filter((b) => e.bureaus.has(b)) }))
      .sort((a, b) => (b as unknown as { lastSeen: string }).lastSeen.localeCompare((a as unknown as { lastSeen: string }).lastSeen));

  // ── Report rows / years / scores / negatives ──
  const reportRows: ReportRow[] = reports.map((r) => ({
    id: r.id,
    bureau: r.bureau,
    source: r.source,
    pulledOn: r.pulled_on,
    fileId: r.file_id,
    fileName: r.file_name,
    unreadable: r.unreadable,
    partial: !!r.partial,
    scores: r.scores.map((s) => ({ value: s.value, model: s.model, bureau: s.bureau })),
    accounts: r.accounts.length,
    open: r.accounts.filter(isOpenStatus).length,
    hardInquiries: r.inquiries.filter((q) => q.type === 'hard').length,
    lateMarks: r.accounts.reduce((n, a) => n + Math.max(a.late_months.length, a.late_counts['30'] + a.late_counts['60'] + a.late_counts['90'] + a.late_counts['120']), 0),
    notes: r.notes,
    inLatest: latestIds.has(r.id),
  }));
  const yearMap = new Map<number, { id: string; bureau: Bureau; pulledOn: string }[]>();
  for (const r of reports) {
    const y = Number(r.pulled_on.slice(0, 4));
    yearMap.set(y, [...(yearMap.get(y) ?? []), { id: r.id, bureau: r.bureau, pulledOn: r.pulled_on }]);
  }
  const scores = readable.flatMap((r) =>
    r.scores.map((s) => ({ pulledOn: r.pulled_on, bureau: s.bureau ?? (r.bureau === 'other' ? null : r.bureau), value: s.value, model: s.model, reportId: r.id })),
  );
  const negatives = readable.flatMap((r) =>
    r.negatives.map((n) => ({
      reportId: r.id,
      bureau: r.bureau,
      pulledOn: r.pulled_on,
      kind: n.kind,
      creditor: n.creditor,
      date: n.date,
      amount: n.amount,
      status: n.status,
      removalDate: n.removal_date,
    })),
  );
  const latestNegatives = negatives.filter((n) => latestIds.has(n.reportId));

  // ── Stats (latest pull) ──
  const openAccts = accounts.filter((a) => a.status === 'open');
  const onLatest = accounts.filter((a) => a.onLatest);
  const openRevolving = openAccts.filter((a) => isRevolving(a.kind, a.type));
  const sum = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
  const revolvingLimit = sum(openRevolving.map((a) => a.limit));
  const revolvingBalance = sum(openRevolving.map((a) => a.balance));
  const oldest = onLatest.filter((a) => a.opened).sort((a, b) => a.opened!.localeCompare(b.opened!))[0] ?? null;
  const openAges = openAccts.filter((a) => a.opened).map((a) => yearsSince(a.opened!, today));
  const allLates = accounts.flatMap((a) => a.lates.map((l) => ({ ...l, account: a })));
  const stats: CreditStats = {
    latestPull: newest,
    latestBureaus,
    openAccounts: openAccts.length,
    openCards: openRevolving.length,
    totalAccountsEver: accounts.length,
    oldestOpened: oldest ? { name: oldest.name, opened: oldest.opened!, years: Math.floor(yearsSince(oldest.opened!, today)) } : null,
    avgAgeOpenYears: openAges.length ? Math.round((openAges.reduce((s, x) => s + x, 0) / openAges.length) * 10) / 10 : null,
    revolvingLimit,
    revolvingBalance,
    utilization: revolvingLimit && revolvingBalance !== null ? revolvingBalance / revolvingLimit : null,
    totalDebt: sum(openAccts.map((a) => a.balance)),
    hardInquiries2y: inquiries.filter((q) => q.onFile).length,
    latesOnFile: allLates.filter((l) => l.onFile).length,
    latesEver: allLates.length,
    negatives: latestNegatives.length,
    nextPull: nextPullDate(today),
  };

  // ── Things to Check (rule-based) ──
  const checks: CreditCheck[] = [];
  const bl = (bs: Bureau[]) => bs.map((b) => BUREAU_LABEL[b]).join(', ');
  const monthName = (m: string) => new Date(`${m.slice(0, 7)}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (newest && daysBetween(newest, today) > 380)
    checks.push({ key: 'stale', tone: 'warn', title: 'Time for a new pull', detail: `The newest report is from ${monthName(newest)}. Pull all three free at AnnualCreditReport.com.` });
  for (const r of latestByBureau.values())
    if (r.partial)
      checks.push({
        key: `partial:${r.id}`,
        tone: 'info',
        title: `The ${new Date(`${r.pulled_on}T12:00:00Z`).getUTCFullYear()} ${BUREAU_LABEL[r.bureau]} report is only partly loaded`,
        detail: 'Its PDF was too large to read in full, so some accounts and inquiries may be missing from it here. The PDF in Drive is complete.',
      });
  if (newest && latestBureaus.length < 3) {
    const missing = REAL_BUREAUS.filter((b) => !latestByBureau.has(b));
    checks.push({ key: 'missing-bureau', tone: 'info', title: `Latest pull is missing ${bl(missing)}`, detail: 'Each bureau can show different accounts and mistakes — all three are free.' });
  }
  for (const n of latestNegatives)
    checks.push({
      key: `neg:${n.reportId}:${n.creditor}`,
      tone: 'warn',
      title: `${tidyName(n.kind)}${n.creditor ? ` — ${tidyName(n.creditor)}` : ''}`,
      detail: `On ${BUREAU_LABEL[n.bureau]}${n.removalDate ? `; scheduled to come off ${monthName(n.removalDate)}` : ''}.`,
    });
  for (const l of allLates.filter((x) => x.onFile)) {
    const latestShowing = l.account.bureausLatest;
    const only = l.bureaus.length < latestShowing.length && latestShowing.length > 1;
    checks.push({
      key: `late:${l.account.key}:${l.month}`,
      tone: 'warn',
      title: `${l.days} days late — ${l.account.name}, ${monthName(l.month)}`,
      detail: `Drops off ${monthName(l.dropsOff)}.${only ? ` Only ${bl(l.bureaus)} report${l.bureaus.length === 1 ? 's' : ''} it — the others don't, which is worth a goodwill letter or dispute.` : ''}`,
      accountKey: l.account.key,
    });
  }
  // Bureau disagreement: open account the latest pull shows at some bureaus but not others.
  if (latestBureaus.length > 1) {
    for (const b of latestBureaus) {
      if (latestByBureau.get(b)?.partial) continue; // not fully read — absence proves nothing
      const missing = openAccts.filter((a) => a.bureausLatest.length && !a.bureausLatest.includes(b));
      if (missing.length)
        checks.push({
          key: `bureau:${b}`,
          tone: 'info',
          title: `${missing.length} open ${missing.length === 1 ? 'account isn’t' : 'accounts aren’t'} on ${BUREAU_LABEL[b]}`,
          detail: `${missing.map((a) => a.name).join(', ')}. Some lenders don't report to every bureau — a good account missing just means less history there.`,
        });
    }
    for (const a of onLatest) {
      const sts = new Set(
        a.records
          .filter((x) => latestIds.has(x.reportId))
          .map((x) => (x.status === 'open' ? 'open' : x.status ? 'closed' : null))
          .filter(Boolean),
      );
      if (sts.size > 1)
        checks.push({
          key: `status:${a.key}`,
          tone: 'warn',
          title: `Bureaus disagree on ${a.name}`,
          detail: 'One shows it open, another closed. If it’s closed, the open one should be corrected.',
          accountKey: a.key,
        });
    }
  }
  // New since the previous pull: accounts, inquiries, addresses.
  const prevPull = (() => {
    const older = readable.filter((r) => newest && daysBetween(r.pulled_on, newest) > LATEST_SET_DAYS);
    return older.length ? older[older.length - 1].pulled_on : null;
  })();
  if (prevPull) {
    for (const a of accounts.filter((x) => x.onLatest && x.firstSeen > prevPull))
      checks.push({
        key: `new:${a.key}`,
        tone: 'info',
        title: `New account: ${a.name}`,
        detail: `Opened ${a.opened ? monthName(a.opened) : 'recently'} — first on the ${monthName(a.firstSeen)} pull. Make sure it's yours.`,
        accountKey: a.key,
      });
    const newInq = inquiries.filter((q) => q.type === 'hard' && q.date && q.date > prevPull);
    if (newInq.length)
      checks.push({
        key: 'new-inquiries',
        tone: 'info',
        title: `${newInq.length} hard ${newInq.length === 1 ? 'inquiry' : 'inquiries'} since ${monthName(prevPull)}`,
        detail: newInq.map((q) => `${q.name} (${q.date ? monthName(q.date) : '?'})`).join(', ') + '. Each should be something you applied for.',
      });
    for (const ad of list(addrMap).filter((x) => x.firstSeen > prevPull))
      checks.push({ key: `addr:${normAddr(ad.address)}`, tone: 'info', title: 'New address on file', detail: `${ad.address} — first on ${bl(ad.bureaus)} in ${monthName(ad.firstSeen)}.` });
  }
  const notInMikeOS = openAccts.filter((a) => !a.inMikeOS && !a.known);
  if (notInMikeOS.length)
    checks.push({
      key: 'not-in-mikeos',
      tone: 'info',
      title: `${notInMikeOS.length} open ${notInMikeOS.length === 1 ? 'account isn’t' : 'accounts aren’t'} in MikeOS`,
      detail: `${notInMikeOS.map((a) => a.name).join(', ')}. Confirm each is yours (⋯ → Mark as Mine on the account).`,
    });
  if (stats.utilization !== null && stats.utilization >= 0.3)
    checks.push({
      key: 'util',
      tone: 'warn',
      title: `Card balances were ${Math.round(stats.utilization * 100)}% of limits`,
      detail: 'Above 30% on the day the bureaus were updated weighs on scores.',
    });
  if (!stats.latesOnFile && !stats.negatives && newest)
    checks.push({
      key: 'clean',
      tone: 'good',
      title: 'No late payments or negative items on file',
      detail: stats.latesEver ? `${stats.latesEver} older late ${stats.latesEver === 1 ? 'mark has' : 'marks have'} aged off (7-year rule).` : 'Every account reported paid as agreed.',
    });

  return {
    reports: reportRows,
    years: [...yearMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, rs]) => ({
        year,
        reports: [...rs].sort(
          (x, y) => (x.bureau === 'other' ? 9 : REAL_BUREAUS.indexOf(x.bureau)) - (y.bureau === 'other' ? 9 : REAL_BUREAUS.indexOf(y.bureau)) || x.pulledOn.localeCompare(y.pulledOn),
        ),
      })),
    accounts,
    inquiries,
    addresses: list(addrMap).sort((a, b) => Number(b.current) - Number(a.current)),
    employers: list(empMap),
    names: list(nameMap),
    scores,
    negatives,
    stats,
    checks,
  };
}
