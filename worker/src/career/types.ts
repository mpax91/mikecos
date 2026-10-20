/** Finance → Career (Mike, 2026-10-20; migration 0141). A career earnings
 * tracker built from the paystubs and equity documents in one Drive folder
 * per employer. Money in dollars (2 decimals); null = not printed / not
 * readable. The repo is PUBLIC — no pay data, employer names or file ids
 * ever live in code, migrations or fixtures; SSNs and account numbers are
 * never stored (cleanStub / cleanEvent reject them). */

export type PayKind = 'regular' | 'bonus' | 'stipend' | 'severance' | 'equity' | 'other';
export const PAY_KINDS: PayKind[] = ['regular', 'bonus', 'stipend', 'severance', 'equity', 'other'];

/** What an earnings line is. Base pay is salary/hourly/pto/holiday/retro. */
export type EarningKind =
  | 'salary'
  | 'hourly'
  | 'overtime'
  | 'pto'
  | 'holiday'
  | 'retro'
  | 'bonus'
  | 'commission'
  | 'stipend'
  | 'severance'
  | 'reimbursement'
  | 'imputed'
  | 'equity'
  | 'other';
export const EARNING_KINDS: EarningKind[] = ['salary', 'hourly', 'overtime', 'pto', 'holiday', 'retro', 'bonus', 'commission', 'stipend', 'severance', 'reimbursement', 'imputed', 'equity', 'other'];

export type TaxKind = 'federal' | 'social_security' | 'medicare' | 'state' | 'local' | 'sdi' | 'pfl' | 'other';
export const TAX_KINDS: TaxKind[] = ['federal', 'social_security', 'medicare', 'state', 'local', 'sdi', 'pfl', 'other'];

export type DeductionKind = '401k' | 'roth_401k' | 'medical' | 'dental' | 'vision' | 'fsa' | 'hsa' | 'commuter' | 'life' | 'disability' | 'espp' | 'other';
export const DEDUCTION_KINDS: DeductionKind[] = ['401k', 'roth_401k', 'medical', 'dental', 'vision', 'fsa', 'hsa', 'commuter', 'life', 'disability', 'espp', 'other'];

export interface PayLine<K extends string> {
  label: string;
  kind: K;
  current: number;
  ytd: number | null;
}
export interface EarningLine extends PayLine<EarningKind> {
  rate: number | null;
  hours: number | null;
}
export interface DeductionLine extends PayLine<DeductionKind> {
  pre_tax: boolean;
}

export interface Paystub {
  /** `<employer>:<pay date>:<kind>` (+ `:n` when one day holds several of a kind). */
  id: string;
  employer: string;
  pay_date: string;
  period_start: string | null;
  period_end: string | null;
  kind: PayKind;
  /** Payroll provider / layout that printed it (ADP, Gusto, Paychex…), free text. */
  provider: string | null;
  gross: number;
  net: number | null;
  taxes_total: number | null;
  pre_tax_total: number | null;
  post_tax_total: number | null;
  /** Pay rate as printed: per hour, per pay period, or a yearly salary. */
  rate: { amount: number; per: 'hour' | 'period' | 'year' } | null;
  hours: number | null;
  earnings: EarningLine[];
  taxes: PayLine<TaxKind>[];
  deductions: DeductionLine[];
  employer_contrib: PayLine<string>[];
  /** Year-to-date totals printed on the stub. */
  ytd: { gross: number | null; taxes: number | null; net: number | null } | null;
  file_id: string | null;
  file_name: string | null;
  /** Things that didn't add up or couldn't be read. */
  issues: string[];
}

export type CareerEventKind =
  /** Shares sold for cash (e.g. a SPAC merger cash-out, a tender offer). */
  | 'share_sale'
  /** Cash paid at an acquisition closing for shares/options. */
  | 'acquisition_payout'
  /** Later payment from an acquisition (escrow / holdback / earnout release). */
  | 'escrow_release'
  /** A post-closing report or statement — no cash moved. */
  | 'report'
  | 'option_grant'
  | 'option_exercise'
  | 'rsu_vest'
  | 'other';
export const EVENT_KINDS: CareerEventKind[] = ['share_sale', 'acquisition_payout', 'escrow_release', 'report', 'option_grant', 'option_exercise', 'rsu_vest', 'other'];

export interface CareerEvent {
  id: string;
  employer: string;
  date: string;
  kind: CareerEventKind;
  title: string;
  /** Cash before / after withholding or fees. */
  gross: number | null;
  net: number | null;
  shares: number | null;
  price: number | null;
  /** What remains held back (escrow balance etc.) as of this document. */
  remaining: number | null;
  /** Taxed through payroll (then it's also on a paystub — don't double count). */
  via_payroll: boolean;
  file_id: string | null;
  file_name: string | null;
  notes: string | null;
}

export interface CareerEmployer {
  id: string;
  name: string;
  aliases: string[];
  folder_names: string[];
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  notes: string | null;
  /** Salary facts from documents other than paystubs (offer / raise letters). */
  salaries: { date: string; annual: number; source: string }[];
}
