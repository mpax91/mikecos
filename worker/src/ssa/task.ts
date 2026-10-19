import type { Env } from '../types';

/** Yearly "Download Your Social Security Statement" task (Mike, 2026-10-19).
 * SSA posts the new statement each spring once last year's W-2s are in
 * (Mike's arrive ~Apr 13). An ordinary recurring task (id 'ssa-statement',
 * migration 0140, Apr 20 — editable in Settings → Recurring Tasks) carrying
 * TaskMeta `{ action: 'social-security' }` → "Open Social Security →".
 * MikeOS checks it off once a statement dated within a month before the due
 * date (or later) is loaded. */

export const SSA_TASK_DEF_ID = 'ssa-statement';
const EARLY_DAYS = 30;
export const SSA_TASK_DESCRIPTION =
  'Sign in to my Social Security (ssa.gov/myaccount), download your Social Security Statement (PDF) and save it to the Google Drive folder "Social Security" named "SSA - YYYY.MM.DD.pdf". MikeOS reads it overnight (or Scan Drive Now on Finance → Social Security), checks your earnings against your W-2s and updates the retirement projection — this task checks itself off.';

const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function syncSsaTask(env: Env): Promise<void> {
  const def = await env.DB.prepare('SELECT current_task_id FROM recurring_task_definitions WHERE id = ?').bind(SSA_TASK_DEF_ID).first<{ current_task_id: string | null }>();
  if (!def?.current_task_id) return;
  const task = await env.DB.prepare('SELECT id, title, status, due_date FROM entities WHERE id = ?').bind(def.current_task_id).first<{ id: string; title: string; status: string; due_date: string | null }>();
  if (!task || task.status !== 'open' || !task.due_date) return;
  const have = await env.DB.prepare('SELECT 1 AS ok FROM ssa_statements WHERE statement_date >= ? LIMIT 1').bind(minusDays(task.due_date, EARLY_DAYS)).first<{ ok: number }>();
  if (!have) return;
  const ts = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, task.id),
    env.DB.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), task.id, task.title, ts, easternToday()),
  ]);
}
