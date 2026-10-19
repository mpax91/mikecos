import type { SsaEarningsRow, SsaLayout, SsaStatement } from './types';

/** Validate + normalize one statement (PDF read or imported JSON) before it
 * is stored. Returns an error string instead of throwing. Never keeps an
 * SSN: any NNN-NN-NNNN or XXX-XX-NNNN string anywhere is rejected. */

const LAYOUTS: SsaLayout[] = ['paper', 'classic', 'chart2021', 'chart'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e8 ? Math.round(n) : null;
};

export function cleanStatement(raw: unknown): SsaStatement | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const json = JSON.stringify(raw);
  if (/\b(?:\d{3}|X{3})-(?:\d{2}|X{2})-\d{4}\b/i.test(json)) return 'contains a Social Security number — remove it';
  const r = raw as Record<string, unknown>;
  const date = String(r.statement_date ?? r.id ?? '');
  if (!ISO.test(date)) return 'statement_date must be YYYY-MM-DD';
  const layout = (LAYOUTS.includes(r.layout as SsaLayout) ? r.layout : 'paper') as SsaLayout;
  const birth = r.birth_date == null ? null : String(r.birth_date);
  if (birth != null && !ISO.test(birth)) return 'birth_date must be YYYY-MM-DD';
  const fra = r.fra_years == null ? null : Number(r.fra_years);
  if (fra != null && !(fra >= 65 && fra <= 67)) return 'fra_years must be 65–67';

  const retirement: Record<string, number> = {};
  const ret = (r.retirement ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ret)) {
    const age = Number(k);
    const amt = money(v);
    if (age >= 62 && age <= 70 && Number.isInteger(age) && amt != null) retirement[String(age)] = amt;
  }
  if (!Object.keys(retirement).length) return 'retirement estimates are missing';

  const earnings: SsaEarningsRow[] = [];
  const rows = Array.isArray(r.earnings) ? r.earnings : [];
  for (const row of rows as Record<string, unknown>[]) {
    const from = Number(row?.from ?? row?.year);
    const to = Number(row?.to ?? row?.year ?? from);
    const ss = money(row?.ss);
    const medicare = money(row?.medicare);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1937 || to < from || to > 2100 || ss == null) return `bad earnings row ${JSON.stringify(row)}`;
    earnings.push({ from, to, ss, medicare: medicare ?? ss });
  }
  if (!earnings.length) return 'earnings record is missing';
  earnings.sort((a, b) => a.from - b.from);

  const sv = (r.survivors ?? {}) as Record<string, unknown>;
  const tx = (r.taxes ?? {}) as Record<string, unknown>;
  const tf = r.trust_fund as { year?: unknown; pct?: unknown } | null | undefined;
  return {
    id: date,
    statement_date: date,
    layout,
    file_id: r.file_id == null ? null : String(r.file_id).slice(0, 200),
    file_name: r.file_name == null ? null : String(r.file_name).slice(0, 200),
    birth_date: birth,
    fra_years: fra,
    retirement,
    age62_stop_now: !!r.age62_stop_now,
    assumed_earnings: money(r.assumed_earnings),
    disability: money(r.disability),
    survivors: { child: money(sv.child), spouse_caring: money(sv.spouse_caring), spouse_fra: money(sv.spouse_fra), family_max: money(sv.family_max) },
    death_benefit: money(r.death_benefit),
    earnings,
    taxes: { ss_you: money(tx.ss_you), ss_employer: money(tx.ss_employer), medicare_you: money(tx.medicare_you), medicare_employer: money(tx.medicare_employer) },
    trust_fund: tf && Number(tf.year) > 2000 && Number(tf.pct) > 0 && Number(tf.pct) <= 100 ? { year: Number(tf.year), pct: Number(tf.pct) } : null,
    notes: r.notes == null ? null : String(r.notes).slice(0, 2000),
  };
}
