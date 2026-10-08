import type { BankAccountKind } from '../api/types';

export const BANK_KIND_LABEL: Record<BankAccountKind, string> = {
  checking: 'Checking',
  savings: 'Savings',
  money_market: 'Money Market',
  cd: 'CD',
  other: 'Other',
};
