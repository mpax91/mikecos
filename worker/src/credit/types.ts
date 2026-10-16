/** Finance → Credit Reports (migration 0136). One row per bureau report Mike
 * pulled (AnnualCreditReport.com every Feb 22 since 2012, plus a few older
 * one-offs). The archive was read once from the PDFs in the Drive "Credit
 * Reports" folder and imported; everything on the page is derived on read
 * (summary.ts). NO Social Security numbers, birth dates or full account
 * numbers are ever stored — account numbers keep the last 4 digits at most. */

export type Bureau = 'equifax' | 'experian' | 'transunion' | 'other';

export interface CreditScore {
  value: number;
  model: string | null;
  bureau: Bureau | null;
  range: string | null;
}

export interface CreditAccount {
  creditor: string;
  last4: string | null;
  type: 'revolving' | 'installment' | 'mortgage' | 'open' | 'other' | null;
  kind: string | null; // credit_card | charge_card | auto | student | mortgage | heloc | personal | retail | utility | collection | other
  owner: 'individual' | 'joint' | 'authorized_user' | null;
  status: 'open' | 'closed' | 'paid' | 'transferred' | 'charged_off' | 'collection' | 'other' | null;
  status_text: string | null;
  opened: string | null; // YYYY-MM-DD | YYYY-MM
  closed: string | null;
  last_reported: string | null;
  limit: number | null;
  high_balance: number | null;
  balance: number | null;
  monthly_payment: number | null;
  past_due: number | null;
  terms: string | null;
  late_counts: { '30': number; '60': number; '90': number; '120': number };
  late_months: { month: string; days: number }[];
  history_from: string | null;
  remarks: string[];
}

export interface CreditInquiry {
  name: string;
  date: string | null;
  type: 'hard' | 'soft';
}

export interface CreditNegative {
  kind: string;
  creditor: string | null;
  date: string | null;
  amount: number | null;
  status: string | null;
  removal_date: string | null;
}

export interface CreditReport {
  id: string; // YYYY-MM-DD-bureau
  bureau: Bureau;
  source: string | null;
  pulled_on: string; // YYYY-MM-DD
  file_name: string | null;
  file_id: string | null;
  unreadable: boolean;
  /** Only part of the PDF could be read (e.g. a 249-page TransUnion file) — not used for "missing from this bureau" checks. */
  partial: boolean;
  scores: CreditScore[];
  summary: Record<string, number | null>;
  personal: {
    names: string[];
    addresses: { address: string; reported: string | null; current: boolean }[];
    employers: { name: string; reported: string | null }[];
  };
  accounts: CreditAccount[];
  inquiries: CreditInquiry[];
  negatives: CreditNegative[];
  notes: string | null;
}
