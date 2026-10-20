import {
  DEDUCTION_KINDS,
  EARNING_KINDS,
  EVENT_KINDS,
  PAY_KINDS,
  TAX_KINDS,
  type CareerEmployer,
  type CareerEvent,
  type CareerEventKind,
  type DeductionKind,
  type DeductionLine,
  type EarningKind,
  type EarningLine,
  type PayKind,
  type PayLine,
  type Paystub,
  type TaxKind,
} from './types';

/** Validate + normalize what comes in (PDF read, Drive JSON, POST /import)
 * before it is stored. Returns an error string instead of throwing. Never
 * keeps an SSN (NNN-NN-NNNN / XXX-XX-NNNN) or a long account number. */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SSN = /\b(?:\d{3}|X{3}|\*{3})-(?:\d{2}|X{2}|\*{2})-\d{4}\b/i;
const ACCOUNT = /\b\d{9,17}\b/; // routing / account numbers — a trace id is fine to drop too

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? Math.round(n * 100) / 100 : null;
};
const text = (v: unknown, max = 200): string | null => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
const date = (v: unknown): string | null => {
  const s = text(v, 10);
  return s && ISO.test(s) ? s : null;
};
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function scrub(raw: unknown): string | null {
  const json = JSON.stringify(raw);
  if (SSN.test(json)) return 'contains a Social Security number — remove it';
  return null;
}

function lines<K extends string>(raw: unknown, kinds: readonly K[], fallback: K): PayLine<K>[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return 'line list must be an array';
  const out: PayLine<K>[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const label = text(r?.label, 120);
    const current = money(r?.current);
    if (!label) return `line without a label: ${JSON.stringify(r).slice(0, 80)}`;
    if (ACCOUNT.test(label)) return `line label looks like an account number: ${label}`;
    const kind = (kinds as readonly string[]).includes(String(r?.kind)) ? (r.kind as K) : fallback;
    out.push({ label, kind, current: current ?? 0, ytd: money(r?.ytd) });
  }
  return out;
}

export function cleanStub(raw: unknown): Paystub | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const bad = scrub(raw);
  if (bad) return bad;
  const r = raw as Record<string, unknown>;
  const employer = slug(String(r.employer ?? ''));
  if (!employer) return 'employer is missing';
  const pay_date = date(r.pay_date);
  if (!pay_date) return 'pay_date must be YYYY-MM-DD';
  const kind = (PAY_KINDS.includes(r.kind as PayKind) ? r.kind : 'regular') as PayKind;
  const gross = money(r.gross);
  if (gross == null) return 'gross is missing';

  const earnings = lines<EarningKind>(r.earnings, EARNING_KINDS, 'other');
  if (typeof earnings === 'string') return `earnings: ${earnings}`;
  const taxes = lines<TaxKind>(r.taxes, TAX_KINDS, 'other');
  if (typeof taxes === 'string') return `taxes: ${taxes}`;
  const dedRaw = lines<DeductionKind>(r.deductions, DEDUCTION_KINDS, 'other');
  if (typeof dedRaw === 'string') return `deductions: ${dedRaw}`;
  const er = lines<string>(r.employer_contrib, ['401k_match', 'hsa', 'medical', 'other'], 'other');
  if (typeof er === 'string') return `employer_contrib: ${er}`;

  const srcEarn = Array.isArray(r.earnings) ? (r.earnings as Record<string, unknown>[]) : [];
  const srcDed = Array.isArray(r.deductions) ? (r.deductions as Record<string, unknown>[]) : [];
  const earningLines: EarningLine[] = earnings.map((l, i) => ({ ...l, rate: money(srcEarn[i]?.rate), hours: money(srcEarn[i]?.hours) }));
  const deductions: DeductionLine[] = dedRaw.map((l, i) => ({
    ...l,
    pre_tax: srcDed[i]?.pre_tax == null ? ['401k', 'medical', 'dental', 'vision', 'fsa', 'hsa', 'commuter'].includes(l.kind) : !!srcDed[i]?.pre_tax,
  }));

  const rateRaw = r.rate as { amount?: unknown; per?: unknown } | null | undefined;
  const rateAmt = money(rateRaw?.amount);
  const rate = rateAmt != null && ['hour', 'period', 'year'].includes(String(rateRaw?.per)) ? { amount: rateAmt, per: rateRaw!.per as 'hour' | 'period' | 'year' } : null;
  const y = (r.ytd ?? null) as Record<string, unknown> | null;
  const n = Number(r.seq ?? 0);
  const id = text(r.id, 120) ?? `${employer}:${pay_date}:${kind}${n > 1 ? `:${n}` : ''}`;
  const issues = Array.isArray(r.issues) ? (r.issues as unknown[]).map((x) => text(x, 300)).filter((x): x is string => !!x) : [];

  return {
    id,
    employer,
    pay_date,
    period_start: date(r.period_start),
    period_end: date(r.period_end),
    kind,
    provider: text(r.provider, 60),
    gross,
    net: money(r.net),
    taxes_total: money(r.taxes_total),
    pre_tax_total: money(r.pre_tax_total),
    post_tax_total: money(r.post_tax_total),
    rate,
    hours: money(r.hours),
    earnings: earningLines,
    taxes,
    deductions,
    employer_contrib: er,
    ytd: y ? { gross: money(y.gross), taxes: money(y.taxes), net: money(y.net) } : null,
    file_id: text(r.file_id, 200),
    file_name: text(r.file_name, 200),
    issues,
  };
}

export function cleanEvent(raw: unknown): CareerEvent | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const bad = scrub(raw);
  if (bad) return bad;
  const r = raw as Record<string, unknown>;
  const employer = slug(String(r.employer ?? ''));
  if (!employer) return 'employer is missing';
  const d = date(r.date);
  if (!d) return 'date must be YYYY-MM-DD';
  const kind = (EVENT_KINDS.includes(r.kind as CareerEventKind) ? r.kind : 'other') as CareerEventKind;
  const title = text(r.title, 160);
  if (!title) return 'title is missing';
  const n = Number(r.seq ?? 0);
  return {
    id: text(r.id, 120) ?? `${employer}:${d}:${kind}${n > 1 ? `:${n}` : ''}`,
    employer,
    date: d,
    kind,
    title,
    gross: money(r.gross),
    net: money(r.net),
    shares: money(r.shares),
    price: money(r.price),
    remaining: money(r.remaining),
    via_payroll: !!r.via_payroll,
    file_id: text(r.file_id, 200),
    file_name: text(r.file_name, 200),
    notes: text(r.notes, 2000),
  };
}

export function cleanEmployer(raw: unknown): CareerEmployer | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 80);
  if (!name) return 'name is missing';
  const id = slug(String(r.id ?? name));
  if (!id) return 'bad id';
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => text(x, 80)).filter((x): x is string => !!x).slice(0, 10) : []);
  const folders = list(r.folder_names);
  return {
    id,
    name,
    aliases: list(r.aliases),
    folder_names: folders.length ? folders : [name],
    title: text(r.title, 200),
    start_date: date(r.start_date),
    end_date: date(r.end_date),
    is_current: !!r.is_current,
    notes: text(r.notes, 2000),
    salaries: (Array.isArray(r.salaries) ? (r.salaries as Record<string, unknown>[]) : [])
      .map((x) => ({ date: date(x?.date), annual: money(x?.annual), source: text(x?.source, 200) ?? 'document' }))
      .filter((x): x is { date: string; annual: number; source: string } => !!x.date && x.annual != null && x.annual > 0)
      .slice(0, 40),
  };
}
