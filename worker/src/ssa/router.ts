import { Hono } from 'hono';
import type { Env } from '../types';
import { summarizeSsa } from './summary';
import { syncSsaTask } from './task';
import { ingestSsaJson, loadSsaSettings, loadStatements, scanSsaFolder, type SsaFileRow } from './drive';

/** Finance → Social Security (migration 0140), mounted at /api/social-security
 * behind authGate. Statements are stored whole as JSON; the page's merged
 * earnings record, checks and projection come from summarizeSsa on every GET. */
export const ssaRouter = new Hono<{ Bindings: Env }>();

const todayEastern = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Mike's W-2 wages per year from Finance → Taxes (single years: every W-2; joint: Mike's). */
async function w2Wages(env: Env): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const { results } = await env.DB.prepare('SELECT year, data_json FROM tax_returns').all<{ year: number; data_json: string }>();
    for (const r of results ?? []) {
      const d = JSON.parse(r.data_json) as { filing_status?: string; people?: { who?: string; wages?: number }[] };
      const people = Array.isArray(d.people) ? d.people : [];
      const mine = people.filter((p) => (d.filing_status === 'single' ? true : /^(mike|michael|m\.?\s*palladino|palladino, m)/i.test(String(p.who ?? '').trim())));
      const total = mine.reduce((s, p) => s + (Number(p.wages) || 0), 0);
      if (total > 0) out.set(Number(r.year), total);
    }
  } catch {
    /* Taxes not set up — skip the cross-check */
  }
  return out;
}

ssaRouter.get('/', async (c) => {
  const summary = summarizeSsa(await loadStatements(c.env), await w2Wages(c.env), todayEastern());
  const s = await loadSsaSettings(c.env);
  const files = (await c.env.DB.prepare("SELECT * FROM ssa_files WHERE kind != 'other' ORDER BY name DESC").all<SsaFileRow>()).results ?? [];
  return c.json({
    ...summary,
    drive: {
      folder: s.folder_name,
      folderUrl: s.folder_url,
      lastScanAt: s.last_scan_at,
      lastError: s.last_error,
      files: files.map((f) => ({ fileId: f.file_id, name: f.name, kind: f.kind, status: f.status, statementId: f.statement_id, error: f.error, webUrl: f.web_url })),
    },
  });
});

ssaRouter.post('/scan', async (c) => c.json(await scanSsaFolder(c.env)));

// POST /import { statements: [...] } — all-or-nothing; same date replaces.
ssaRouter.post('/import', async (c) => {
  const text = await c.req.text();
  if (text.length > 2_000_000) return c.json({ error: 'too large' }, 400);
  const out = await ingestSsaJson(c.env, text, 'import');
  if (out.status !== 'imported') return c.json({ error: out.error }, 400);
  await syncSsaTask(c.env);
  return c.json({ imported: out.ids.length, ids: out.ids });
});

ssaRouter.delete('/statements/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM ssa_statements WHERE id = ?').bind(c.req.param('id')).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(`UPDATE ssa_files SET statement_id = NULL, status = 'queued' WHERE statement_id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
