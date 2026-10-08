import type { Env } from '../types';
import { templateById } from './templates';

/** "Accounts Need Attention" (Mike, 2026-10-08): the subset of open
 * statement flags that cost money or need action — counted on the Finance
 * sidebar badge (hidden at 0) and listed in the strip at the top of
 * Finance. Everything else (math checks, unreadable old files, rate/APR
 * changes, utilization…) stays on the account's own dashboard only.
 * Classified by the flag's dedupe-key prefix so every template — current
 * and future — is covered by one list. */
const ATTENTION = new Set([
  'past_due', // past-due / carried balance on a bill or card
  'carried', // card balance not paid in full
  'interest', // card interest charged
  'fee', // any fee on the latest statement
  'od', // overdraft protection transfer
  'od_returned', // returned overdraft items
  'return', // returned ACH item
  'missing_after', // the next statement is late
  'missing', // 529 quarterly statement missing
  'gap', // a month missing from Drive (recent only — see below)
  'aip_missed', // 529 automatic contribution missed (recent only)
  'high_bill', // bill higher than normal (anomalies.ts)
  'dup_charge', // possible duplicate card charge (anomalies.ts)
  'price_up', // subscription price went up (anomalies.ts)
  'payer', // auto-pay with no payment method / payer card inactive or removed
]);
/** Gaps and missed contributions only matter if recent; old history stays on the dashboard. */
const RECENT_ONLY = new Set(['gap', 'aip_missed']);
const RECENT_MONTHS = 13;

export function isAttentionKey(key: string, today: string): boolean {
  const prefix = key.split(':')[0];
  if (!ATTENTION.has(prefix)) return false;
  if (prefix === 'payer' && key === 'payer:mode') return false; // "switch it to Auto-Pay" — housekeeping
  if (RECENT_ONLY.has(prefix)) {
    const ym = key.slice(prefix.length + 1, prefix.length + 8);
    if (!/^\d{4}-\d{2}$/.test(ym)) return true;
    const months = (Number(today.slice(0, 4)) - Number(ym.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(ym.slice(5, 7));
    return months <= RECENT_MONTHS;
  }
  return true;
}

export interface AttentionItem {
  id: string;
  folderId: string;
  account: string;
  owner: string;
  severity: string;
  message: string;
  createdAt: string;
}

export async function listAttention(env: Env, today: string): Promise<AttentionItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT fl.id, fl.dedupe_key, fl.severity, fl.message, fl.created_at, f.id AS folder_id, f.template_id, f.folder_name, f.owner
       FROM statement_flags fl
       JOIN statement_folders f ON f.id = fl.folder_row_id
      WHERE f.status = 'live' AND fl.resolved_at IS NULL AND fl.dismissed_at IS NULL
      ORDER BY fl.created_at DESC`
  ).all<{ id: string; dedupe_key: string; severity: string; message: string; created_at: string; folder_id: string; template_id: string | null; folder_name: string; owner: string }>();
  return (results ?? [])
    .filter((r) => isAttentionKey(r.dedupe_key, today))
    .map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      account: templateById(r.template_id)?.account.nickname ?? r.folder_name,
      owner: r.owner,
      severity: r.severity,
      message: r.message,
      createdAt: r.created_at,
    }));
}
