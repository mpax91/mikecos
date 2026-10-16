import type { CreditBureau } from '../api/types';

export const BUREAU_LABEL: Record<CreditBureau, string> = { equifax: 'Equifax', experian: 'Experian', transunion: 'TransUnion', other: 'Other' };
export const BUREAU_SHORT: Record<CreditBureau, string> = { equifax: 'EQ', experian: 'EX', transunion: 'TU', other: '3B' };
export const REAL_BUREAUS: CreditBureau[] = ['equifax', 'experian', 'transunion'];

export const KIND_LABEL: Record<string, string> = {
  credit_card: 'Credit Card',
  charge_card: 'Charge Card',
  retail: 'Store Card',
  auto: 'Auto',
  student: 'Student Loan',
  mortgage: 'Mortgage',
  heloc: 'Home Equity',
  personal: 'Personal Loan',
  utility: 'Utility',
  collection: 'Collection',
  other: 'Other',
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Kind → timeline color group (validated pair from FinanceLineChart + muted greys). */
export function kindGroup(k: string): 'card' | 'loan' | 'home' | 'other' {
  if (k === 'credit_card' || k === 'charge_card' || k === 'retail') return 'card';
  if (k === 'mortgage' || k === 'heloc') return 'home';
  if (k === 'auto' || k === 'student' || k === 'personal') return 'loan';
  return 'other';
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
export function compactMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `$${Math.round(n / 1000)}K`;
  if (a >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
/** "2014-01-02" / "2014-01" → "Jan 2014". */
export function monthYear(d: string | null | undefined): string {
  if (!d) return '—';
  const iso = d.length === 7 ? `${d}-15` : d.slice(0, 10);
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function fullDate(d: string | null | undefined): string {
  if (!d) return '—';
  if (d.length === 7) return monthYear(d);
  return new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
export const statusLabel = (s: string) => (s === 'gone' ? 'Off Reports' : s === 'charged_off' ? 'Charged Off' : s.charAt(0).toUpperCase() + s.slice(1));
export const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;
