import type { Env } from '../types';

/** Monthly "Export Bedford Bee Stats" task (Mike, 2026-10-10): an ordinary
 * recurring task (id 'bee-export', migration 0099; day and on/off editable
 * in Settings → Recurring Tasks). MikeOS checks the open one off as soon as
 * a posts, a subscriber and a Stripe export dated within a week before its
 * due date (or later) have all been read from the folder. */

export const BEE_TASK_DEF_ID = 'bee-export';
const EARLY_DAYS = 7;

const now = () => new Date().toISOString();
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Which exports are still missing for a task due on `due`. */
export async function missingExports(env: Env, due: string): Promise<string[]> {
  const since = minusDays(due, EARLY_DAYS);
  const { results } = await env.DB.prepare(`SELECT DISTINCT kind FROM bee_files WHERE status = 'parsed' AND export_date >= ?`).bind(since).all<{ kind: string }>();
  const have = new Set((results ?? []).map((r) => r.kind));
  return (['posts', 'subscribers', 'stripe'] as const).filter((k) => !have.has(k));
}

export async function syncBeeExportTask(env: Env): Promise<void> {
  const def = await env.DB.prepare('SELECT current_task_id FROM recurring_task_definitions WHERE id = ?').bind(BEE_TASK_DEF_ID).first<{ current_task_id: string | null }>();
  if (!def?.current_task_id) return;
  const task = await env.DB.prepare('SELECT id, title, status, due_date FROM entities WHERE id = ?').bind(def.current_task_id).first<{
    id: string;
    title: string;
    status: string;
    due_date: string | null;
  }>();
  if (!task || task.status !== 'open' || !task.due_date) return;
  if ((await missingExports(env, task.due_date)).length) return;
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, task.id),
    env.DB.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(
      crypto.randomUUID(),
      task.id,
      task.title,
      ts,
      easternToday()
    ),
  ]);
}
