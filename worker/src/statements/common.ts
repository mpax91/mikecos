/** Shared base-engine helpers for statement templates — money/date parsing
 * and the normalized shapes every template returns. No AI anywhere: each
 * template is plain regexes over pdf.js text, checked by arithmetic. */

export interface StatementCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  description: string;
  kind:
    | 'aip'
    | 'contribution'
    | 'withdrawal'
    | 'payment'
    | 'adjustment'
    | 'deposit'
    | 'interest'
    | 'transfer_in'
    | 'transfer_out'
    | 'fee'
    // credit cards (Amazon Prime Visa)
    | 'purchase'
    | 'refund'
    | 'reward'
    | 'cash_advance'
    | 'other';
  amount: number;
  units: number | null;
  unitPrice: number | null;
  /** Multi-account statements (Ally): the account's last 4 digits. */
  account?: string | null;
}

export interface ParsedStatement {
  periodStart: string;
  periodEnd: string;
  values: Record<string, unknown>;
  transactions: ParsedTransaction[];
  checks: StatementCheck[];
}

export class UnreadableStatement extends Error {}

/** "$1,234.56", "-$7.06", "($7.06)", "1,234.56" → number. */
export function money(raw: string): number {
  const s = raw.trim();
  const neg = /^-|^\(.*\)$|-\$/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || s.replace(/[^0-9]/g, '') === '') throw new UnreadableStatement(`Not a money amount: "${raw}"`);
  return neg ? -n : n;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const cents = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.005;

/** "6/30/2026" or "06/30/2026" → "2026-06-30". */
export function mdy(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function fmtMoney(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${s}`;
}

/** "2026-06-30" → "6/30/2026" (the shape Vault auto-detects as a date). */
export function fmtMdy(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

/** Finds the single required `label <value>` line and returns the value. */
export function field(text: string, label: RegExp): string {
  const m = text.match(label);
  if (!m) throw new UnreadableStatement(`Missing field ${label}`);
  return m[1].trim();
}

export function check(name: string, ok: boolean, detail: string): StatementCheck {
  return { name, ok, detail };
}
