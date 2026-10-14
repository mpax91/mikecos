import type { ParsedStatement } from '../common';
import { parseNy529 } from './ny529';
import { parseAdt } from './adt';
import { parseAlly } from './ally';
import { parseAmazon } from './amazon';
import { parseAmexBank } from './amexBank';
import { parseAmexCard } from './amexCard';
import { parseBofaCard } from './bofaCard';
import { parseTmobile } from './tmobile';
import { parsePaypal } from './paypal';
import { parseFios } from './fios';
import { parseUsaa } from './usaa';

/** Per-folder templates (one per Drive folder, all on the shared base
 * engine). Build order per progress.md: 529 is live; ADT, Ally Bank, Amazon Prime Visa, PayPal,
 * American Express Bank, the Amex Blue Cash Everyday card and the Bank of America
 * Customized Cash Rewards card, T-Mobile, Verizon Fios and USAA Checking built; the rest are added one folder at a time. */
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
     * out of the Household total and summed as "Card Balances"; 'app'
     * accounts (PayPal) are pass-through payment apps — their balance (usually
     * $0) counts toward the total, the dashboard is about activity. */
    kind: 'balance' | 'bill' | 'card' | 'app';
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
  {
    id: 'bofaCard',
    name: 'Bank of America Customized Cash Rewards (Monthly Credit Card)',
    folderNames: ['Bank of America Credit Card', 'BofA Credit Card', 'Bank of America Card'],
    account: {
      nickname: 'BofA Customized Cash Rewards',
      institution: 'Bank of America',
      type: 'Cash Back Credit Card',
      owner: 'household',
      cadence: 'monthly',
      kind: 'card',
      network: 'Visa Signature',
      site: 'https://www.bankofamerica.com',
      phone: '1-800-637-7455',
    },
    parse: parseBofaCard,
    // Monthly statements are "BOA CC - YYYY.MM.DD.pdf"; the year-end
    // summaries ("BOA CC - 2024.pdf") and the "BOA Cash Rewards Scorecard"
    // sheet are skipped.
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name),
  },
  {
    id: 'tmobile',
    name: 'T-Mobile Wireless (Monthly Bill)',
    folderNames: ['T-Mobile', 'TMobile', 'T Mobile'],
    account: {
      nickname: 'T-Mobile',
      institution: 'T-Mobile',
      type: 'Wireless Service',
      owner: 'household',
      cadence: 'monthly',
      kind: 'bill',
      site: 'https://www.t-mobile.com',
      phone: '1-800-937-8997',
    },
    parse: parseTmobile,
    // Monthly bills are "T-Mobile - YYYY.MM.DD.pdf".
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name),
  },
  {
    id: 'fios',
    name: 'Verizon Fios Home Internet (Monthly Bill)',
    folderNames: ['Verizon Fios', 'Fios', 'Verizon Fios Internet'],
    account: {
      nickname: 'Verizon Fios',
      institution: 'Verizon',
      type: 'Home Internet',
      owner: 'household',
      cadence: 'monthly',
      kind: 'bill',
      site: 'https://www.verizon.com/home/myverizon/',
      phone: '1-800-837-4966',
    },
    parse: parseFios,
    // Monthly bills are "Verizon Fios - YYYY.MM.DD.pdf".
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name),
  },
  {
    id: 'usaa',
    name: 'USAA Classic Checking (Monthly)',
    folderNames: ['USAA Checking Account', 'USAA Checking', 'USAA'],
    account: {
      nickname: 'USAA Checking',
      institution: 'USAA Federal Savings Bank',
      type: 'Checking',
      owner: 'household',
      cadence: 'monthly',
      kind: 'balance',
      site: 'https://www.usaa.com',
      phone: '1-800-531-8722',
    },
    parse: parseUsaa,
    // Monthly statements are "USAA FSB - YYYY.MM.DD.pdf"; a 1099 or other
    // document dropped in the folder is skipped.
    isStatementFile: (name) => /\d{4}\.\d{2}\.\d{2}/.test(name) && !/1099/.test(name),
  },
  {
    id: 'paypal',
    name: 'PayPal (Monthly)',
    folderNames: ['PayPal', 'Paypal'],
    account: {
      nickname: 'PayPal',
      institution: 'PayPal',
      type: 'Payment App',
      owner: 'household',
      cadence: 'monthly',
      kind: 'app',
      site: 'https://www.paypal.com',
      phone: '1-888-221-1161',
    },
    parse: parsePaypal,
    // Monthly statements are "PayPal - YYYY.MM.pdf".
    isStatementFile: (name) => /\d{4}\.\d{2}/.test(name),
  },
];

/** Folders that are never statements (Mike's tickler folder etc.). */
// 'Bedford Bee' holds Substack/Stripe CSV exports read by the Bee dashboard (worker/src/bee/).
export const DEFAULT_IGNORED_FOLDERS = ['!nbox', 'Bedford Bee', 'Home Maintenance'];

export const templateById = (id: string | null | undefined) => TEMPLATES.find((t) => t.id === id) ?? null;
export const templateForFolder = (name: string) => TEMPLATES.find((t) => t.folderNames.some((n) => n.toLowerCase() === name.trim().toLowerCase())) ?? null;
