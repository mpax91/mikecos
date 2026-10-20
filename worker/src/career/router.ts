import { Hono } from 'hono';
import type { Env } from '../types';
import { cleanEmployer } from './clean';
import { ingestCareerJson, loadEmployers, loadEvents, loadStubs, scanCareer, storeEmployer, type CareerFileRow, type CareerFolderRow } from './drive';
import { summarizeCareer, type SsaYear, type W2Row } from './summary';

/** Finance → Career (migration 0141), mounted at /api/career behind
 * authGate. Paystubs / equity events are stored whole as JSON; the page's
 * timeline, years, pay history and checks come from summarizeCareer on
 * every GET. */
export const careerRouter = new Hono<{ Bindings: Env }>();

const todayEastern = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Mike's W-2s per year from Finance → Taxes (single years: every W-2; joint: Mike's). */
async function w2Rows(env: Env): Promise<{ rows: W2Row[]; refundable: Map<number, { refundable: number | null; detail: string | null }> }> {
  const rows: W2Row[] = [];
  const refundable = new Map<number, { refundable: number | null; detail: string | null }>();
  try {
    const { results } = await env.DB.prepare('SELECT year, data_json FROM tax_returns').all<{ year: number; data_json: string }>();
    for (const r of results ?? []) {
      const d = JSON.parse(r.data_json) as { filing_status?: string; people?: { who?: string; employer?: string; wages?: number }[]; federal?: { refundable_credits?: number | null; credit_detail?: string | null } };
      for (const p of Array.isArray(d.people) ? d.people : []) {
        const mine = d.filing_status === 'single' || /^(mike|michael|m\.?\s*palladino|palladino, m)/i.test(String(p.who ?? '').trim());
        if (mine && Number(p.wages) > 0) rows.push({ year: Number(r.year), employer: String(p.employer ?? ''), wages: Number(p.wages) });
      }
      refundable.set(Number(r.year), { refundable: d.federal?.refundable_credits ?? null, detail: d.federal?.credit_detail ?? null });
    }
  } catch {
    /* Taxes not set up — skip the cross-check */
  }
  return { rows, refundable };
}

/** SSA earnings by year (Social Security + Medicare wages) from the newest statement listing each year. */
async function ssaYears(env: Env): Promise<SsaYear[]> {
  try {
    const { results } = await env.DB.prepare('SELECT data_json FROM ssa_statements ORDER BY statement_date').all<{ data_json: string }>();
    const by = new Map<number, SsaYear>();
    for (const r of results ?? []) {
      const s = JSON.parse(r.data_json) as { earnings?: { from: number; to: number; ss: number; medicare: number }[] };
      for (const e of s.earnings ?? []) if (e.from === e.to) by.set(e.from, { year: e.from, ss: e.ss, medicare: e.medicare });
    }
    return [...by.values()].sort((a, b) => a.year - b.year);
  } catch {
    return [];
  }
}

careerRouter.get('/', async (c) => {
  const [employers, stubs, events, w2, ssa] = await Promise.all([loadEmployers(c.env), loadStubs(c.env), loadEvents(c.env), w2Rows(c.env), ssaYears(c.env)]);
  const summary = summarizeCareer({ employers, stubs, events, w2: w2.rows, refundable: w2.refundable, ssa, today: todayEastern() });
  const settings = await c.env.DB.prepare('SELECT last_scan_at, last_error FROM career_settings WHERE id = 1').first<{ last_scan_at: string | null; last_error: string | null }>();
  const files = (await c.env.DB.prepare("SELECT * FROM career_files WHERE kind != 'other' ORDER BY employer_id, name DESC").all<CareerFileRow>()).results ?? [];
  const folders = (await c.env.DB.prepare('SELECT * FROM career_folders ORDER BY employer_id').all<CareerFolderRow>()).results ?? [];
  return c.json({
    ...summary,
    drive: {
      lastScanAt: settings?.last_scan_at ?? null,
      lastError: settings?.last_error ?? null,
      folders: folders.map((f) => ({ folderId: f.folder_id, employerId: f.employer_id, name: f.name, url: f.url, listedAt: f.listed_at })),
      files: files.map((f) => ({ fileId: f.file_id, employerId: f.employer_id, name: f.name, kind: f.kind, status: f.status, recordId: f.record_id, error: f.error, webUrl: f.web_url })),
    },
  });
});

careerRouter.post('/scan', async (c) => c.json(await scanCareer(c.env, { refind: c.req.query('refind') === '1' })));

// POST /import { employers?, stubs?, events? } — all-or-nothing; same id replaces.
careerRouter.post('/import', async (c) => {
  const text = await c.req.text();
  if (text.length > 8_000_000) return c.json({ error: 'too large' }, 400);
  const out = await ingestCareerJson(c.env, text, 'import');
  if (out.status !== 'imported') return c.json({ error: out.error }, 400);
  return c.json({ employers: out.employers, stubs: out.stubs, events: out.events });
});

// PUT /employers/:id — edit name, title, dates, current flag, folder names, aliases.
careerRouter.put('/employers/:id', async (c) => {
  const id = c.req.param('id');
  const existing = (await loadEmployers(c.env)).find((e) => e.id === id);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'bad body' }, 400);
  const clean = cleanEmployer({ ...(existing ?? {}), ...body, id });
  if (typeof clean === 'string') return c.json({ error: clean }, 400);
  // Only one current employer at a time.
  if (clean.is_current) await c.env.DB.prepare('UPDATE career_employers SET is_current = 0 WHERE id != ?').bind(id).run();
  await storeEmployer(c.env, clean);
  // Folder names changed → find the folders again on the next scan.
  if (existing && JSON.stringify(existing.folder_names) !== JSON.stringify(clean.folder_names)) await c.env.DB.prepare('DELETE FROM career_folders WHERE employer_id = ?').bind(id).run();
  return c.json(clean, existing ? 200 : 201);
});

careerRouter.delete('/employers/:id', async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM career_employers WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM career_stubs WHERE employer_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM career_events WHERE employer_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM career_folders WHERE employer_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM career_files WHERE employer_id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

careerRouter.delete('/stubs/:id', async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM career_stubs WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(`UPDATE career_files SET record_id = NULL, status = 'queued' WHERE record_id = ?`).bind(id).run();
  return c.json({ ok: true });
});
