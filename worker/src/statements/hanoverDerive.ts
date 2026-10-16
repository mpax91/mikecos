import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { templateById } from './templates';
import { LINE_LABEL, summarizeHanover } from './hanoverSummary';
import type { HanoverStmtRow, HanoverSummary } from './hanoverSummary';
import type { HanoverValues } from './templates/hanover';
import { billingFromBills, payerFlags } from '../accountPayers';
import type { BillingFacts } from '../accountPayers';

/** Hanover Insurance outputs: the Vault entry (adopts Mike's own "Hanover
 * Insurance" entry when one exists — his facts and notes stay his), an auto
 * note "Premiums & Payments", flags, the billing snapshot for Bills & Due
 * Dates (Auto-Pay withdrawals on the 15th) and the renewal reminder: a Today
 * task 30 days before the term ends. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
  /** One renewal task per term end — never recreated once Mike closes or deletes it. */
  renewalTask?: { termEnd: string; entityId: string } | null;
}

/** Days before the term ends that the "review the renewal" task lands on Today. */
export const RENEWAL_LEAD_DAYS = 30;
/** A line's new-term premium this much above where the last term ended → warn. */
export const RENEWAL_JUMP = 0.1;
export const RENEWAL_ACTION = 'insurance-renewal';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const usd0 = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export async function loadHanoverData(env: Env, folderId: string) {
  const [stmtRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: HanoverStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as HanoverValues,
    checks: JSON.parse(r.checks_json),
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, files };
}

/** Mike may already keep a hand-made "Hanover Insurance" Vault entry — use it
 * rather than making a second one. */
async function adoptEntry(env: Env, folder: FolderRow, title: string): Promise<string | null> {
  if (folder.vault_entry_id) return folder.vault_entry_id;
  const row = await env.DB.prepare(`SELECT id FROM entities WHERE type = 'vault_entry' AND lower(title) = lower(?) ORDER BY created_at ASC LIMIT 1`).bind(title).first<{ id: string }>();
  return row?.id ?? null;
}

export function renewalTaskTitle(s: HanoverSummary): string {
  return `Review Hanover Renewal (${s.policies.map((p) => p.label).join(', ')}) — Renews ${longDate(s.termEnd!)}`;
}

function renewalDescription(s: HanoverSummary): string {
  const parts = s.policies.map((p) => `${p.label} ${fmtMoney(p.premium)}`).join(' · ');
  return `Hanover renews ${longDate(s.termEnd!)}. This year: ${parts} = ${fmtMoney(s.annualPremium)}. Compare the renewal premiums when they arrive, and get quotes using the Quote Sheet in each Vault note.`;
}

/** The yearly renewal reminder: due RENEWAL_LEAD_DAYS before the term ends.
 * One task per term end. Mike closing or deleting it is final for that term;
 * new-term declarations landing in the folder check an open one off. */
export async function syncRenewalTask(env: Env, folderId: string, meta: FolderMeta, s: HanoverSummary, today: string): Promise<FolderMeta['renewalTask']> {
  const db = env.DB;
  const cur = meta.renewalTask ?? null;
  const ts = now();
  if (cur && s.termEnd && cur.termEnd < s.termEnd) {
    // The new term's declarations are in → the old reminder has done its job.
    const row = await db.prepare(`SELECT status, title FROM entities WHERE id = ?`).bind(cur.entityId).first<{ status: string; title: string }>();
    if (row?.status === 'open') {
      await db.batch([
        db.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, cur.entityId),
        db.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(uid(), cur.entityId, row.title, ts, today),
      ]);
    }
  }
  if (!s.termEnd || !s.policies.length) return cur;
  const due = addDays(s.termEnd, -RENEWAL_LEAD_DAYS);
  if (today < due || today > s.termEnd) return cur;
  if (cur && cur.termEnd === s.termEnd) {
    // Keep its title/description current while open; never recreate it.
    const row = await db.prepare(`SELECT status FROM entities WHERE id = ?`).bind(cur.entityId).first<{ status: string }>();
    if (row?.status === 'open') {
      const title = renewalTaskTitle(s);
      const content = JSON.stringify({ action: RENEWAL_ACTION, folderId, description: renewalDescription(s) });
      await db.prepare('UPDATE entities SET title = ?, content = ?, search_text = ?, updated_at = ? WHERE id = ? AND (title != ? OR content != ?)').bind(title, content, title, ts, cur.entityId, title, content).run();
    }
    return cur;
  }
  const id = uid();
  const title = renewalTaskTitle(s);
  const content = JSON.stringify({ action: RENEWAL_ACTION, folderId, description: renewalDescription(s) });
  const pos = await db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM entities WHERE parent_id IS NULL AND type = 'task'`).first<{ n: number }>();
  await db
    .prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text, realm)
       VALUES (?, 'task', ?, ?, NULL, 1, 'open', ?, ?, ?, ?, ?, ?, 'personal')`
    )
    .bind(id, title, content, pos?.n ?? 0, due, ts, ts, ts, title)
    .run();
  return { termEnd: s.termEnd, entityId: id };
}

