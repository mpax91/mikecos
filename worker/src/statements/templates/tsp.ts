import { check, cents, NotAStatement, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Thrift Savings Plan (Uniformed Services) statements — Drive folder
 * "Thrift Savings Plan", files "TSP - YYYY.Q#.pdf" (quarterly), "TSP -
 * YYYY.pdf" (annual) and the odd on-demand statement ("TSP - 2022.10.05.pdf").
 * Six layouts since 2004 (see docs/statement-templates/tsp.md):
 *   a1  2004-Q4 → 2005-Q4  "QUARTERLY PARTICIPANT STATEMENT" (Mmm DD, YYYY - …)
 *   a2  2006-Q1 → 2012-Q1  "PARTICIPANT STATEMENT For the period: MM/DD/YYYY – …"
 *   a3  2007 → 2011 annual "ANNUAL PARTICIPANT STATEMENT For the year: YYYY"
 *   b1  2012-Q2 → 2022-Q1  "Here's how the value of your TSP account has changed"
 *   b2  2012 → 2021 annual "How your account value changed in YYYY" (2019+ adds a Q4 summary)
 *   c   2022-05 → today    new recordkeeper: "Account Summary MM-DD-YYYY to MM-DD-YYYY"
 * Never stored: account number, SSN digits, date of birth, address,
 * beneficiary names. Period keys: quarterlies use the period end; annual
 * statements `<end>:annual`; on-demand statements `<end>:interim`. */

export type TspKind = 'quarterly' | 'annual' | 'interim';
export type TspLayout = 'a1' | 'a2' | 'a3' | 'b1' | 'b2' | 'c';

export interface TspFund {
  fund: string; // "C Fund", "L 2040", "L Income"
  begin: number | null;
  end: number;
  price: number | null; // ending share price (NAV)
  shares: number | null; // ending shares
  beginPrice: number | null;
  beginShares: number | null;
}

export interface TspReturnRow {
  ytd: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
}

export interface TspValues {
  kind: TspKind;
  layout: TspLayout;
  opening: number;
  /** New-recordkeeper statements open at $0 + "Converted Balance" (05-26-2022). */
  converted: number | null;
  closing: number;
  contributions: number;
  withdrawals: number;
  gain: number;
  /** Annual statements 2019+ carry the 4th quarter on page 1 (there's no separate Q4 file). */
  quarter: { start: string; end: string; opening: number; closing: number; contributions: number; withdrawals: number; gain: number } | null;
  funds: TspFund[];
  /** Election for new money (what contributions/transfers-in buy), percent by fund. */
  contribAlloc: Record<string, number> | null;
  beneficiary: boolean | null;
  /** TSP's own time-weighted personal rate of return, as printed. */
  prr: { value: number; window: 'period' | '12mo' } | null;
  lifetime: { traditional: number; roth: number } | null;
  /** Balance by tax treatment (and employer money) when printed. */
  sources: { traditional: number | null; roth: number | null; employer: number | null } | null;
  /** The TSP's published fund returns printed on the statement (%). */
  fundReturns: { asOf: string; rows: Record<string, TspReturnRow>; personal: TspReturnRow | null } | null;
  /** Net / total expense ratio by fund (%), for the year named. */
  expenses: { year: number; rows: Record<string, number> } | null;
}

// ---------------------------------------------------------------- numbers

const NUM = String.raw`(?:[–-]\s?)?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d+-?`;
const NUM_RE = new RegExp(NUM, 'g');

/** "$1,234.56", "– $39.73", "– 135.24", "23.06-", "-$27.25", ".10" → number. */
export function tspNum(raw: string): number {
  const s = raw.trim();
  const neg = /^[–-]/.test(s) || /-$/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) throw new UnreadableStatement(`Not a number: "${raw}"`);
  return neg ? -n : n;
}

const nums = (s: string) => (s.match(NUM_RE) ?? []).map(tspNum);

/** Percent cell: "14.82%", "– 5.27%", "-.36%", "N/A", "13.16" (2020/21 tables). */
function pct(raw: string | undefined): number | null {
  if (!raw || /N\/A/i.test(raw)) return null;
  const m = raw.match(/([–-])?\s?(\d*\.?\d+)/);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] ? -n : n;
}
const PCT_TOKEN = /(?:[–-]\s?)?\d*\.\d+%?|N\/A/g;

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12', january: '01', february: '02', march: '03', april: '04', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
function monDate(mon: string, d: string, y: string): string {
  const m = MONTHS[mon.toLowerCase()];
  if (!m) throw new UnreadableStatement(`Bad month "${mon}"`);
  return `${y}-${m}-${d.padStart(2, '0')}`;
}
function slashDate(raw: string): string {
  const m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) throw new UnreadableStatement(`Bad date "${raw}"`);
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// ---------------------------------------------------------------- funds

const FUND_TOKEN = /\b(L ?Income|L ?20\d{2}|[GFCSI] Fund|Total|TOTAL)\b/g;

/** "(C) Fund" / "C FUND" / "L 2040 Fund" / "L2040" → "C Fund" / "L 2040". */
export function fundName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  let m = s.match(/\(([GFCSI])\) Fund/i) ?? s.match(/^([GFCSI]) Fund/i);
  if (m) return `${m[1].toUpperCase()} Fund`;
  m = s.match(/^L ?(\d{4}|Income)/i);
  if (m) return `L ${/income/i.test(m[1]) ? 'Income' : m[1]}`;
  return s;
}

