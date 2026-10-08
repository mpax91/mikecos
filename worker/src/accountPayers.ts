import type { Env } from './types';
import { detectFactValue, reindexEntry } from './vault';

/** Account payers + the auto-updating payment Quick Facts (Mike,
 * 2026-10-07). See migrations/0092_account_payers.sql.
 *
 * Each account (a Vault entry) can carry up to six managed Quick Facts,
 * written only where they apply:
 *   Due Date · Auto-Pay · Paid With · Latest Bill ·
 *   Average Bill (12 Mo) · Average Bill (All-Time)
 * They are ordinary vault_facts rows with managed_key 'pay:*' — so they
 * show up in Vault search and Vault Rollups like any other fact — and are
 * tagged "Auto-Updates" in the UI. Mike's edits win: editing one turns it
 * into his own fact, deleting one keeps it deleted (vault_fact_releases).
 *
 * Bill numbers come from the account's Statements folder: each template's
 * derive stores a BillingFacts snapshot in statement_folders.meta_json
 * (`billing`) and calls syncPaymentFacts. The payer comes from
 * account_payers (set in Wallet or on the Vault entry). */

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export interface BillingFacts {
  latestAmount: number | null; // latest bill / statement balance
  latestDate: string | null; // YYYY-MM-DD of that bill
  dueDate: string | null; // YYYY-MM-DD printed on the latest bill
  autopay: boolean | null; // what the latest bill says (null = it doesn't say)
  avg12: { amount: number; bills: number } | null;
  avgAll: { amount: number; bills: number } | null;
}

export interface PayerRow {
  id: string;
  entry_id: string;
  mode: 'autopay' | 'on_file';
  payment_card_id: string | null;
  payer_text: string | null;
  due_day: number | null;
  created_at: string;
  updated_at: string;
}

export const PAY_KEYS = ['pay:due', 'pay:autopay', 'pay:paid_with', 'pay:latest', 'pay:avg12', 'pay:avg_all'] as const;
export const PAY_LABELS: Record<(typeof PAY_KEYS)[number], string> = {
  'pay:due': 'Due Date',
  'pay:autopay': 'Auto-Pay',
  'pay:paid_with': 'Paid With',
  'pay:latest': 'Latest Bill',
  'pay:avg12': 'Average Bill (12 Mo)',
  'pay:avg_all': 'Average Bill (All-Time)',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
export const fmtMoney = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtMdy = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
};
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** Builds the billing snapshot from a template's bills (oldest first).
 * Averages use what each bill charged (`amount`), not carried balances. */
export function billingFromBills(
  bills: { date: string; amount: number; totalDue: number; dueDate: string | null; autopay: boolean | null }[]
): BillingFacts | null {
  if (!bills.length) return null;
  const latest = bills[bills.length - 1];
  const avg = (rows: typeof bills) => (rows.length ? { amount: round2(rows.reduce((s, b) => s + b.amount, 0) / rows.length), bills: rows.length } : null);
  // Last 12 months = bills dated within a year of the latest bill.
  const cutoff = new Date(`${latest.date}T12:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const cut = cutoff.toISOString().slice(0, 10);
  return {
    latestAmount: round2(latest.totalDue),
    latestDate: latest.date,
    dueDate: latest.dueDate,
    autopay: latest.autopay,
    avg12: avg(bills.filter((b) => b.date > cut)),
    avgAll: avg(bills),
  };
}

export async function loadPayer(env: Env, entryId: string): Promise<PayerRow | null> {
  return env.DB.prepare('SELECT * FROM account_payers WHERE entry_id = ?').bind(entryId).first<PayerRow>();
}

/** "Sapphire ••4417", or the free-text payer. */
export async function payerLabel(env: Env, payer: PayerRow | null): Promise<string | null> {
  if (!payer) return null;
  if (payer.payment_card_id) {
    const card = await env.DB.prepare('SELECT nickname, last4 FROM payment_cards WHERE id = ?').bind(payer.payment_card_id).first<{ nickname: string; last4: string | null }>();
    if (card) return `${card.nickname}${card.last4 ? ` ••${card.last4}` : ''}`;
  }
  return payer.payer_text?.trim() || null;
}

/** The statement folder (if any) behind a Vault entry, with its billing snapshot. */
async function folderBilling(env: Env, entryId: string): Promise<{ folderId: string; billing: BillingFacts | null } | null> {
  const row = await env.DB.prepare(`SELECT id, meta_json FROM statement_folders WHERE vault_entry_id = ? AND status = 'live' LIMIT 1`)
    .bind(entryId)
    .first<{ id: string; meta_json: string | null }>();
  if (!row) return null;
  let billing: BillingFacts | null = null;
  try {
    billing = row.meta_json ? (JSON.parse(row.meta_json).billing ?? null) : null;
  } catch {
    billing = null;
  }
  return { folderId: row.id, billing };
}

/** Writes the payment Quick Facts for one account. `billing` is passed by
 * a template's derive; otherwise it is read from the folder's snapshot. */
export async function syncPaymentFacts(env: Env, entryId: string, billing?: BillingFacts | null): Promise<void> {
  const entry = await env.DB.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'vault_entry'`).bind(entryId).first();
  if (!entry) return;
  if (billing === undefined) billing = (await folderBilling(env, entryId))?.billing ?? null;
  const payer = await loadPayer(env, entryId);
  const paidWith = await payerLabel(env, payer);

  // Statement wins on Auto-Pay when it says; otherwise the payer setting.
  const autopay = billing?.autopay ?? (payer ? payer.mode === 'autopay' : null);
  const due = billing?.dueDate ? fmtMdy(billing.dueDate) : payer?.due_day ? `${ordinal(payer.due_day)} of Each Month` : null;

  const want: Record<string, string | null> = {
    'pay:due': due,
    'pay:autopay': autopay === null ? null : autopay ? 'Yes' : 'No',
    'pay:paid_with': paidWith,
    'pay:latest': billing?.latestAmount != null ? fmtMoney(billing.latestAmount) : null,
    'pay:avg12': billing?.avg12 ? fmtMoney(billing.avg12.amount) : null,
    'pay:avg_all': billing?.avgAll ? fmtMoney(billing.avgAll.amount) : null,
  };

  const [{ results: existing }, { results: released }, maxPos] = await Promise.all([
    env.DB.prepare(`SELECT id, managed_key, label, value FROM vault_facts WHERE entry_id = ? AND managed_key LIKE 'pay:%'`)
      .bind(entryId)
      .all<{ id: string; managed_key: string; label: string; value: string | null }>(),
    env.DB.prepare(`SELECT managed_key FROM vault_fact_releases WHERE entry_id = ?`).bind(entryId).all<{ managed_key: string }>(),
    env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM vault_facts WHERE entry_id = ?').bind(entryId).first<{ m: number }>(),
  ]);
  const byKey = new Map((existing ?? []).map((r) => [r.managed_key, r]));
  const releasedKeys = new Set((released ?? []).map((r) => r.managed_key));
  let pos = (maxPos?.m ?? -1) + 1;
  const stmts: D1PreparedStatement[] = [];
  for (const key of PAY_KEYS) {
    const value = want[key];
    const cur = byKey.get(key);
    const label = PAY_LABELS[key];
    if (releasedKeys.has(key)) continue;
    if (!value) {
      if (cur) stmts.push(env.DB.prepare('DELETE FROM vault_facts WHERE id = ?').bind(cur.id));
      continue;
    }
    const det = detectFactValue(value);
    if (!cur) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO vault_facts (id, entry_id, label, value, position, created_at, value_type, value_norm, managed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(uid(), entryId, label, value, pos++, now(), det.type, det.norm, key)
      );
    } else if (cur.value !== value || cur.label !== label) {
      stmts.push(env.DB.prepare('UPDATE vault_facts SET label = ?, value = ?, value_type = ?, value_norm = ? WHERE id = ?').bind(label, value, det.type, det.norm, cur.id));
    }
  }
  if (stmts.length) {
    await env.DB.batch(stmts);
    await reindexEntry({ env }, entryId);
  }
}

