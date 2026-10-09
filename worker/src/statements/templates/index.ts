import type { ParsedStatement } from '../common';
import { parseNy529 } from './ny529';
import { parseAdt } from './adt';
import { parseAlly } from './ally';
import { parseAmazon } from './amazon';
import { parseAmexBank } from './amexBank';
import { parseAmexCard } from './amexCard';

/** Per-folder templates (one per Drive folder, all on the shared base
 * engine). Build order per progress.md: 529 is live; ADT, Ally Bank, Amazon Prime Visa,
 * American Express Bank and the Amex Blue Cash Everyday card built; the rest are added one folder at a time. */
export interface StatementTemplate {
  id: string;
  name: string;
  /** Drive folder names this template is built for (case-insensitive). */
  folderNames: string[];
  account: {
    nickname: string; // Vault note title / Finance label
    institution: string;
    type: string;
    owner: 'household' | 'chase';
    cadence: 'monthly' | 'quarterly';
    /** 'balance' accounts count toward Finance totals; 'bill' accounts
     * (utilities, services) show their latest bill instead; 'card' accounts
     * (credit cards) show the statement balance owed — a liability, kept
     * out of the Household total and summed as "Card Balances". */
    kind: 'balance' | 'bill' | 'card';
    site?: string;
    phone?: string;
    /** Cards: the network / tier for the Card Type Quick Fact when the
     * Wallet card doesn't say ('Visa Signature'). */
    network?: string;
  };
  parse(text: string): ParsedStatement;
  /** Files in the folder that aren't statements (e.g. a contract) are
   * recorded as Skipped instead of being read and flagged. */
  isStatementFile?(fileName: string): boolean;
}

export const TEMPLATES: StatementTemplate[] = [
  {
    id: 'ny529',
    name: 'NY 529 Direct Plan (Quarterly)',
    folderNames: ['529'],
    account: {
      nickname: 'NY 529 · Chase',
      institution: 'NY 529 Direct Plan',
      type: 'Individual 529',
      owner: 'chase',
      cadence: 'quarterly',
      kind: 'balance',
      site: 'https://www.nysaves.org',
      phone: '1-877-697-2837',
    },
    parse: parseNy529,
  },
  {
    id: 'adt',
    name: 'ADT Home Security (Monthly Bill)',
    folderNames: ['ADT'],
    account: {
      nickname: 'ADT Home Security',
      institution: 'ADT',
      type: 'Home Security Monitoring',
      owner: 'household',
      cadence: 'monthly',
      kind: 'bill',
      site: 'https://www.myadt.com',
      phone: '1-800-238-2727',
    },
    parse: parseAdt,
    isStatementFile: (name) => /statement/i.test(name),
  },
  {
    id: 'ally',
    name: 'Ally Bank Checking & Savings (Monthly)',
    folderNames: ['Ally Bank', 'Ally'],
    account: {
      nickname: 'Ally Bank',
      institution: 'Ally Bank',
      type: 'Checking & Savings',
      owner: 'household',
      cadence: 'monthly',
      kind: 'balance',
      site: 'https://www.ally.com',
      phone: '1-877-247-2559',
    },
    parse: parseAlly,
    isStatementFile: (name) => /statement/i.test(name),
  },
  {
    id: 'amazon',
    name: 'Amazon Prime Visa (Monthly Credit Card)',
    folderNames: ['Amazon Prime Credit Card', 'Amazon Prime Visa'],
    account: {
      nickname: 'Amazon Prime Visa',
      institution: 'Chase',
      type: 'Rewards Credit Card',
      owner: 'household',
      cadence: 'monthly',
      kind: 'card',
      network: 'Visa Signature',
      site: 'https://www.chase.com/amazon',
      phone: '1-888-247-4080',
    },
    parse: parseAmazon,
    // Monthly statements are "Amazon - YYYY.MM.DD.pdf"; the year-end
    // "Annual Summary" PDFs ("Amazon - 2015.pdf") are skipped.
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name),
  },
  {
    id: 'amexBank',
    name: 'American Express High Yield Savings (Monthly)',
    folderNames: ['American Express Bank', 'Amex Bank', 'American Express Savings'],
    account: {
      nickname: 'American Express Savings',
      institution: 'American Express National Bank',
      type: 'High Yield Savings',
      owner: 'household',
      cadence: 'monthly',
      kind: 'balance',
      site: 'https://personalsavings.americanexpress.com',
      phone: '1-800-446-6307',
    },
    parse: parseAmexBank,
    // Monthly statements are "AMEX FSB - YYYY.MM.DD.pdf"; a 1099 or other
    // document dropped in the folder is skipped (and a 1099 feeds Tax Packet).
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name) && !/1099/.test(name),
  },
  {
    id: 'amexCard',
    name: 'American Express Blue Cash Everyday (Monthly Credit Card)',
    folderNames: ['American Express Credit Card', 'Amex Credit Card', 'American Express Card'],
    account: {
      nickname: 'Amex Blue Cash Everyday',
      institution: 'American Express',
      type: 'Cash Back Credit Card',
      owner: 'household',
      cadence: 'monthly',
      kind: 'card',
      network: 'American Express',
      site: 'https://www.americanexpress.com',
      phone: '1-888-258-3741',
    },
    parse: parseAmexCard,
    // Monthly statements are "AMEX CC - YYYY.MM.pdf"; the year-end
    // summaries ("AMEX CC - 2024.pdf") are skipped. Notice letters saved
    // under a monthly name are recognized by the parser (NotAStatement).
    isStatementFile: (name) => /\d{4}\.\d{2}/.test(name),
  },
];

/** Folders that are never statements (Mike's tickler folder etc.). */
export const DEFAULT_IGNORED_FOLDERS = ['!nbox'];

export const templateById = (id: string | null | undefined) => TEMPLATES.find((t) => t.id === id) ?? null;
export const templateForFolder = (name: string) => TEMPLATES.find((t) => t.folderNames.some((n) => n.toLowerCase() === name.trim().toLowerCase())) ?? null;