/** Tokens of a section: fund labels and numbers in reading order. */
function labelRuns(section: string): { label: string; values: number[] }[] {
  const flat = section.replace(/\bL\s*\n\s*(20\d{2}|Income)/g, 'L $1').replace(/\b([GFCSI])\s*\n\s*Fund\b/g, '$1 Fund');
  const tokenRe = new RegExp(`(L ?Income|L ?20\\d{2}|\\b[GFCSI] (?:Fund|FUND)|\\bTotal\\b|\\bTOTAL\\b)|(${NUM})`, 'g');
  const out: { label: string; values: number[] }[] = [];
  let cur: { label: string; values: number[] } | null = null;
  for (const m of flat.matchAll(tokenRe)) {
    if (m[1]) {
      cur = { label: /total/i.test(m[1]) ? 'Total' : fundName(m[1]), values: [] };
      out.push(cur);
    } else if (cur) cur.values.push(tspNum(m[2]));
  }
  return out;
}

function between(text: string, start: RegExp, end: RegExp | null): string | null {
  const a = text.search(start);
  if (a < 0) return null;
  const rest = text.slice(a);
  if (!end) return rest;
  const b = rest.slice(1).search(end);
  return b < 0 ? rest : rest.slice(0, b + 1);
}

/** Per-fund detail sections (a1, a2, b1): a heading per fund, then
 * "Beginning Balance <price> <shares> <balance>" … "Ending Balance …". */
function fundDetails(text: string): { funds: TspFund[]; txns: ParsedTransaction[] } {
  const section = between(text, /TRANSACTION DETAIL BY FUND/i, null);
  if (!section) return { funds: [], txns: [] };
  const headRe = /^(?:.*\(([GFCSI])\) Fund|(L (?:20\d{2}|Income)) Fund)\s*$/gm;
  const heads = [...section.matchAll(headRe)];
  const funds = new Map<string, TspFund>();
  const txns: ParsedTransaction[] = [];
  heads.forEach((h, i) => {
    const name = h[1] ? `${h[1]} Fund` : fundName(h[2]);
    const body = section.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const after = (label: RegExp) => {
      const at = body.search(label);
      if (at < 0) return null;
      const v = nums(body.slice(at).replace(label, '')).slice(0, 3);
      return v.length >= 2 ? v : null;
    };
    const b = after(/Beginning Balance/);
    const e = after(/Ending Balance/);
    if (!e) return;
    // "Ending Balance $14.70 10.6517 $156.58"; a zero balance can print without the dollar figure.
    const f: TspFund = { fund: name, beginPrice: b?.[0] ?? null, beginShares: b?.[1] ?? null, begin: b?.[2] ?? 0, price: e[0], shares: e[1], end: e[2] ?? 0 };
    const prev = funds.get(name);
    if (!prev || f.end || f.shares) funds.set(name, f);
    // Dated rows: "12/15/04 Contribution $23.02 10.66 2.1595", "01/25/2018 | Interfund Transfer | – $425.79 | $0.00 | – $425.79 | 39.9737 | – 10.6517"
    const rowRe = new RegExp(String.raw`(\d{2}/\d{2}/\d{2,4})\s+(Contribution|Interfund Transfer|[A-Z][A-Za-z /-]+?)\s+((?:${NUM}\s+){1,5}${NUM})`, 'g');
    for (const r of body.matchAll(rowRe)) {
      const v = nums(r[3]);
      const type = r[2].trim();
      if (/Balance/i.test(type)) continue;
      // a1/a2: amount, price, shares; b1: traditional, roth, total, price, shares
      const amount = v.length >= 5 ? v[2] : v[0];
      const price = v.length >= 5 ? v[3] : v[1] ?? null;
      const units = v.length >= 5 ? v[4] : v[2] ?? null;
      const kind: ParsedTransaction['kind'] = /interfund/i.test(type) ? (amount < 0 ? 'transfer_out' : 'transfer_in') : /contribution/i.test(type) ? 'contribution' : /withdraw/i.test(type) ? 'withdrawal' : 'other';
      txns.push({ date: slashDate(r[1]), description: `${type} · ${name}`, kind, amount: round2(amount), units: units ?? null, unitPrice: price ?? null, account: name });
    }
  });
  return { funds: [...funds.values()], txns };
}

// ---------------------------------------------------------------- shared pieces

