import type { DeductionKind, EarningKind, PayKind, TaxKind } from './types';

/** Rule-based paystub reader (no AI) for the layouts MikeOS reads on its own
 * every night — today Gusto's "Earnings Statement" (the current employer's
 * payroll). Older employers' stubs were read once by Claude and imported as
 * JSON; a new layout shows "Not read yet" with the reason. Works on pdf.js
 * text (statements/pdfText.ts): one line per printed row. */

export class NotAPaystub extends Error {}

export interface ParsedName {
  employer: string;
  date: string;
  tag: string | null;
  kind: PayKind | null;
}

/** "<Employer> - YYYY.MM.DD[ - <Tag>].pdf" — the tag (Bonus, WFH Stipend,
 * Severance…) says what kind of payment it is. */
export function parseFileName(name: string): ParsedName | null {
  const base = name.replace(/\.(pdf|json)$/i, '').trim();
  const m = /^(.+?)\s*[-–—]\s*(\d{4})[._-](\d{2})[._-](\d{2})(?:\s*[-–—]\s*(.+)|\s*\((.+)\))?$/.exec(base);
  if (!m) return null;
  const tag = (m[5] ?? m[6])?.trim() || null;
  // "(I)" / "(II)" just number two files from the same day.
  const kind = tag && !/^[ivx]+$/i.test(tag) ? kindFromTag(tag) : null;
  return { employer: m[1].trim(), date: `${m[2]}-${m[3]}-${m[4]}`, tag, kind };
}

export function kindFromTag(tag: string): PayKind {
  const t = tag.toLowerCase();
  if (/sever/.test(t)) return 'severance';
  if (/bonus|commission|incentive/.test(t)) return 'bonus';
  if (/stipend|allowance|reimburse/.test(t)) return 'stipend';
  if (/spac|equity|share|stock|option|rsu|vest/.test(t)) return 'equity';
  return 'other';
}

export function earningKind(label: string): EarningKind {
  const l = label.toLowerCase();
  if (/sever/.test(l)) return 'severance';
  if (/bonus|incentive|award|spot/.test(l)) return 'bonus';
  if (/commission/.test(l)) return 'commission';
  if (/stipend|allowance|wfh|work from home|internet|phone|wellness/.test(l)) return 'stipend';
  if (/reimburse|expense/.test(l)) return 'reimbursement';
  if (/group term|gtl|imputed|fringe/.test(l)) return 'imputed';
  if (/rsu|stock|equity|espp|option/.test(l)) return 'equity';
  if (/overtime|\bot\b/.test(l)) return 'overtime';
  if (/holiday/.test(l)) return 'holiday';
  if (/pto|paid time off|vacation|sick|personal|bereave|parental|jury/.test(l)) return 'pto';
  if (/retro/.test(l)) return 'retro';
  if (/salar|regular|base/.test(l)) return 'salary';
  if (/hour/.test(l)) return 'hourly';
  return 'other';
}

export function taxKind(label: string): TaxKind {
  const l = label.toLowerCase();
  if (/social security|oasdi|fica[- ]?ss|\bss\b|soc sec/.test(l)) return 'social_security';
  if (/medicare|\bmed\b|fica[- ]?med/.test(l)) return 'medicare';
  if (/family leave|\bpfl\b|\bfli\b|paid family/.test(l)) return 'pfl';
  if (/\bsdi\b|disability|\bdbl\b/.test(l)) return 'sdi';
  if (/federal|\bfit\b|\bfed\b/.test(l)) return 'federal';
  if (/city|local|nyc|yonkers|\bmct\b|metro/.test(l)) return 'local';
  if (/state|\bny\b|\bct\b|\bnj\b|\bsit\b|withholding/.test(l)) return 'state';
  return 'other';
}