export async function deriveHanover(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('hanover')!;
  const name = template.account.nickname;
  const today = easternToday();
  const { stmts, files } = await loadHanoverData(env, folder.id);
  const s = summarizeHanover(stmts, today);
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;

  let meta: FolderMeta = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    meta = {};
  }
  const entry = await ensureVaultEntry(env, await adoptEntry(env, folder, name), name);
  if (entry.id !== folder.vault_entry_id) {
    await env.DB.prepare('UPDATE statement_folders SET vault_entry_id = ?, updated_at = ? WHERE id = ?').bind(entry.id, now(), folder.id).run();
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `Hanover document dated ${fmtMdy(st.periodEnd.slice(0, 10))} failed “${c.name}” (${c.detail})` });
    }
  }
  // Renewal premium jump (new term vs where the last term ended), per line.
  if (s.terms.length >= 2) {
    const [prev, cur] = s.terms.slice(-2);
    for (const line of ['auto', 'home', 'umbrella'] as const) {
      const a = prev.end[line], b = cur.start[line];
      if (a && b && b > a * (1 + RENEWAL_JUMP)) {
        flags.push({
          key: `price_up:${line}:${cur.termStart}`,
          severity: 'warn',
          message: `Hanover ${LINE_LABEL[line]} renewed at ${fmtMoney(b)} for ${cur.termStart.slice(0, 4)}–${cur.termEnd.slice(2, 4)}, up ${Math.round(((b - a) / a) * 100)}% from ${fmtMoney(a)} — worth getting quotes`,
        });
      }
    }
  }
  // The term ended and no new declarations are in the folder.
  if (s.termEnd && today > addDays(s.termEnd, 21)) {
    flags.push({ key: `missing_after:${s.termEnd}`, severity: 'warn', message: `No Hanover renewal in the Drive folder since the term ended ${fmtMdy(s.termEnd)} — download the new declarations and payment schedule from hanover.com/MHP` });
  }
  // Payments ran out mid-term (no schedule for what's left of the term).
  if (s.termEnd && !s.next && s.payments.length && today < s.termEnd && s.billedPremium > 0) {
    const lastDate = s.payments[s.payments.length - 1].date;
    flags.push({ key: `schedule_end:${lastDate}`, severity: 'info', message: `No Hanover withdrawals scheduled after ${fmtMdy(lastDate)} — the term runs to ${fmtMdy(s.termEnd)}; the renewal notice should bring the next schedule` });
  }

  // Bills & Due Dates: each withdrawal is a "bill", up to the next scheduled one.
  const upto = s.next ? s.payments.indexOf(s.next) + 1 : s.payments.length;
  const billing = billingFromBills(
    s.payments.slice(0, upto).map((p) => ({ date: p.date, amount: p.total, totalDue: p.total, dueDate: p.date, autopay: s.autopay, paid: null }))
  );
  meta.billing = billing;
  flags.push(...(await payerFlags(env, entry.id, name, billing)));
  await syncFlags(env, folder.id, flags);

  // ---- Renewal reminder (Today) ----
  meta.renewalTask = await syncRenewalTask(env, folder.id, meta, s, today);

  // ---- Vault note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (s.policies.length) {
    sections.push({
      key: 'premiums',
      match: (h) => /^(Current )?Premiums\b/i.test(h),
      heading: `Premiums as of ${fmtMdy(today)}`,
      blocks: [
        table(
          ['Policy', 'Number', 'Premium / Yr', 'Paid By', 'Term'],
          s.policies.map((p) => [
            p.label,
            p.policyNumber,
            fmtMoney(p.premium),
            p.paidVia === 'escrow' ? 'Mortgage escrow' : p.paidVia === 'autopay' ? `Auto-Pay${s.last4 ? ` ••${s.last4}` : ''}` : 'Bill',
            `${fmtMdy(p.termStart)} – ${fmtMdy(p.termEnd)}`,
          ])
        ),
        para([bold('Total: '), `${fmtMoney(s.annualPremium)} a year (${fmtMoney(s.billedPremium)} by Auto-Pay, ${fmtMoney(s.escrowPremium)} through escrow).`]),
      ],
    });
    sections.push({
      key: 'payments',
      match: (h) => /^Payment Schedule$/i.test(h.trim()),
      heading: 'Payment Schedule',
      blocks: [
        kv([
          ['Next Withdrawal', s.next ? `${fmtMoney(s.next.total)} on ${fmtMdy(s.next.date)}` : '—'],
          ['From', s.last4 ? `Bank account ••${s.last4}` : '—'],
          ['Paid This Term', `${fmtMoney(s.paidThisTerm)} (incl. ${fmtMoney(s.feesThisTerm)} installment fees)`],
          ['Left This Term', fmtMoney(s.remainingThisTerm)],
          ['Renews', s.termEnd ? `${fmtMdy(s.termEnd)} (reminder on Today ${fmtMdy(addDays(s.termEnd, -RENEWAL_LEAD_DAYS))})` : '—'],
        ]),
        table(
          ['Date', 'Amount', 'Auto', 'Umbrella', ''],
          s.payments.map((p) => [fmtMdy(p.date), fmtMoney(p.total), p.byLine.auto != null ? fmtMoney(p.byLine.auto) : '—', p.byLine.umbrella != null ? fmtMoney(p.byLine.umbrella) : '—', p.status === 'withdrawn' ? 'Withdrawn' : 'Scheduled'])
        ),
      ],
    });
    sections.push({
      key: 'changes',
      match: (h) => /^Premium Changes$/i.test(h.trim()),
      heading: 'Premium Changes',
      blocks: [
        bullets(
          s.changes.map((c) => {
            const doc = s.policies.find((p) => p.line === c.line)?.history.find((h) => h.effective === c.date);
            const url = doc ? fileUrl(doc.fileId) : null;
            const amt = c.amount == null ? '' : ` — ${c.amount >= 0 ? '+' : '−'}${fmtMoney(Math.abs(c.amount))}/yr${c.billed != null ? ` (${c.billed >= 0 ? '+' : '−'}${fmtMoney(Math.abs(c.billed))} pro-rated)` : ''}`;
            return url ? [`${fmtMdy(c.date)} · ${c.line ? LINE_LABEL[c.line] : ''}: ${c.description}${amt} · `, link('PDF', url)] : `${fmtMdy(c.date)} · ${c.line ? LINE_LABEL[c.line] : ''}: ${c.description}${amt}`;
          })
        ),
      ],
    });
    if (s.vehicles.length) {
      sections.push({
        key: 'vehicles',
        match: (h) => /^Vehicles( Insured)?$/i.test(h.trim()),
        heading: 'Vehicles Insured',
        blocks: [
          table(
            ['Vehicle', 'VIN', 'Premium / Yr', 'Miles / Yr', 'Additional Insured'],
            s.vehicles.map((v) => [`${v.year} ${v.make} ${v.model}`, v.vin, v.premium != null ? fmtMoney(v.premium) : '—', v.mileage != null ? v.mileage.toLocaleString('en-US') : '—', v.additionalInsured ?? '—'])
          ),
          para(s.defensiveDriving.perYear != null ? `Defensive driving (accident prevention course) discount: ${usd0(s.defensiveDriving.perYear)} a year across these cars.` : 'Defensive driving discount: not shown on the latest declarations.'),
        ],
      });
    }
  }
  const intro = [
    heading(2, 'About'),
    para('Read nightly from the Hanover Insurance Drive folder (payment schedules + declarations). Sections below refresh on their own; everything else in this note is yours.'),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Premiums & Payments', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'My Hanover (Billing)', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