function beneficiary(text: string): boolean | null {
  const m = text.match(/Beneficiary (?:Designation(?: on File)?|Named):\s*(Yes|No)/i);
  if (m) return /yes/i.test(m[1]);
  if (/You have not designated a beneficiary|You don'?t have any [^.]*beneficiaries/i.test(text)) return false;
  if (/Your (Primary )?Beneficiar(y|ies)/i.test(text) && /Percent|Relationship/i.test(text)) return true;
  return null;
}

/** Contribution election: "Current Contribution Allocation: G FUND = 0% …" (a1),
 * "payments were allocated … L 2040 100%" (a2), the second of two
 * fund-percent blocks (b1), "Your Investment Allocation for Future Contributions" (b2/a3),
 * "Fund Allocation as of …" (c). */
function contribAlloc(text: string, layout: TspLayout, balanceMix?: { fund: string; pct: number }[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  const add = (name: string, p: number) => {
    if (p > 0) out[fundName(name)] = (out[fundName(name)] ?? 0) + p;
  };
  if (layout === 'a1') {
    for (const m of text.matchAll(/(L ?(?:20\d{2}|Income)|[GFCSI] FUND)\s*=\s*(\d+)%/gi)) add(m[1].replace(/FUND/i, 'Fund'), Number(m[2]));
  } else if (layout === 'a2') {
    // Page 1 prints two percent blocks (balance mix and the election for new
    // money) in an order pdf.js scrambles: drop the lines that match the
    // balance mix; what's left is the election.
    const lines = [...text.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+(\d+)%$/gm)].map((m) => ({ fund: fundName(m[1]), pct: Number(m[2]) }));
    const mix = new Map((balanceMix ?? []).map((f) => [f.fund, f.pct]));
    const left = lines.filter((l) => {
      const p = mix.get(l.fund);
      if (p !== undefined && Math.abs(p - l.pct) <= 1) {
        mix.delete(l.fund);
        return false;
      }
      return true;
    });
    if (left.reduce((t, l) => t + l.pct, 0) === 100) left.forEach((l) => add(l.fund, l.pct));
  } else if (layout === 'b1') {
    const rows = [...text.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+(\d+)%$/gm)];
    const half = rows.length / 2;
    if (rows.length >= 2 && Number.isInteger(half)) rows.slice(half).forEach((r) => add(r[1], Number(r[2])));
  } else if (layout === 'c') {
    const sec = between(text, /Fund Allocation as of/i, /Activity Detail by Fund/i);
    if (sec) for (const m of sec.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+(\d+(?:\.\d+)?)%/gm)) add(m[1], Number(m[2]));
  } else {
    const sec = between(text, /Your Investment Allocation for Future Contributions|CONTRIBUTION ALLOCATION/, /TSP Fund Performance|ANNUAL ACTIVITY SUMMARY|TSP Web Site/i);
    if (sec) for (const m of sec.matchAll(/(L (?:20\d{2}|Income)|[GFCSI]) Fund[^%\n]*?(?:\.\s?)+\s*(\d+)%/g)) add(m[1].length === 1 ? `${m[1]} Fund` : m[1], Number(m[2]));
  }
  return Object.keys(out).length ? out : null;
}

function lifetime(text: string): { traditional: number; roth: number } | null {
  let m = text.match(/Your Lifetime TSP Contributions[\s\S]{0,80}?Traditional\s+Roth\s+Total\s*\n?\s*(\$[\d,.]+)\s+(\$[\d,.]+)/);
  if (m) return { traditional: tspNum(m[1]), roth: tspNum(m[2]) };
  m = text.match(/Your Lifetime Contributions[\s\S]{0,120}?Traditional \(Tax-deferred\)\s+(\$[\d,.]+)(?:[\s\S]{0,60}?Roth[^\n$]*?(\$[\d,.]+))?/);
  if (m) return { traditional: tspNum(m[1]), roth: m[2] ? tspNum(m[2]) : 0 };
  m = text.match(/Your Pre-Tax Contributions\s+(\$[\d,.]+)/);
  if (m) {
    const roth = text.match(/Your Roth Contributions\s+(\$[\d,.]+)/);
    return { traditional: tspNum(m[1]), roth: roth ? tspNum(roth[1]) : 0 };
  }
  return null;
}

