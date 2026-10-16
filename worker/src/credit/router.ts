import { Hono } from 'hono';
import type { Env } from '../types';
import type { CreditReport } from './types';
import { cleanReport } from './clean';
import { summarizeCredit } from './summary';
import { syncCreditReportsTask } from './task';

/** Finance → Credit Reports (migration 0136), mounted at /api/credit-reports
 * behind authGate. Reports are stored whole as JSON (one row per bureau
 * report); the page's merged accounts, checks and stats come from
 * summarizeCredit on every GET. */
export const creditReportsRouter = new Hono<{ Bindings: Env }>();

function todayEastern(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function loadReports(env: Env): Promise<CreditReport[]> {
  const { results } = await env.DB.prepare('SELECT data_json FROM credit_reports ORDER BY pulled_on, bureau').all<{ data_json: string }>();
  return (results ?? []).map((r) => JSON.parse(r.data_json) as CreditReport);
}

async function buildSummary(env: Env) {
  const reports = await loadReports(env);
  const cards = await env.DB.prepare('SELECT nickname, issuer, last4, active FROM payment_cards').all<{ nickname: string; issuer: string | null; last4: string | null; active: number }>();
  const folders = await env.DB.prepare("SELECT folder_name AS name FROM statement_folders WHERE status = 'live'").all<{ name: string }>();
  const known = await env.DB.prepare('SELECT account_key FROM credit_report_known').all<{ account_key: string }>();
  return summarizeCredit(
    reports,
    {
      cards: (cards.results ?? []).map((c) => ({ nickname: c.nickname, issuer: c.issuer, last4: c.last4, active: !!c.active })),
      folders: folders.results ?? [],
      known: new Set((known.results ?? []).map((k) => k.account_key)),
    },
    todayEastern(),
  );
}

async function upsert(env: Env, r: CreditReport, source: string) {
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO credit_reports (id, bureau, pulled_on, file_id, source, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET bureau = excluded.bureau, pulled_on = excluded.pulled_on, file_id = excluded.file_id,
       source = excluded.source, data_json = excluded.data_json, updated_at = excluded.updated_at`,
  )
    .bind(r.id, r.bureau, r.pulled_on, r.file_id, source, JSON.stringify(r), ts, ts)
    .run();
}

// GET / — the whole page.
creditReportsRouter.get('/', async (c) => c.json(await buildSummary(c.env)));

// GET /reports/:id — one stored report as imported (for the report sheet).
creditReportsRouter.get('/reports/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT data_json FROM credit_reports WHERE id = ?').bind(c.req.param('id')).first<{ data_json: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(JSON.parse(row.data_json));
});

// POST /import { reports: [...] } — all-or-nothing; re-importing a report replaces it.
creditReportsRouter.post('/import', async (c) => {
  const body = await c.req.json<{ reports?: unknown[] }>().catch(() => null);
  const list = Array.isArray(body?.reports) ? body!.reports : Array.isArray(body) ? (body as unknown[]) : null;
  if (!list || !list.length) return c.json({ error: 'expected { reports: [...] }' }, 400);
  if (list.length > 200) return c.json({ error: 'too many reports in one import (max 200)' }, 400);
  const clean: CreditReport[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = cleanReport(list[i]);
    if (typeof r === 'string') return c.json({ error: `report ${i + 1}: ${r}` }, 400);
    clean.push(r);
  }
  for (const r of clean) await upsert(c.env, r, 'import');
  await syncCreditReportsTask(c.env);
  return c.json({ imported: clean.length, ids: clean.map((r) => r.id) });
});

// DELETE /reports/:id
creditReportsRouter.delete('/reports/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM credit_reports WHERE id = ?').bind(c.req.param('id')).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// POST /known { key, known } — "Mark as Mine" on an account MikeOS doesn't track.
creditReportsRouter.post('/known', async (c) => {
  const body = await c.req.json<{ key?: string; known?: boolean }>().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim().slice(0, 120) : '';
  if (!key) return c.json({ error: 'key is required' }, 400);
  if (body?.known === false) await c.env.DB.prepare('DELETE FROM credit_report_known WHERE account_key = ?').bind(key).run();
  else await c.env.DB.prepare('INSERT OR IGNORE INTO credit_report_known (account_key, created_at) VALUES (?, ?)').bind(key, new Date().toISOString()).run();
  return c.json({ ok: true });
});
