import type { ParsedStatement } from '../common';
import { parseNy529 } from './ny529';

/** Per-folder templates (one per Drive folder, all on the shared base
 * engine). Build order per progress.md: 529 is live; American Express Bank
 * and the rest are added one folder at a time. */
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
    site?: string;
    phone?: string;
  };
  parse(text: string): ParsedStatement;
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
      site: 'https://www.nysaves.org',
      phone: '1-877-697-2837',
    },
    parse: parseNy529,
  },
];

/** Folders that are never statements (Mike's tickler folder etc.). */
export const DEFAULT_IGNORED_FOLDERS = ['!nbox'];

export const templateById = (id: string | null | undefined) => TEMPLATES.find((t) => t.id === id) ?? null;
export const templateForFolder = (name: string) => TEMPLATES.find((t) => t.folderNames.some((n) => n.toLowerCase() === name.trim().toLowerCase())) ?? null;