/** Fund performance table — four printed shapes (see header comment). */
function fundReturns(text: string, periodEnd: string): TspValues['fundReturns'] {
  const rows: Record<string, TspReturnRow> = {};
  let personal: TspReturnRow | null = null;
  const blank = (): TspReturnRow => ({ ytd: null, y1: null, y3: null, y5: null });
  const set = (fund: string, key: keyof TspReturnRow, v: number | null) => {
    (rows[fund] = rows[fund] ?? blank())[key] = v;
  };
  const keyOf = (label: string): keyof TspReturnRow | null =>
    /year to date|ytd/i.test(label) ? 'ytd' : /^1[- ]?year|past 1/i.test(label) ? 'y1' : /^3[- ]?year|past 3/i.test(label) ? 'y3' : /^5[- ]?year|past 5/i.test(label) ? 'y5' : null;
  let asOf = periodEnd;
  const head = text.match(/TSP Fund Performance \(As of (\d{1,2}\/\d{1,2}\/\d{4})\)/);
  if (head) asOf = slashDate(head[1]);

  // (b) 2020–21: "Fund Past 1 Year (%) …" then "L 2050 14.79 9.99 11.42".
  const b = between(text, /Fund Past 1 Year \(%\)/, /To learn more|TSP Net Administrative/);
  if (b) {
    for (const m of b.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+((?:\S+\s+){2}\S+)\s*$/gm)) {
      const v = m[2].trim().split(/\s+/);
      set(m[1], 'y1', pct(v[0]));
      set(m[1], 'y3', pct(v[1]));
      set(m[1], 'y5', pct(v[2]));
    }
    const p = b.match(/Your Rates of Return\s*\n(?:\d\s*\n)?\s*([^\n]*%[^\n]*)/);
    if (p) {
      const v = p[1].match(PCT_TOKEN) ?? [];
      personal = { ytd: null, y1: pct(v[0]), y3: pct(v[1]), y5: pct(v[2]) };
    }
  }
  // (c) new recordkeeper quarterly: "Fund Name YTD 1-Year 3-Year 5-Year" then "L 2040 14.15% …".
  const hdr = text.match(/^Fund Name ((?:YTD )?1-Year 3-Year 5-Year)\s*$/m);
  if (hdr) {
    const keys: (keyof TspReturnRow)[] = /YTD/.test(hdr[1]) ? ['ytd', 'y1', 'y3', 'y5'] : ['y1', 'y3', 'y5'];
    const sec = between(text, /Rates of Return/, /Your Transaction Fee|Your Beneficiaries/) ?? '';
    for (const m of sec.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+(.+)$/gm)) {
      const v = m[2].match(PCT_TOKEN) ?? [];
      if (v.length < keys.length) continue;
      keys.forEach((k, i) => set(m[1], k, pct(v[i])));
    }
  }
  // (d) new recordkeeper annual (transposed): "Fund Name L Income L 2025 …" then "Year to Date …", "1-Year …".
  const d = between(text, /Rates of Return\s*\n\s*Fund Name (?:L|G)/, /Your Transaction Fee|Your Beneficiaries/);
  if (d) {
    let cols: string[] = [];
    for (const line of d.split('\n')) {
      const fm = line.match(/^Fund Name\s+(.*)$/);
      if (fm) {
        cols = [...fm[1].matchAll(/L (?:20\d{2}|Income)|[GFCSI] Fund/g)].map((x) => fundName(x[0]));
        continue;
      }
      const km = line.match(/^(Year to Date|\d-[Yy]ear)\s+(.*)$/);
      if (km && cols.length) {
        const key = keyOf(km[1]);
        const v = km[2].match(PCT_TOKEN) ?? [];
        if (key) cols.forEach((c, i) => set(c, key, pct(v[i])));
      }
    }
  }
  // (a) 2012–19 annual: a letters line ("G F C S I L L L L L") + a names line, then "1-Year …" rows.
  const a = between(text, /TSP Fund Performance \(As of/, /TSP Administrative Expenses|TSP Net Administrative/);
  if (a && !b) {
    const lines = a.split('\n');
    const li = lines.findIndex((l) => /^(?:[GFCSIL] ){4,}[GFCSIL]$/.test(l.trim()));
    if (li >= 0) {
      const letters = lines[li].trim().split(/\s+/);
      const names = lines.slice(li + 1).find((l) => /(Fund|20\d{2}|Income)(\s|$)/.test(l) && /^(Fund|20\d{2}|Income)/.test(l.trim()));
      const tails = names ? names.trim().split(/\s+/).filter((t) => /^(Fund|20\d{2}|Income)$/.test(t)) : [];
      const cols = letters.map((l, i) => (l === 'L' ? `L ${tails[i] ?? ''}`.trim() : `${l} Fund`));
      for (const line of lines) {
        const km = line.match(/^(\d-Year)\s+(.*)$/);
        if (!km) continue;
        const key = keyOf(km[1])!;
        const v = km[2].match(PCT_TOKEN) ?? [];
        cols.forEach((c, i) => set(c, key, pct(v[i])));
        if (v.length > cols.length) (personal = personal ?? blank())[key] = pct(v[cols.length]);
      }
    }
  }
  const clean = Object.fromEntries(Object.entries(rows).filter(([k, r]) => /^(L (20\d{2}|Income)|[GFCSI] Fund)$/.test(k) && (r.ytd !== null || r.y1 !== null || r.y3 !== null || r.y5 !== null)));
  return Object.keys(clean).length ? { asOf, rows: clean, personal } : null;
}

function expenses(text: string): TspValues['expenses'] {
  const head = text.match(/TSP (?:Net |Total )?(?:Administrative )?Expenses for (\d{4})/);
  if (!head) return null;
  const sec = between(text, /TSP (?:Net |Total )?(?:Administrative )?Expenses for \d{4}/, /Did you know|Your Beneficiaries|Activity Summary by Fund|A MESSAGE|\* This is/) ?? '';
  const rows: Record<string, number> = {};
  // Row form (2020–21): "L 2050 49¢ .049%"
  for (const m of sec.matchAll(/^(L (?:20\d{2}|Income)|[GFCSI] Fund)\s+\d+¢\s+(\d*\.\d+)%/gm)) rows[fundName(m[1])] = Number(m[2]);
  // Column form: header of funds then "Net Expense Ratio .043% …" / "Ratio|0.067% …" (repeats per block).
  if (!Object.keys(rows).length) {
    let cols: string[] = [];
    for (const line of sec.split('\n')) {
      const fs = [...line.matchAll(/L (?:20\d{2}|Income)|[GFCSI] Fund/g)].map((x) => fundName(x[0]));
      if (fs.length >= 2 && !/%/.test(line)) cols = fs;
      const ps = line.match(/\d*\.\d+%/g);
      if (ps && cols.length && ps.length >= cols.length && !/¢|\$/.test(line)) cols.forEach((c, i) => (rows[c] = Number(ps[i].replace('%', ''))));
    }
  }
  return Object.keys(rows).length ? { year: Number(head[1]), rows } : null;
}

