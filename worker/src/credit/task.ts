import type { Env } from '../types';

/** Yearly "Pull Free Credit Reports" task (Mike, 2026-10-16): his ritual is
 * Feb 22 — Equifax, Experian and TransUnion from AnnualCreditReport.com,
 * saved to the Drive "Credit Reports" folder as "YYYY.MM.DD - Bureau.pdf".
 * An ordinary recurring task (id 'credit-reports', migration 0136; date and
 * on/off editable in Settings → Recurring Tasks) carrying TaskMeta
 * `{ action: 'credit-reports' }` → "Open Credit Reports →". MikeOS checks the
 * open one off once reports from all three bureaus pulled within a month
 * before its due date (or later) are loaded. */

export const CREDIT_TASK_DEF_ID = 'credit-reports';
const EARLY_DAYS = 30;
export const CREDIT_TASK_DESCRIPTION =
  'Pull all three free reports at annualcreditreport.com (Equifax, Experian, TransUnion). Save each PDF to the Google Drive folder "Credit Reports" named "YYYY.MM.DD - Bureau.pdf", then load them into MikeOS (Finance → Credit Reports).';

const now = () => new Date().toISOString();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Bureaus still missing for a task due on `due`. */
export async function missingBureaus(env: Env, due: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT bureau FROM credit_reports WHERE pulled_on >= ?`).bind(minusDays(due, EARLY_DAYS)).all<{ bureau: string }>();
  const have = new Set((results ?? []).map((r) => r.bureau));
  return ['equifax', 'experian', 'transunion'].filter((b) => !have.has(b));
}

export async function syncCreditReportsTask(env: Env): Promise<void> {
  const def = await env.DB.prepare('SELECT current_task_id FROM recurring_task_definitions WHERE id = ?').bind(CREDIT_TASK_DEF_ID).first<{ current_task_id: string | null }>();
  if (!def?.current_task_id) return;
  const task = await env.DB.prepare('SELECT id, title, status, due_date FROM entities WHERE id = ?')
    .bind(def.current_task_id)
    .first<{ id: string; title: string; status: string; due_date: string | null }>();
  if (!task || task.status !== 'open' || !task.due_date) return;
  if ((await missingBureaus(env, task.due_date)).length) return;
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, task.id),
    env.DB.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), task.id, task.title, ts, easternToday()),
  ]);
}
