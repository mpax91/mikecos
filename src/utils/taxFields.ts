import type { TaxFederal, TaxItemized, TaxStateReturn } from '../api/types';

/** Line labels for one tax year — shared by the year sheet and the editor.
 * Order follows the 1040 (income → deductions → tax → payments). */
export const FEDERAL_GROUPS: { title: string; fields: [keyof TaxFederal, string][] }[] = [
  {
    title: 'Income',
    fields: [
      ['wages', 'Wages (W-2)'],
      ['taxable_interest', 'Taxable Interest'],
      ['tax_exempt_interest', 'Tax-Exempt Interest'],
      ['ordinary_dividends', 'Ordinary Dividends'],
      ['qualified_dividends', 'Qualified Dividends'],
      ['capital_gain', 'Capital Gain or Loss'],
      ['business_income', 'Business Income (Sch C)'],
      ['ira_taxable', 'IRA Distributions (Taxable)'],
      ['pensions_taxable', 'Pensions (Taxable)'],
      ['social_security_taxable', 'Social Security (Taxable)'],
      ['unemployment', 'Unemployment'],
      ['other_income', 'Other Income'],
      ['total_income', 'Total Income'],
      ['adjustments', 'Adjustments'],
      ['agi', 'Adjusted Gross Income (AGI)'],
    ],
  },
  {
    title: 'Deductions',
    fields: [
      ['deduction', 'Deduction'],
      ['exemptions', 'Exemptions (Before 2018)'],
      ['qbi_deduction', 'QBI Deduction'],
      ['taxable_income', 'Taxable Income'],
    ],
  },
  {
    title: 'Tax',
    fields: [
      ['tax', 'Tax'],
      ['amt', 'Of Which AMT'],
      ['nonrefundable_credits', 'Credits'],
      ['other_taxes', 'Other Taxes'],
      ['total_tax', 'Total Tax'],
    ],
  },
  {
    title: 'Payments',
    fields: [
      ['withholding', 'Withholding'],
      ['estimated_payments', 'Estimated Payments'],
      ['refundable_credits', 'Refundable Credits'],
      ['total_payments', 'Total Payments'],
      ['refund', 'Refund'],
      ['amount_owed', 'Amount Owed'],
      ['penalty', 'Of Which Penalty'],
      ['applied_to_next_year', 'Applied to Next Year'],
    ],
  },
];

export const ITEMIZED_FIELDS: [keyof TaxItemized, string][] = [
  ['salt_paid', 'State & Local Taxes Paid'],
  ['salt_deducted', 'SALT Deducted (After Cap)'],
  ['real_estate_tax', 'Of Which Property Tax'],
  ['mortgage_interest', 'Mortgage Interest'],
  ['charity', 'Charity'],
  ['medical', 'Medical'],
  ['other', 'Other'],
  ['total', 'Total Itemized'],
];

export const STATE_FIELDS: [keyof TaxStateReturn, string][] = [
  ['taxable_income', 'Taxable Income'],
  ['deduction', 'Deduction'],
  ['tax', 'Tax'],
  ['credits', 'Credits'],
  ['total_tax', 'Total Tax'],
  ['withholding', 'Withholding'],
  ['estimated_payments', 'Estimated Payments'],
  ['refund', 'Refund'],
  ['amount_owed', 'Amount Owed'],
];

export const STATUS_LABEL: Record<string, string> = { single: 'Single', mfj: 'Married Filing Jointly', mfs: 'Married Filing Separately', hoh: 'Head of Household' };
export const STATUS_SHORT: Record<string, string> = { single: 'Single', mfj: 'Joint', mfs: 'Separate', hoh: 'Head of Household' };

export const money = (v: number | null | undefined, signed = false) =>
  v === null || v === undefined ? '—' : `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
export const compact = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}K` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}$${s}`;
};
export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
/** Federal result as words: "Refund $476" / "Owed $9,563". */
export const balanceText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 0 ? `Refund ${money(v)}` : `Owed ${money(-v)}`);
export const driveUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;
