/** One filed tax year as stored in tax_returns.data_json. Whole dollars;
 * null = the line doesn't exist on that return or wasn't readable. Shape
 * matches the one-time extraction from Mike's Drive PDFs (2026-10-12). */
export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh';

export interface TaxFederal {
  wages: number | null;
  taxable_interest: number | null;
  tax_exempt_interest: number | null;
  ordinary_dividends: number | null;
  qualified_dividends: number | null;
  ira_taxable: number | null;
  pensions_taxable: number | null;
  social_security_taxable: number | null;
  capital_gain: number | null;
  business_income: number | null;
  unemployment: number | null;
  other_income: number | null;
  total_income: number | null;
  adjustments: number | null;
  agi: number | null;
  deduction_type: 'standard' | 'itemized' | null;
  deduction: number | null;
  exemptions: number | null;
  qbi_deduction: number | null;
  taxable_income: number | null;
  tax: number | null;
  amt: number | null;
  nonrefundable_credits: number | null;
  credit_detail: string | null;
  other_taxes: number | null;
  other_taxes_detail: string | null;
  total_tax: number | null;
  withholding: number | null;
  estimated_payments: number | null;
  refundable_credits: number | null;
  total_payments: number | null;
  refund: number | null;
  amount_owed: number | null;
  penalty: number | null;
  applied_to_next_year: number | null;
}

export interface TaxItemized {
  medical: number | null;
  salt_paid: number | null;
  salt_deducted: number | null;
  real_estate_tax: number | null;
  mortgage_interest: number | null;
  charity: number | null;
  other: number | null;
  total: number | null;
}

export interface TaxState {
  federal_agi?: number | null;
  ny_agi?: number | null;
  ct_agi?: number | null;
  ct_source_income?: number | null;
  filer?: string | null;
  deduction_type?: string | null;
  deduction?: number | null;
  dependent_exemptions?: number | null;
  taxable_income?: number | null;
  tax: number | null;
  credits: number | null;
  total_tax: number | null;
  withholding: number | null;
  estimated_payments?: number | null;
  refund: number | null;
  amount_owed: number | null;
  notes?: string | null;
}

export interface TaxPerson {
  who: string;
  employer: string;
  wages: number;
}

export interface TaxSourceFile {
  id: string;
  title: string;
  what: string;
}

export interface TaxReturn {
  year: number;
  filing_status: FilingStatus;
  prepared_by: string | null;
  amended: boolean;
  source_files: TaxSourceFile[];
  people: TaxPerson[];
  federal: TaxFederal;
  itemized: TaxItemized | null;
  ny: TaxState | null;
  ct: TaxState | null;
  dependents: number | null;
  checks: Record<string, string>;
  doubts: string[];
  notes: string[];
}