export function deductionKind(label: string): DeductionKind {
  const l = label.toLowerCase();
  if (/roth/.test(l)) return 'roth_401k';
  if (/401|403|retire/.test(l)) return '401k';
  if (/dental/.test(l)) return 'dental';
  if (/vision/.test(l)) return 'vision';
  if (/\bhsa\b|health savings/.test(l)) return 'hsa';
  if (/\bfsa\b|flex|dependent care|dcap/.test(l)) return 'fsa';
  if (/commut|transit|parking/.test(l)) return 'commuter';
  if (/life|ad&d|add\b/.test(l)) return 'life';
  if (/disab|\bstd\b|\bltd\b/.test(l)) return 'disability';
  if (/espp|stock purchase/.test(l)) return 'espp';
  if (/medical|health|\bmed\b|insurance/.test(l)) return 'medical';
  return 'other';
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function longDate(s: string): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
}
const num = (s: string) => {
  const neg = /^-|^\(|\$-/.test(s);
  const v = Number(s.replace(/[^\d.]/g, ''));
  return neg ? -v : v;
};
const MONEY = /-?\(?\$-?[\d,]+\.\d{2}\)?/g;
const round = (n: number) => Math.round(n * 100) / 100;

export interface ReadStub {
  provider: string;
  pay_date: string;
  period_start: string | null;
  period_end: string | null;
  kind: PayKind;
  gross: number;
  net: number | null;
  taxes_total: number | null;
  pre_tax_total: number | null;
  post_tax_total: number | null;
  rate: { amount: number; per: 'hour' | 'period' | 'year' } | null;
  hours: number | null;
  earnings: { label: string; kind: EarningKind; rate: number | null; hours: number | null; current: number; ytd: number | null }[];
  taxes: { label: string; kind: TaxKind; current: number; ytd: number | null }[];
  deductions: { label: string; kind: DeductionKind; pre_tax: boolean; current: number; ytd: number | null }[];
  employer_contrib: { label: string; kind: string; current: number; ytd: number | null }[];
  ytd: { gross: number | null; taxes: number | null; net: number | null };
  issues: string[];
}

/** Gusto "Earnings Statement". Sections are headed by fixed titles; each row
 * ends "$current $ytd". */
function readGusto(text: string, name: string): ReadStub {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.find((l) => /Pay period:/i.test(l)) ?? '';
  const pm = /Pay period:\s*(.+?)\s+-\s+(.+?)\s+Pay Day:\s*(.+)$/i.exec(head);
  const pay_date = pm ? longDate(pm[3]) : null;
  if (!pay_date) throw new NotAPaystub('No "Pay Day" on this statement');
  const issues: string[] = [];

  const SECTIONS = ['Employee Gross Earnings', 'Employee Taxes Withheld', 'Employer Tax', 'Employee Deductions', 'Employer Contributions', 'Summary'];
  const bySection = new Map<string, string[]>();
  let cur: string | null = null;
  for (const l of lines) {
    const s = SECTIONS.find((x) => l.toLowerCase() === x.toLowerCase());
    if (s) {
      cur = s;
      bySection.set(s, []);
      continue;
    }
    if (cur && !/^(Description|Employee Tax|Company Tax)\b.*(Current|Year To Date)/i.test(l)) bySection.get(cur)!.push(l);
  }
  const rows = (sec: string) =>
    (bySection.get(sec) ?? [])
      .map((l) => {
        const amounts = l.match(MONEY) ?? [];
        if (amounts.length < 2) return null;
        const pre = l.slice(0, l.search(/-?\(?\$/)).trim();
        return { pre, amounts: amounts.map(num), raw: l };
      })
      .filter((x): x is { pre: string; amounts: number[]; raw: string } => !!x && !/^None\b/i.test(x.pre));

  const earnings: ReadStub['earnings'] = [];
  let hoursTotal: number | null = null;
  for (const r of rows('Employee Gross Earnings')) {
    if (/^Totals?\b/i.test(r.pre)) {
      const h = /([\d.]+)\s*$/.exec(r.pre);
      hoursTotal = h ? Number(h[1]) : null;
      continue;
    }
    const [current, ytd] = r.amounts.slice(-2);
    const rate = r.amounts.length >= 3 ? r.amounts[r.amounts.length - 3] : null;
    const hm = /(\d+(?:\.\d+)?)\s+-?\(?\$-?[\d,]+\.\d{2}\)?\s+-?\(?\$-?[\d,]+\.\d{2}\)?\s*$/.exec(r.raw);
    const label = r.pre.replace(/\s+[\d.]+$/, '').trim();
    earnings.push({ label, kind: earningKind(label), rate, hours: hm ? Number(hm[1]) : null, current, ytd });
  }
  const last2 = (r: { amounts: number[] }) => ({ current: r.amounts[r.amounts.length - 2], ytd: r.amounts[r.amounts.length - 1] });
  const taxes = rows('Employee Taxes Withheld').map((r) => ({ label: r.pre, kind: taxKind(r.pre), ...last2(r) }));
  const strip = (pre: string) => pre.replace(/\s+(Pre-Tax|Post-Tax|Pre Tax|Post Tax)\b.*$/i, '').trim();
  const deductions = rows('Employee Deductions').map((r) => {
    const label = strip(r.pre);
    return { label, kind: deductionKind(label), pre_tax: !/post/i.test(r.pre), ...last2(r) };
  });
  const employer_contrib = rows('Employer Contributions').map((r) => {
    const label = strip(r.pre);
    return { label, kind: /401|match|retire/i.test(label) ? '401k_match' : /hsa/i.test(label) ? 'hsa' : /medical|health|dental|vision/i.test(label) ? 'medical' : 'other', ...last2(r) };
  });
  const summary = new Map(rows('Summary').map((r) => [r.pre.toLowerCase(), r.amounts.slice(-2)]));
  const sum = (k: string) => summary.get(k) ?? null;
  const gross = sum('gross earnings')?.[0] ?? round(earnings.reduce((s, e) => s + e.current, 0));
  const pre = sum('pre-tax deductions/contributions');
  const tax = sum('taxes');
  const post = sum('post-tax deductions/contributions');
  const net = sum('net pay');

  // Checks: lines add up to the summary, and gross − pre − taxes − post = net.
  const eSum = round(earnings.reduce((s, e) => s + e.current, 0));
  if (Math.abs(eSum - gross) > 0.02) issues.push(`earnings lines ${eSum.toFixed(2)} ≠ gross ${gross.toFixed(2)}`);
  const tSum = round(taxes.reduce((s, t) => s + t.current, 0));
  if (tax && Math.abs(tSum - tax[0]) > 0.02) issues.push(`tax lines ${tSum.toFixed(2)} ≠ taxes ${tax[0].toFixed(2)}`);
  if (net && tax) {
    const calc = round(gross - (pre?.[0] ?? 0) - tax[0] - (post?.[0] ?? 0));
    if (Math.abs(calc - net[0]) > 0.02) issues.push(`gross − deductions − taxes = ${calc.toFixed(2)}, net printed ${net[0].toFixed(2)}`);
  }
  if (!sum('gross earnings') || !net) issues.push('summary block not found');

  const salaried = earnings.find((e) => /salar/i.test(e.label) && e.rate);
  const paid = earnings.filter((e) => e.current !== 0);
  const onlyKinds = (ks: EarningKind[]) => paid.length > 0 && paid.every((e) => ks.includes(e.kind));
  const fromName = parseFileName(name);
  const kind: PayKind = fromName?.kind ?? (onlyKinds(['bonus', 'commission']) ? 'bonus' : onlyKinds(['severance']) ? 'severance' : onlyKinds(['stipend', 'reimbursement']) ? 'stipend' : 'regular');

  return {
    provider: 'Gusto',
    pay_date,
    period_start: pm ? longDate(pm[1]) : null,
    period_end: pm ? longDate(pm[2]) : null,
    kind,
    gross,
    net: net?.[0] ?? null,
    taxes_total: tax?.[0] ?? null,
    pre_tax_total: pre?.[0] ?? null,
    post_tax_total: post?.[0] ?? null,
    rate: salaried?.rate ? { amount: salaried.rate, per: 'hour' } : null,
    hours: hoursTotal,
    earnings,
    taxes,
    deductions,
    employer_contrib,
    ytd: { gross: sum('gross earnings')?.[1] ?? null, taxes: tax?.[1] ?? null, net: net?.[1] ?? null },
    issues,
  };
}

export function parsePaystubPdf(text: string, name: string): ReadStub {
  if (!text.trim()) throw new NotAPaystub('No text in this PDF (a scan?)');
  if (/Earnings Statement/i.test(text) && /Pay period:/i.test(text) && /Employee Gross Earnings/i.test(text)) return readGusto(text, name);
  throw new NotAPaystub('Layout not recognized (only Gusto statements are read automatically)');
}
