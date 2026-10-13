import { Hono } from 'hono';
import type { Env } from '../types';
import type { TaxReturn } from './types';
import { summarizeYear, taxInsights } from './summary';
import { CPI_BASE_YEAR } from './reference';

/** Finance → Taxes (migration 0116). One row per tax year; the dashboard's
 * per-year figures and "Things to Check" are derived on read. Mounted at
 * /api/taxes (behind authGate like every /api route). */
export const taxesRouter = new Hono<{ Bindings: Env }>();

const STATUSES = new Set(['single', 'mfj', 'mfs', 'hoh']);
// Never store an SSN/ITIN-shaped string anywhere in a return.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;

/** Validate + normalize an incoming year. Returns an error string or the
 * cleaned return. Numbers are rounded to whole dollars; unknown fields drop. */
export function cleanReturn(input: unknown): TaxReturn | string {
  if (!input || typeof input !== 'object') return 'not an object';
  const r = input as Partial<TaxReturn>;
  const year = Number(r.year);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) return 'year is required (e.g. 2025)';
  if (!r.filing_status || !STATUSES.has(r.filing_status)) return 'filing_status must be single, mfj, mfs or hoh';
  if (SSN_RE.test(JSON.stringify(input))) return 'looks like it contains a Social Security number — remove it';
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
  const obj = (o: unknown, keys: string[]) => {
    if (!o || typeof o !== 'object') return null;
    const src = o as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    for (const k of keys) res[k] = k.endsWith('_detail') || k === 'deduction_type' || k === 'notes' || k === 'filer' ? str(src[k]) : num(src[k]);
    return res;
  };
  const F = [
    'wages',
    'taxable_interest',
    'tax_exempt_interest',
    'ordinary_dividends',
    'qualified_dividends',
    'ira_taxable',
    'pensions_taxable',
    'social_security_taxable',
    'capital_gain',
    'business_income',
    'unemployment',
    'other_income',
    'total_income',
    'adjustments',
    'agi',
    'deduction_type',
    'deduction',
    'exemptions',
    'qbi_deduction',
    'taxable_income',
    'tax',
    'amt',
    'nonrefundable_credits',
    'credit_detail',
    'other_taxes',
    'other_taxes_detail',
    'total_tax',
    'withholding',
    'estimated_payments',
    'refundable_credits',
    'total_payments',
    'refund',
    'amount_owed',
    'penalty',
    'applied_to_next_year',
  ];
  const I = ['medical', 'salt_paid', 'salt_deducted', 'real_estate_tax', 'mortgage_interest', 'charity', 'other', 'total'];
  const S = [
    'federal_agi',
    'ny_agi',
    'ct_agi',
    'ct_source_income',
    'filer',
    'deduction_type',
    'deduction',
    'dependent_exemptions',
    'taxable_income',
    'tax',
    'credits',
    'total_tax',
    'withholding',
    'estimated_payments',
    'refund',
    'amount_owed',
    'notes',
  ];
  const federal = obj(r.federal, F);
  if (!federal) return 'federal section is required';
  if (federal.deduction_type !== null && federal.deduction_type !== 'standard' && federal.deduction_type !== 'itemized') federal.deduction_type = null;
  const strings = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map(str)
          .filter((s): s is string => !!s)
          .slice(0, 40)
      : [];
  return {
    year,
    filing_status: r.filing_status,
    prepared_by: str(r.prepared_by),
    amended: !!r.amended,
    source_files: Array.isArray(r.source_files)
      ? r.source_files
          .filter((f) => f && typeof f.id === 'string' && /^[\w-]{10,80}$/.test(f.id))
          .map((f) => ({ id: f.id, title: str(f.title) ?? 'File', what: str(f.what) ?? 'other' }))
          .slice(0, 20)
      : [],
    people: Array.isArray(r.people)
      ? r.people
          .filter((p) => p && typeof p.who === 'string')
          .map((p) => ({ who: str(p.who) ?? 'Mike', employer: str(p.employer) ?? '', wages: num(p.wages) ?? 0 }))
          .slice(0, 20)
      : [],
    federal: federal as unknown as TaxReturn['federal'],
    itemized: obj(r.itemized, I) as TaxReturn['itemized'],
    ny: obj(r.ny, S) as TaxReturn['ny'],
    ct: obj(r.ct, S) as TaxReturn['ct'],
    dependents: num(r.dependents),
    checks: r.checks && typeof r.checks === 'object' ? Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, str(v) ?? ''])) : {},
    doubts: strings(r.doubts),
    notes: strings(r.notes),
  };
}

async function loadAll(env: Env): Promise<TaxReturn[]> {
  const { results } = await env.DB.prepare('SELECT data_json FROM tax_returns ORDER BY year').all<{ data_json: string }>();
  return results.map((r) => JSON.parse(r.data_json) as TaxReturn);
}

async function upsert(env: Env, r: TaxReturn, source: 'import' | 'manual') {
  const ts = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tax_returns (year, data_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, updated_at = excluded.updated_at`,
  )
    .bind(r.year, JSON.stringify(r), source, ts, ts)
    .run();
}

// GET /api/taxes — every year + derived summary + Things to Check.
taxesRouter.get('/', async (c) => {
  const returns = await loadAll(c.env);
  const summary = returns.map(summarizeYear);
  return c.json({ returns, summary, insights: taxInsights(returns, summary), cpiBaseYear: CPI_BASE_YEAR });
});

// PUT /api/taxes/:year — create or replace one year (Mike's edit).
taxesRouter.put('/:year', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const cleaned = cleanReturn(body);
  if (typeof cleaned === 'string') return c.json({ error: cleaned }, 400);
  if (cleaned.year !== Number(c.req.param('year'))) return c.json({ error: 'year in the URL and body differ' }, 400);
  await upsert(c.env, cleaned, 'manual');
  return c.json(cleaned);
});

// POST /api/taxes/import { returns: TaxReturn[] } — bulk upsert (the one-time
// load from the Drive PDFs). All-or-nothing validation.
taxesRouter.post('/import', async (c) => {
  const body = await c.req.json<{ returns?: unknown[] }>().catch(() => null);
  if (!body || !Array.isArray(body.returns) || !body.returns.length) return c.json({ error: 'returns[] is required' }, 400);
  const cleaned: TaxReturn[] = [];
  for (const r of body.returns) {
    const x = cleanReturn(r);
    if (typeof x === 'string') return c.json({ error: `${(r as { year?: number })?.year ?? '?'}: ${x}` }, 400);
    cleaned.push(x);
  }
  for (const r of cleaned) await upsert(c.env, r, 'import');
  return c.json({ imported: cleaned.length, years: cleaned.map((r) => r.year) });
});

// DELETE /api/taxes/:year
taxesRouter.delete('/:year', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM tax_returns WHERE year = ?')
    .bind(Number(c.req.param('year')))
    .run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
