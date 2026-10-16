import type { Bureau, CreditAccount, CreditReport } from './types';

const BUREAUS = new Set<Bureau>(['equifax', 'experian', 'transunion', 'other']);
const TYPES = new Set(['revolving', 'installment', 'mortgage', 'open', 'other']);
const OWNERS = new Set(['individual', 'joint', 'authorized_user']);
const STATUSES = new Set(['open', 'closed', 'paid', 'transferred', 'charged_off', 'collection', 'other']);
// An SSN in any form (full, or masked like XXX-XX-1234) never gets stored.
const SSN_RE = /\b[\dXx*]{3}[- ][\dXx*]{2}[- ]\d{4}\b/;

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const int = (v: unknown): number => {
  const n = num(v);
  return n !== null && n > 0 ? n : 0;
};
/** YYYY-MM-DD or YYYY-MM; anything else → null. */
export function cleanDate(v: unknown): string | null {
  const s = str(v, 20);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 1950 || y > 2100 || mo < 1 || mo > 12) return null;
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}
const arr = <T>(v: unknown, max: number, f: (x: unknown) => T | null): T[] =>
  Array.isArray(v)
    ? v
        .map(f)
        .filter((x): x is T => x !== null)
        .slice(0, max)
    : [];
const pick = <T extends string>(v: unknown, set: Set<string>): T | null => (typeof v === 'string' && set.has(v) ? (v as T) : null);

function cleanAccount(input: unknown): CreditAccount | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as Record<string, unknown>;
  const creditor = str(a.creditor, 120);
  if (!creditor) return null;
  const last4Raw = typeof a.last4 === 'string' ? a.last4.replace(/\D/g, '') : null;
  const lc = (a.late_counts ?? {}) as Record<string, unknown>;
  return {
    creditor,
    last4: last4Raw && last4Raw.length >= 2 ? last4Raw.slice(-4) : null,
    type: pick(a.type, TYPES),
    kind: str(a.kind, 30),
    owner: pick(a.owner, OWNERS),
    status: pick(a.status, STATUSES),
    status_text: str(a.status_text, 160),
    opened: cleanDate(a.opened),
    closed: cleanDate(a.closed),
    last_reported: cleanDate(a.last_reported),
    limit: num(a.limit),
    high_balance: num(a.high_balance),
    balance: num(a.balance),
    monthly_payment: num(a.monthly_payment),
    past_due: num(a.past_due),
    terms: str(a.terms, 40),
    late_counts: { '30': int(lc['30']), '60': int(lc['60']), '90': int(lc['90']), '120': int(lc['120']) },
    late_months: arr(a.late_months, 120, (x) => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const month = cleanDate(o.month)?.slice(0, 7) ?? null;
      const days = int(o.days);
      return month && days ? { month, days } : null;
    }),
    history_from: cleanDate(a.history_from)?.slice(0, 7) ?? null,
    remarks: arr(a.remarks, 10, (x) => str(x, 160)),
  };
}

/** Validate + normalize one report. Returns an error string or the report.
 * Unknown fields are dropped, so nothing outside this shape is stored. */
export function cleanReport(input: unknown): CreditReport | string {
  if (!input || typeof input !== 'object') return 'not an object';
  if (SSN_RE.test(JSON.stringify(input))) return 'looks like it contains a Social Security number — remove it';
  const r = input as Record<string, unknown>;
  const bureau = pick<Bureau>(r.bureau, BUREAUS as Set<string>);
  if (!bureau) return 'bureau must be equifax, experian, transunion or other';
  const pulled = cleanDate(r.pulled_on);
  if (!pulled || pulled.length !== 10) return 'pulled_on must be YYYY-MM-DD';
  const id = `${pulled}-${bureau}`;
  const personal = (r.personal ?? {}) as Record<string, unknown>;
  const summary = (r.summary ?? {}) as Record<string, unknown>;
  const SUMMARY_KEYS = ['open_accounts', 'closed_accounts', 'total_accounts', 'total_balance', 'revolving_balance', 'revolving_limit', 'delinquent_accounts', 'derogatory', 'hard_inquiries'];
  const fileId = typeof r.file_id === 'string' && /^[\w-]{10,80}$/.test(r.file_id) ? r.file_id : null;
  return {
    id,
    bureau,
    source: str(r.source, 80),
    pulled_on: pulled,
    file_name: str(r.file_name, 120),
    file_id: fileId,
    unreadable: !!r.unreadable,
    partial: !!r.partial,
    scores: arr(r.scores, 10, (x) => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const value = num(o.value);
      if (value === null || value < 250 || value > 999) return null;
      return { value, model: str(o.model, 60), bureau: pick<Bureau>(o.bureau, BUREAUS as Set<string>), range: str(o.range, 20) };
    }),
    summary: Object.fromEntries(SUMMARY_KEYS.map((k) => [k, num(summary[k])])),
    personal: {
      names: arr(personal.names, 20, (x) => str(x, 80)),
      addresses: arr(personal.addresses, 40, (x) => {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const address = str(o.address, 160);
        return address ? { address, reported: cleanDate(o.reported), current: !!o.current } : null;
      }),
      employers: arr(personal.employers, 30, (x) => {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const name = str(o.name, 100);
        return name ? { name, reported: cleanDate(o.reported) } : null;
      }),
    },
    accounts: arr(r.accounts, 200, cleanAccount),
    inquiries: arr(r.inquiries, 200, (x) => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const name = str(o.name, 100);
      return name ? { name, date: cleanDate(o.date), type: o.type === 'soft' ? 'soft' : 'hard' } : null;
    }),
    negatives: arr(r.negatives, 50, (x) => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const kind = str(o.kind, 40);
      return kind ? { kind, creditor: str(o.creditor, 100), date: cleanDate(o.date), amount: num(o.amount), status: str(o.status, 60), removal_date: cleanDate(o.removal_date) } : null;
    }),
    notes: str(r.notes, 1000),
  };
}