/** Re-syncs every account a card pays (after the card's nickname/last 4 change). */
export async function syncAccountsForCard(env: Env, cardId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT entry_id FROM account_payers WHERE payment_card_id = ?').bind(cardId).all<{ entry_id: string }>();
  for (const r of results ?? []) await syncPaymentFacts(env, r.entry_id);
}

/** A card is being deleted from Wallet: keep its accounts' "Paid With" as
 * text (so nothing silently loses its payer) and flag them via the text. */
export async function detachCard(env: Env, cardId: string): Promise<void> {
  const card = await env.DB.prepare('SELECT nickname, last4 FROM payment_cards WHERE id = ?').bind(cardId).first<{ nickname: string; last4: string | null }>();
  const text = card ? `${card.nickname}${card.last4 ? ` ••${card.last4}` : ''} (Removed From Wallet)` : 'Removed From Wallet';
  const { results } = await env.DB.prepare('SELECT entry_id FROM account_payers WHERE payment_card_id = ?').bind(cardId).all<{ entry_id: string }>();
  await env.DB.prepare('UPDATE account_payers SET payment_card_id = NULL, payer_text = ?, updated_at = ? WHERE payment_card_id = ?').bind(text, now(), cardId).run();
  for (const r of results ?? []) await syncPaymentFacts(env, r.entry_id);
}

/** Flags for a Statements folder about its payer, merged into the
 * template's own flag list before syncFlags. */
export async function payerFlags(
  env: Env,
  entryId: string,
  accountName: string,
  billing: BillingFacts | null
): Promise<{ key: string; severity: 'warn' | 'info'; message: string }[]> {
  const payer = await loadPayer(env, entryId);
  const label = await payerLabel(env, payer);
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  if (!billing || billing.autopay === null) {
    // The statement doesn't say either way — nothing to compare.
  } else if (billing.autopay && !label) {
    flags.push({ key: 'payer:missing', severity: 'warn', message: `${accountName} is on automatic payment, but no card is set — pick it in Wallet (Pays For) or on the Vault entry (Paid With)` });
  } else if (billing.autopay && payer?.mode === 'on_file') {
    flags.push({ key: 'payer:mode', severity: 'info', message: `The latest ${accountName} bill shows automatic payment, but ${label} is marked On File — switch it to Auto-Pay` });
  } else if (!billing.autopay && payer?.mode === 'autopay') {
    flags.push({ key: 'payer:off', severity: 'warn', message: `The latest ${accountName} bill isn’t on automatic payment, but ${label} is set to Auto-Pay — check the account` });
  }
  if (payer?.payment_card_id) {
    const card = await env.DB.prepare('SELECT expiry_month, expiry_year, active FROM payment_cards WHERE id = ?')
      .bind(payer.payment_card_id)
      .first<{ expiry_month: number | null; expiry_year: number | null; active: number }>();
    if (card && !card.active) flags.push({ key: 'payer:inactive', severity: 'warn', message: `${accountName} is paid with ${label}, which is marked inactive in Wallet` });
  } else if (payer?.payer_text && /removed from wallet/i.test(payer.payer_text)) {
    flags.push({ key: 'payer:removed', severity: 'warn', message: `${accountName} was paid with ${payer.payer_text.replace(/\s*\(removed from wallet\)/i, '')}, which was deleted from Wallet — set the new card` });
  }
  return flags;
}