// ---------------------------------------------------------------- layouts

function detectLayout(text: string): TspLayout {
  if (/Account Summary\s+\d{2}-\d{2}-\d{4} to \d{2}-\d{2}-\d{4}/.test(text)) return 'c';
  if (/ANNUAL PARTICIPANT STATEMENT/.test(text)) return 'a3';
  if (/QUARTERLY PARTICIPANT STATEMENT/.test(text)) return 'a1';
  if (/How your account value changed in \d{4}|A Summary of Your Account Activity in \d{4}/.test(text)) return 'b2';
  if (/Here.s how the value of your TSP account/.test(text)) return 'b1';
  if (/PARTICIPANT STATEMENT/.test(text) && /For the period:/.test(text)) return 'a2';
  throw new UnreadableStatement('Not a recognized TSP statement layout');
}

export function parseTsp(text: string): ParsedStatement {
  if (!/Thrift Savings Plan|THRIFT SAVINGS PLAN|tsp\.gov|TSP\.GOV/i.test(text)) throw new NotAStatement('Not a Thrift Savings Plan statement');
  const layout = detectLayout(text);
  let kind: TspKind = 'quarterly';
  let periodStart: string;
  let periodEnd: string;
  let opening: number;
  let closing: number;
  let contributions = 0;
  let withdrawals = 0;
  let gain: number | null = null;
  let converted: number | null = null;
  let quarter: TspValues['quarter'] = null;
  let funds: TspFund[] = [];
  let txns: ParsedTransaction[] = [];
  let prr: TspValues['prr'] = null;
  let sources: TspValues['sources'] = null;
  const checks: StatementCheck[] = [];
  const req = (m: RegExpMatchArray | null, what: string) => {
    if (!m) throw new UnreadableStatement(`Missing ${what}`);
    return m;
  };

  if (layout === 'c') {
    const p = req(text.match(/Account Summary\s+(\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/), 'Account Summary period');
    periodStart = slashDate(p[1]);
    periodEnd = slashDate(p[2]);
    kind = /Annual Account Statement/.test(text) ? 'annual' : /Quarterly Account Statement/.test(text) ? 'quarterly' : 'interim';
    const amt = (label: string) => {
      const m = text.match(new RegExp(`^${label}\\s*\\n?(?:\\d\\s*\\n)?\\s*(${NUM})\\s*$`, 'm'));
      return m ? tspNum(m[1]) : null;
    };
    opening = amt('Opening Balance') ?? 0;
    converted = amt('Converted Balance');
    closing = req(text.match(new RegExp(`^Closing Balance\\s+(${NUM})`, 'm')), 'Closing Balance').slice(1).map(tspNum)[0];
    const dep = amt('Deposits/Adjustments');
    contributions = dep ?? 0;
    withdrawals = -(amt('Withdrawals') ?? 0);
    const fees = amt('Transaction Fees/Expenses') ?? 0;
    withdrawals = Math.abs(withdrawals) + Math.abs(fees);
    gain = amt('Gains/Losses');
    const r = text.match(/Your Personal Rate of Return\s+(-?\d*\.\d+)%/);
    if (r) prr = { value: Number(r[1]), window: 'period' };
    // Activity Detail by Fund — one column per fund.
    const sec = between(text, /Activity Detail by Fund/, /Important Note|Rates of Return/) ?? '';
    const names = [...(sec.match(/^Fund Name\s+(.*)$/m)?.[1] ?? '').matchAll(/L (?:20\d{2}|Income)|[GFCSI] Fund/g)].map((x) => fundName(x[0]));
    const row = (label: string) => {
      const m = sec.match(new RegExp(`^${label}\\s+(.*)$`, 'm'));
      return m ? nums(m[1]) : [];
    };
    const ob = row('Opening Balance');
    const cb = row('Closing Balance');
    const units = (sec.match(/^Closing Units\s+(.*)$/m)?.[1] ?? '').match(/\d[\d,]*\.\d+/g)?.map((x) => Number(x.replace(/,/g, ''))) ?? [];
    const nav = (sec.match(/^Unit Price \(NAV\)\s+(.*)$/m)?.[1] ?? '').match(/\d[\d,]*\.\d+/g)?.map((x) => Number(x.replace(/,/g, ''))) ?? [];
    const conv = row('Conversion');
    funds = names.map((fund, i) => ({ fund, begin: (ob[i] ?? 0) + (conv[i] ?? 0), end: cb[i] ?? 0, price: nav[i] ?? null, shares: units[i] ?? null, beginPrice: null, beginShares: null }));
    const you = text.match(/^You\s*\n\s*(\$[\d,.]+)\s+\d+%/m);
    const emp = text.match(/^Employer\s*\n\s*(\$[\d,.]+)\s+\d+%/m);
    const trad = text.match(/Traditional\s*\n?\s*\(Tax-\s*\n?\s*deferred\)\s*\n?\s*(\$[\d,.]+)\s+\d+%/);
    const roth = text.match(/^Roth\s*\n?\s*(\$[\d,.]+)\s+\d+%/m);
    if (you || trad) sources = { traditional: trad ? tspNum(trad[1]) : null, roth: roth ? tspNum(roth[1]) : trad ? 0 : null, employer: emp ? tspNum(emp[1]) : null };
  } else if (layout === 'b1') {
    const p = req(text.match(/for the period\s*\n?\s*(\d{2}\/\d{2}\/\d{4})\s*[–-]\s*(\d{2}\/\d{2}\/\d{4})/), 'statement period');
    periodStart = slashDate(p[1]);
    periodEnd = slashDate(p[2]);
    const v = [...text.matchAll(new RegExp(`Value on [A-Z][a-z]+ \\d{1,2}, \\d{4}\\s+(${NUM})`, 'g'))].map((m) => tspNum(m[1]));
    if (v.length < 2) throw new UnreadableStatement('Missing "Value on" lines');
    opening = v[0];
    closing = v[v.length - 1];
    contributions = tspNum(req(text.match(new RegExp(`Contributions and Additions\\s+(${NUM})`)), 'contributions')[1]);
    withdrawals = Math.abs(tspNum(text.match(new RegExp(`Withdrawals and Deductions\\s+(${NUM})`))?.[1] ?? '0.00'));
    gain = tspNum(req(text.match(new RegExp(`Investment Gain \\(or Loss\\)\\s+(${NUM})`)), 'investment gain')[1]);
    const r = text.match(/Your Personal Rate of Return\*?\s*\n(?:[^\n%]*\n){0,2}\s*((?:[–-]\s?)?\d*\.\d+)%/);
    if (r) prr = { value: pct(r[1])!, window: '12mo' };
    // Quarterly summary: label + begin, contributions, withdrawals, transfers, gain, end [+ begin price, shares, end price, shares].
    const sum = between(text, /YOUR QUARTERLY ACCOUNT SUMMARY/i, /YOUR TRANSACTION DETAIL BY SOURCE/i) ?? '';
    const detail = fundDetails(text);
    txns = detail.txns;
    funds = labelRuns(sum.slice(sum.search(/Lifecycle Funds|Individual Funds/) >= 0 ? sum.search(/Lifecycle Funds|Individual Funds/) : 0))
      .filter((r) => r.label !== 'Total' && r.values.length >= 6)
      .map((r) => {
        const d = detail.funds.find((x) => x.fund === r.label);
        return { fund: r.label, begin: r.values[0], end: r.values[5], beginPrice: r.values[6] ?? d?.beginPrice ?? null, beginShares: r.values[7] ?? d?.beginShares ?? null, price: r.values[8] ?? d?.price ?? null, shares: r.values[9] ?? d?.shares ?? null };
      });
    if (!funds.length) funds = detail.funds;
    const src = between(text, /YOUR TRANSACTION DETAIL BY SOURCE/i, /YOUR TRANSACTION DETAIL BY FUND/i) ?? '';
    const end = src.match(new RegExp(`Ending Balance\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})`));
    if (end) sources = { traditional: tspNum(end[1]), roth: tspNum(end[2]), employer: null };
  } else if (layout === 'b2' || layout === 'a3') {
    kind = 'annual';
    const y = layout === 'b2' ? req(text.match(/A Summary of Your Account Activity in (\d{4})|How your account value changed in (\d{4})/), 'year').slice(1).find(Boolean)! : req(text.match(/For the year:?\s*(\d{4})/), 'year')[1];
    periodStart = `${y}-01-01`;
    periodEnd = `${y}-12-31`;
    if (layout === 'b2') {
      opening = tspNum(req(text.match(new RegExp(`Beginning Balance as of January 1, ${y}\\s+(${NUM})`)), 'beginning balance')[1]);
      closing = tspNum(req(text.match(new RegExp(`Ending Balance as of December 31, ${y}[\\s\\d|]*?\\n?\\s*(?:1\\s*\\n\\s*)?(\\$[\\d,]+\\.\\d{2})`)), 'ending balance')[1]);
      contributions = ['Contributions', 'Transfers/Rollovers', 'Loan Disbursements'].reduce((s, l) => s + tspNum(text.match(new RegExp(`^${l}\\s+(${NUM})`, 'm'))?.[1] ?? '0.00'), 0);
      withdrawals = ['In-Service Withdrawals', 'Post-Separation Withdrawals', 'Loan Payments'].reduce((s, l) => s + Math.abs(tspNum(text.match(new RegExp(`^${l}\\s+(${NUM})`, 'm'))?.[1] ?? '0.00')), 0);
      const g = text.match(new RegExp(`^Investment Gain/Loss\\s+(${NUM})`, 'm'));
      gain = g ? tspNum(g[1]) : null;
      const r = text.match(/Your Personal Rate of Return\*?\s*\n\s*Last 12 Months\s*\n\s*((?:[–-]\s?)?\d*\.\d+)%/);
      if (r) prr = { value: pct(r[1])!, window: '12mo' };
      // 2019+: page 1 also covers Q4 ("for the period 10/1/2019 – 12/31/2019").
      const q = text.match(/for the period (\d{1,2}\/\d{1,2}\/\d{4})\s*[–-]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (q) {
        const qs = between(text, /for the period \d{1,2}\/\d{1,2}\/\d{4}/, /Page \d of|A Summary of Your Account/) ?? '';
        const vals = [...qs.matchAll(new RegExp(`Value on [A-Z][a-z]+ \\d{1,2}, \\d{4}\\s+(${NUM})`, 'g'))].map((m) => tspNum(m[1]));
        const c = qs.match(new RegExp(`Contributions and Additions\\s+(${NUM})`));
        const w = qs.match(new RegExp(`Withdrawals and Deductions\\s+(${NUM})`));
        const gq = qs.match(new RegExp(`Investment Gain \\(or Loss\\)\\s+(${NUM})`));
        if (vals.length >= 2 && gq)
          quarter = { start: slashDate(q[1]), end: slashDate(q[2]), opening: vals[0], closing: vals[vals.length - 1], contributions: c ? tspNum(c[1]) : 0, withdrawals: w ? Math.abs(tspNum(w[1])) : 0, gain: tspNum(gq[1]) };
      }
      // Share Summary by Fund: label + begin, gain, end, begin price, begin shares, end price, end shares.
      const ss = between(text, /Share Summary by Fund/, /A MESSAGE|\n\s*1\s*\n|Your 1-year personal/i) ?? '';
      funds = labelRuns(ss)
        .filter((r) => r.label !== 'Total' && r.values.length >= 7)
        .map((r) => ({ fund: r.label, begin: r.values[0], end: r.values[2], beginPrice: r.values[3], beginShares: r.values[4], price: r.values[5], shares: r.values[6] }));
    } else {
      opening = tspNum(req(text.match(new RegExp(`Opening Balance as of January 1, ${y}\\s+(${NUM})`)), 'opening balance')[1]);
      closing = tspNum(req(text.match(new RegExp(`Closing Balance as of December 31, ${y}\\s+(${NUM})`)), 'closing balance')[1]);
      contributions = ['Contributions', 'Transfers/Rollovers', 'Loan Disbursements/Overpayment Refunds'].reduce((s, l) => s + tspNum(text.match(new RegExp(`^\\s*${l.replace('/', '\\/')}\\s+(${NUM})`, 'm'))?.[1] ?? '0.00'), 0);
      withdrawals = ['In-Service Withdrawals', 'Post-Separation Withdrawals', 'Loan Payments'].reduce((s, l) => s + Math.abs(tspNum(text.match(new RegExp(`^\\s*${l}\\s+(${NUM})`, 'm'))?.[1] ?? '0.00')), 0);
      const g = text.match(new RegExp(`^\\s*Investment (?:Gain|Loss)\\s+(${NUM})`, 'm'));
      gain = g ? tspNum(g[1]) : null;
      const r = text.match(/Personal Investment Performance\s*\n?(?:\s*\d\s*\n)?\s*((?:[–-]\s?)?\d*\.\d+)%/);
      if (r) prr = { value: pct(r[1])!, window: '12mo' };
      // ANNUAL ACTIVITY SUMMARY BY FUND: begin bal, begin shares, begin price, contributions, withdrawals, transfers, gain, end shares, end price, end bal.
      const sec = between(text, /ANNUAL ACTIVITY SUMMARY BY FUND/, /ANNUAL CONTRIBUTION SUMMARY/) ?? '';
      funds = labelRuns(sec)
        .filter((r) => r.label !== 'Total' && r.values.length >= 10)
        .map((r) => ({ fund: r.label, begin: r.values[0], beginShares: r.values[1], beginPrice: r.values[2], shares: r.values[7], price: r.values[8], end: r.values[9] }));
    }
  } else if (layout === 'a2') {
    const p = req(text.match(/For the period:\s*(\d{2}\/\d{2}\/\d{4})\s*[–-]\s*(\d{2}\/\d{2}\/\d{4})/), 'statement period');
    periodStart = slashDate(p[1]);
    periodEnd = slashDate(p[2]);
    const sum = between(text, /YOUR QUARTERLY ACCOUNT SUMMARY/i, /payments were allocated|Lifecycle Fund\(s\)|TRANSACTION DETAIL/i) ?? '';
    const runs = labelRuns(sum.slice(Math.max(0, sum.search(/Individual Funds|Lifecycle Funds/))));
    const total = runs.find((r) => r.label === 'Total' && r.values.length >= 6);
    const detail = fundDetails(text);
    txns = detail.txns;
    if (total) {
      [opening, contributions, withdrawals, , gain, closing] = total.values;
      withdrawals = Math.abs(withdrawals);
    } else {
      const src = between(text, /TRANSACTION DETAIL BY SOURCE/, /TRANSACTION DETAIL BY FUND/) ?? '';
      opening = tspNum(req(src.match(new RegExp(`Beginning Balance\\s+(${NUM})`)), 'beginning balance')[1]);
      closing = tspNum(req(src.match(new RegExp(`Ending Balance\\s+(${NUM})`)), 'ending balance')[1]);
    }
    funds = runs
      .filter((r) => r.label !== 'Total' && r.values.length >= 6)
      .map((r) => {
        const d = detail.funds.find((x) => x.fund === r.label);
        return { fund: r.label, begin: r.values[0], end: r.values[5], price: d?.price ?? null, shares: d?.shares ?? null, beginPrice: d?.beginPrice ?? null, beginShares: d?.beginShares ?? null };
      });
    if (!funds.length) funds = detail.funds;
  } else {
    // a1
    const p = req(text.match(/([A-Z][a-z]{2}) (\d{2}), (\d{4}) - ([A-Z][a-z]{2}) (\d{2}), (\d{4})/), 'statement period');
    periodStart = monDate(p[1], p[2], p[3]);
    periodEnd = monDate(p[4], p[5], p[6]);
    const src = between(text, /TRANSACTION DETAIL BY SOURCE/, /TRANSACTION DETAIL BY FUND/) ?? '';
    opening = tspNum(req(src.match(new RegExp(`Beginning Balance\\s+(${NUM})`)), 'beginning balance')[1]);
    closing = tspNum(req(src.match(new RegExp(`Ending Balance\\s+(${NUM})`)), 'ending balance')[1]);
    const g = src.match(new RegExp(`Increase/Decrease in Value\\s+(${NUM})`));
    gain = g ? tspNum(g[1]) : null;
    const detail = fundDetails(text);
    txns = detail.txns;
    // "C Fund $88.48 18.48 0.00 0.00 3.29 $110.25 49%" (2005) — else the fund detail sections.
    const sum = between(text, /TSP FUNDS/, /TRANSACTION DETAIL BY SOURCE/) ?? '';
    const runs = labelRuns(sum).filter((r) => r.label !== 'Total' && r.values.length >= 6);
    funds = runs.length
      ? runs.map((r) => {
          const d = detail.funds.find((x) => x.fund === r.label);
          return { fund: r.label, begin: r.values[0], end: r.values[5], price: d?.price ?? null, shares: d?.shares ?? null, beginPrice: d?.beginPrice ?? null, beginShares: d?.beginShares ?? null };
        })
      : detail.funds;
  }

  // Contributions and withdrawals by source row when the summary didn't carry them (a1).
  if (layout === 'a1' || layout === 'a2') {
    const src = between(text, /TRANSACTION DETAIL BY SOURCE/, /TRANSACTION DETAIL BY FUND/) ?? '';
    const rows = [...src.matchAll(new RegExp(`(\\d{2}/\\d{2}/\\d{2,4})\\s+(Contribution|[A-Z][A-Za-z ]*?Withdrawal[A-Za-z ]*)\\s+(${NUM})`, 'g'))];
    const c = rows.filter((r) => /Contribution/.test(r[2])).reduce((s, r) => s + tspNum(r[3]), 0);
    const w = rows.filter((r) => /Withdrawal/.test(r[2])).reduce((s, r) => s + Math.abs(tspNum(r[3])), 0);
    if (layout === 'a1' || (!contributions && c)) contributions = round2(c);
    if (layout === 'a1' || (!withdrawals && w)) withdrawals = round2(w);
  }

  const fr = fundReturns(text, periodEnd);
  if (!prr && kind === 'annual' && fr?.personal?.y1 !== null && fr?.personal?.y1 !== undefined) prr = { value: fr.personal.y1, window: '12mo' };
  const start = opening + (converted ?? 0);
  const derivedGain = round2(closing - start - contributions + withdrawals);
  if (gain === null) gain = derivedGain;

  // ---- checks ----
  checks.push(check('opening + additions − withdrawals + gain = closing', cents(start + contributions - withdrawals + gain, closing), `${start.toFixed(2)} + ${contributions.toFixed(2)} − ${withdrawals.toFixed(2)} + ${gain.toFixed(2)} vs ${closing.toFixed(2)}`));
  if (funds.length) {
    const sum = round2(funds.reduce((s, f) => s + f.end, 0));
    checks.push(check('funds add up to the closing balance', cents(sum, closing), `${sum.toFixed(2)} vs ${closing.toFixed(2)}`));
    for (const f of funds.filter((x) => x.price !== null && x.shares !== null && x.end > 0)) {
      const calc = f.price! * f.shares!;
      // Shares print to 3–4 decimals and prices to 2–6, so allow a little rounding.
      const tol = 0.02 + f.price! * 0.0006;
      checks.push(check(`${f.fund}: shares × price = balance`, Math.abs(calc - f.end) <= tol, `${f.shares} × ${f.price} = ${calc.toFixed(2)} vs ${f.end.toFixed(2)}`));
    }
  } else if (closing > 0) {
    checks.push(check('fund breakdown found', false, 'No per-fund balances found on the statement'));
  }
  if (quarter) {
    checks.push(check('Q4 summary adds up', cents(quarter.opening + quarter.contributions - quarter.withdrawals + quarter.gain, quarter.closing), `${quarter.opening} → ${quarter.closing}`));
    checks.push(check('Q4 ends at the year-end balance', cents(quarter.closing, closing), `${quarter.closing} vs ${closing}`));
  }

  const values: TspValues = {
    kind,
    layout,
    opening,
    converted,
    closing,
    contributions: round2(contributions),
    withdrawals: round2(withdrawals),
    gain: round2(gain),
    quarter,
    funds,
    contribAlloc: contribAlloc(text, layout, closing > 0 ? funds.filter((f) => f.end > 0).map((f) => ({ fund: f.fund, pct: Math.round((f.end / closing) * 100) })) : []),
    beneficiary: beneficiary(text),
    prr,
    lifetime: lifetime(text),
    sources,
    fundReturns: fr,
    expenses: expenses(text),
  };
  return {
    periodStart,
    periodEnd: kind === 'quarterly' ? periodEnd : `${periodEnd}:${kind}`,
    values: values as unknown as Record<string, unknown>,
    transactions: txns,
    checks,
  };
}
