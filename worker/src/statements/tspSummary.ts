import { round2 } from './common';
import type { StatementCheck } from './common';
import type { TspFund, TspReturnRow, TspValues } from './templates/tsp';

/** Thrift Savings Plan analysis — computed on read from the statements, no
 * outside data: balance history, time-weighted returns, calendar years,
 * what each TSP fund did (from the fund tables TSP prints on its annual and
 * quarterly statements), "what if it had been in…", the fund history (which
 * funds held the money when), contributions, costs, the target-date fit and
 * Things to Check. */

export interface TspStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // key (may carry ":annual" / ":interim")
  date: string; // YYYY-MM-DD
  start: string;
  values: TspValues;
  checks: StatementCheck[];
}
export interface TspTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
  units: number | null;
  account: string | null;
}
export interface TspContext {
  today: string;
  birthDate: string | null; // from Social Security statements
  retireAge: number; // Merrill's plan setting, else 60
  /** Merrill's trailing fee rate (%/yr) when that folder is live — for the cost comparison. */
  advisoryRate: number | null;
}

export interface TspPoint {
  date: string;
  value: number;
  /** Growth of $1 (time-weighted) at this date. */
  index: number;
  funds: { fund: string; value: number; pct: number }[] | null;
}

export interface TspYear {
  year: number;
  start: number;
  end: number;
  gain: number;
  contributions: number;
  ret: number | null; // % (time-weighted from the statements)
  printed: number | null; // TSP's own personal rate of return on the annual statement
  partial: boolean;
  funds: Record<string, number | null>; // TSP fund 1-year returns (%) printed for that year
}

export interface TspInsight {
  key: string;
  severity: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
}

const CORE = ['G Fund', 'F Fund', 'C Fund', 'S Fund', 'I Fund'];
const FUND_ORDER = (f: string) => {
  const core = CORE.indexOf(f);
  if (core >= 0) return 100 + core;
  if (f === 'L Income') return 0;
  const y = Number(f.slice(2));
  return Number.isFinite(y) ? y - 2000 : 99;
};
export const sortFunds = (a: string, b: string) => FUND_ORDER(a) - FUND_ORDER(b);

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
const yearsBetween = (a: string, b: string) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (365.25 * 86400000);
const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) - n}${iso.slice(4)}`;
const pctOf = (a: number, b: number) => (b ? (a / b - 1) * 100 : null);

/** Statements that cover the same dates (an annual vs its Q4, an on-demand
 * copy) agree to the cent; prefer quarterly, then annual, then on-demand. */
const KIND_RANK = { quarterly: 0, annual: 1, interim: 2 } as const;

export function summarizeTsp(stmts: TspStmtRow[], txns: TspTxnRow[], ctx: TspContext) {
  const sorted = [...stmts].sort((a, b) => a.date.localeCompare(b.date) || KIND_RANK[a.values.kind] - KIND_RANK[b.values.kind]);
  const latest = [...sorted].sort((a, b) => a.date.localeCompare(b.date) || KIND_RANK[b.values.kind] - KIND_RANK[a.values.kind]).slice(-1)[0] ?? null;

  // ---- balance points (closing of each period; opening = close of the day before) ----
  const pts = new Map<string, { value: number; funds: TspFund[] | null; rank: number }>();
  const put = (date: string, value: number, funds: TspFund[] | null, rank: number) => {
    const cur = pts.get(date);
    if (!cur || rank < cur.rank || (!cur.funds && funds)) pts.set(date, { value, funds: funds ?? cur?.funds ?? null, rank: Math.min(rank, cur?.rank ?? 9) });
  };
  for (const s of sorted) {
    const v = s.values;
    const r = KIND_RANK[v.kind];
    put(s.date, v.closing, v.funds.length ? v.funds : null, r);
    const open = v.opening + (v.converted ?? 0);
    if (open > 0 || s.start <= '2004-12-31') {
      const begin = v.funds.some((f) => f.begin !== null) ? v.funds.map((f) => ({ ...f, end: f.begin ?? 0, price: f.beginPrice, shares: f.beginShares })) : null;
      put(dayBefore(s.start), open, begin, r + 0.5);
    }
    if (v.quarter) put(dayBefore(v.quarter.start), v.quarter.opening, null, 1.5);
  }
  const dates = [...pts.keys()].sort();

  // ---- time-weighted index (Modified Dietz between points; flows = dated contributions/withdrawals) ----
  const contribTx0 = txns.filter((t) => t.kind === 'contribution');
  const lifetime0 = [...sorted].reverse().find((s) => s.values.lifetime)?.values.lifetime ?? null;
  // Contributions the lifetime total knows about but no statement in Drive lists (a
  // missing quarter) — put on the first stretch no statement covers, so it isn't counted as gain.
  const dates0 = [...pts.keys()].sort();
  const covered = (a: string, b: string) => sorted.some((s) => dayBefore(s.start) <= a && s.date >= b);
  const uncovered = dates0.slice(1).map((d, i) => ({ from: dates0[i], to: d })).filter((g) => !covered(g.from, g.to));
  const unexplained = lifetime0 ? round2(lifetime0.traditional + lifetime0.roth - contribTx0.reduce((t, x) => t + x.amount, 0)) : 0;
  const lastContribution = contribTx0[contribTx0.length - 1]?.date ?? null;
  const inferredGap = unexplained > 0.5 ? (uncovered.find((g) => !lastContribution || g.from <= addDays(lastContribution, 400)) ?? null) : null;
  const inferred = inferredGap ? { from: inferredGap.from, to: inferredGap.to, amount: unexplained } : null;
  const flowsIn = (a: string, b: string) =>
    txns.filter((t) => t.date > a && t.date <= b && (t.kind === 'contribution' || t.kind === 'withdrawal')).reduce((s, t) => s + t.amount, 0) + (inferred && inferred.from >= a && inferred.to <= b ? inferred.amount : 0);
  const points: TspPoint[] = [];
  let index = 1;
  dates.forEach((d, i) => {
    const p = pts.get(d)!;
    if (i > 0) {
      const prev = points[i - 1];
      const f = flowsIn(prev.date, d);
      const base = prev.value + 0.5 * f;
      if (base > 0.005) index *= 1 + (p.value - prev.value - f) / base;
    }
    const total = p.value;
    points.push({
      date: d,
      value: round2(p.value),
      index,
      funds: p.funds ? p.funds.filter((f) => f.end > 0.004).map((f) => ({ fund: f.fund, value: round2(f.end), pct: total ? round2((f.end / total) * 100) : 0 })) : null,
    });
  });
  const first = points.find((p) => p.value > 0) ?? null;
  const last = points[points.length - 1] ?? null;
  const at = (date: string) => [...points].reverse().find((p) => p.date <= date) ?? null;
  const twr = (from: string): number | null => {
    if (!last || !first) return null;
    const a = at(from);
    if (!a || a.date < first.date || a.date === last.date) return null;
    const yrs = yearsBetween(a.date, last.date);
    const growth = last.index / a.index;
    return yrs > 1.01 ? (Math.pow(growth, 1 / yrs) - 1) * 100 : (growth - 1) * 100;
  };
  const asOf = last?.date ?? null;
  const returns = asOf
    ? {
        quarter: twr(points.length > 1 ? points[points.length - 2].date : asOf),
        ytd: twr(`${Number(asOf.slice(0, 4)) - 1}-12-31`),
        y1: twr(addYears(asOf, 1)),
        y3: twr(addYears(asOf, 3)),
        y5: twr(addYears(asOf, 5)),
        y10: twr(addYears(asOf, 10)),
        since: first ? twr(first.date) : null,
        sinceDate: first?.date ?? null,
      }
    : null;

  // ---- fund return tables printed by TSP (latest + one per year-end) ----
  const tables = sorted.filter((s) => s.values.fundReturns).map((s) => ({ asOf: s.values.fundReturns!.asOf, rows: s.values.fundReturns!.rows, personal: s.values.fundReturns!.personal }));
  const latestTable = tables.sort((a, b) => a.asOf.localeCompare(b.asOf)).slice(-1)[0] ?? null;
  const yearEndTable = (y: number) => tables.filter((t) => t.asOf === `${y}-12-31`).slice(-1)[0] ?? null;

  // ---- calendar years ----
  const years: TspYear[] = [];
  if (first && last) {
    for (let y = Number(first.date.slice(0, 4)); y <= Number(last.date.slice(0, 4)); y++) {
      const a = at(`${y - 1}-12-31`) ?? first;
      const b = at(`${y}-12-31`);
      if (!b || b.date <= a.date) continue;
      const annual = sorted.find((s) => s.values.kind === 'annual' && s.date === `${y}-12-31` && s.start === `${y}-01-01`);
      const table = yearEndTable(y);
      const funds: Record<string, number | null> = {};
      if (table) for (const [f, r] of Object.entries(table.rows)) funds[f] = r.y1 ?? r.ytd;
      years.push({
        year: y,
        start: a.value,
        end: b.value,
        contributions: round2(flowsIn(a.date, b.date)),
        gain: round2(b.value - a.value - flowsIn(a.date, b.date)),
        ret: a.index ? (b.index / a.index - 1) * 100 : null,
        printed: annual?.values.prr?.value ?? null,
        partial: b.date !== `${y}-12-31` || a.date !== `${y - 1}-12-31`,
        funds,
      });
    }
  }

  // ---- fund history: which funds held the money, and when it changed ----
  const holdings = points.filter((p) => p.funds && p.value > 0).map((p) => ({ date: p.date, funds: p.funds! }));
  const eras: { from: string; to: string; mix: { fund: string; pct: number }[] }[] = [];
  for (const h of holdings) {
    const key = h.funds.map((f) => f.fund).sort(sortFunds).join('+');
    const cur = eras[eras.length - 1];
    if (cur && cur.mix.map((m) => m.fund).sort(sortFunds).join('+') === key) cur.to = h.date;
    else eras.push({ from: h.date, to: h.date, mix: h.funds.map((f) => ({ fund: f.fund, pct: f.pct })).sort((a, b) => sortFunds(a.fund, b.fund)) });
  }
  const transfers = txns.filter((t) => t.kind === 'transfer_in' || t.kind === 'transfer_out').map((t) => ({ date: t.date, fund: t.account ?? '', amount: t.amount, units: t.units }));
  const current = latest?.values.funds.filter((f) => f.end > 0.004) ?? [];
  const elections = sorted
    .filter((s) => s.values.contribAlloc)
    .map((s) => ({ date: s.date, alloc: s.values.contribAlloc! }));
  const election = elections.slice(-1)[0]?.alloc ?? null;
  // Years the election (new money) and the actual money pointed different ways.
  let mismatch = null as { from: string; to: string } | null;
  for (const e of elections) {
    const p = at(e.date);
    if (!p?.funds) continue;
    const held = new Set(p.funds.map((f) => f.fund));
    const differs = Object.keys(e.alloc).some((f) => !held.has(f));
    if (differs) mismatch = { from: mismatch?.from ?? e.date, to: e.date };
  }

  // ---- unit prices (NAV) per fund ----
  const navs: Record<string, { date: string; price: number }[]> = {};
  for (const p of dates) {
    for (const f of pts.get(p)!.funds ?? []) {
      if (f.price === null || !(f.price > 0)) continue;
      const arr = (navs[f.fund] = navs[f.fund] ?? []);
      if (!arr.length || arr[arr.length - 1].date !== p) arr.push({ date: p, price: f.price });
    }
  }

  // ---- contributions (all money in came 2004–05) ----
  const contribTx = txns.filter((t) => t.kind === 'contribution');
  const byDate = new Map<string, number>();
  for (const t of contribTx) byDate.set(t.date, round2((byDate.get(t.date) ?? 0) + t.amount));
  const lifetimeRow = [...sorted].reverse().find((s) => s.values.lifetime)?.values.lifetime ?? null;
  const lifetime = lifetimeRow ? round2(lifetimeRow.traditional + lifetimeRow.roth) : round2(contribTx.reduce((s, t) => s + t.amount, 0));
  const sources = [...sorted].reverse().find((s) => s.values.sources)?.values.sources ?? null;
  const contributions = {
    lifetime,
    traditional: lifetimeRow?.traditional ?? lifetime,
    roth: lifetimeRow?.roth ?? 0,
    employer: sources?.employer ?? 0,
    first: contribTx[0]?.date ?? null,
    last: contribTx[contribTx.length - 1]?.date ?? null,
    count: byDate.size,
    list: [...byDate.entries()].map(([date, amount]) => ({ date, amount })),
    /** Contributions found on the statements in Drive (the lifetime figure includes any older ones). */
    onStatements: round2(contribTx.reduce((s, t) => s + t.amount, 0)),
    growth: last ? round2(last.value - lifetime) : null,
    multiple: last && lifetime ? last.value / lifetime : null,
  };

  // ---- costs ----
  const expenseRows = sorted.filter((s) => s.values.expenses).map((s) => s.values.expenses!);
  const expenseByYear = new Map<number, Record<string, number>>();
  for (const e of expenseRows) expenseByYear.set(e.year, { ...(expenseByYear.get(e.year) ?? {}), ...e.rows });
  const mainFund = current.length === 1 ? current[0].fund : current.sort((a, b) => b.end - a.end)[0]?.fund ?? null;
  const expenseHistory = [...expenseByYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, rows]) => {
      const held = years.find((y) => y.year === year);
      // Weighted by what was held at the start of the year.
      const p = at(`${year - 1}-12-31`) ?? at(`${year}-12-31`);
      const mix = p?.funds ?? [];
      const rate = mix.length ? mix.reduce((s, f) => s + (rows[f.fund] ?? rows[mainFund ?? ''] ?? 0) * (f.pct / 100), 0) : (rows[mainFund ?? ''] ?? null);
      const avg = held ? (held.start + held.end) / 2 : (p?.value ?? 0);
      return { year, rate, dollars: rate !== null ? round2((avg * rate) / 100) : null, rows };
    });
  const latestRate = expenseHistory.slice(-1)[0]?.rate ?? null;
  const balance = last?.value ?? 0;
  const costs = {
    rate: latestRate,
    year: expenseHistory.slice(-1)[0]?.year ?? null,
    perYear: latestRate !== null ? round2((balance * latestRate) / 100) : null,
    allTime: round2(expenseHistory.reduce((s, e) => s + (e.dollars ?? 0), 0)),
    history: expenseHistory,
    compare: [
      { label: 'TSP (now)', rate: latestRate ?? 0 },
      { label: 'Typical index fund', rate: 0.05 },
      { label: 'Typical target-date fund', rate: 0.3 },
      { label: ctx.advisoryRate !== null ? 'Merrill advisory (your rate)' : 'A 1% advisory account', rate: ctx.advisoryRate ?? 1 },
    ].map((c) => ({ ...c, perYear: round2((balance * c.rate) / 100), tenYears: round2(balance * (Math.pow(1.07, 10) - Math.pow(1.07 - c.rate / 100, 10))) })),
  };

  // ---- what if it had all been in … (TSP's own year-end fund returns) ----
  const tableYears = years.filter((y) => Object.keys(y.funds).length).map((y) => y.year);
  let whatIf: {
    from: string;
    start: number;
    years: number[];
    lines: { fund: string; values: { year: number; value: number }[]; end: number; missing: number[] }[];
    actual: { year: number; value: number }[];
    ytdNote: string | null;
  } | null = null;
  if (tableYears.length >= 3 && last) {
    const y0 = tableYears[0];
    const startPt = at(`${y0 - 1}-12-31`);
    if (startPt && startPt.value > 0) {
      const curYear = Number(last.date.slice(0, 4));
      const yearsList = [...tableYears];
      const ytdRow = latestTable && latestTable.asOf > `${curYear - 1}-12-31` && !yearsList.includes(curYear) ? latestTable : null;
      const ret = (fund: string, y: number): number | null => {
        if (ytdRow && y === curYear) {
          if (fund === 'C/S 50/50') {
            const c = ytdRow.rows['C Fund']?.ytd;
            const s = ytdRow.rows['S Fund']?.ytd;
            return c !== null && c !== undefined && s !== null && s !== undefined ? (c + s) / 2 : null;
          }
          return ytdRow.rows[fund]?.ytd ?? null;
        }
        const yr = years.find((x) => x.year === y);
        if (fund === 'C/S 50/50') {
          const c = yr?.funds['C Fund'];
          const s = yr?.funds['S Fund'];
          return c !== null && c !== undefined && s !== null && s !== undefined ? (c + s) / 2 : null;
        }
        return yr?.funds[fund] ?? null;
      };
      if (ytdRow) yearsList.push(curYear);
      const candidates = ['G Fund', 'F Fund', 'C Fund', 'S Fund', 'I Fund', 'C/S 50/50', 'L Income', ...(mainFund?.startsWith('L 20') ? [mainFund] : []), ...(ctxTarget(ctx) && ctxTarget(ctx) !== mainFund ? [ctxTarget(ctx)!] : [])];
      const lines = [...new Set(candidates)].map((fund) => {
        let v = startPt.value;
        const missing: number[] = [];
        const values = yearsList.map((y) => {
          const r = ret(fund, y);
          if (r === null) missing.push(y);
          else v *= 1 + r / 100;
          return { year: y, value: round2(v) };
        });
        return { fund, values, end: round2(v), missing };
      });
      whatIf = {
        from: startPt.date,
        start: startPt.value,
        years: yearsList,
        lines: lines.filter((l) => l.missing.length <= 2),
        actual: yearsList.map((y) => ({ year: y, value: (y === curYear ? last : at(`${y}-12-31`))?.value ?? 0 })),
        ytdNote: ytdRow ? `${curYear} is year-to-date through ${ytdRow.asOf}` : null,
      };
    }
  }

  // ---- target-date fit ----
  const birthYear = ctx.birthDate ? Number(ctx.birthDate.slice(0, 4)) : null;
  const age = ctx.birthDate ? Math.floor(yearsBetween(ctx.birthDate, ctx.today)) : null;
  const targetYear = birthYear !== null ? birthYear + ctx.retireAge : null;
  const suggested = ctxTarget(ctx);
  const lFunds = latestTable
    ? Object.entries(latestTable.rows)
        .filter(([f]) => f.startsWith('L '))
        .sort((a, b) => sortFunds(a[0], b[0]))
        .map(([fund, r]) => ({ fund, ...r, expense: expenseByYear.get(Math.max(...expenseByYear.keys()))?.[fund] ?? null }))
    : [];
  const target = {
    current: mainFund,
    birthYear,
    age,
    retireAge: ctx.retireAge,
    targetYear,
    suggested,
    yearsToTarget: mainFund?.startsWith('L 20') ? Number(mainFund.slice(2)) - Number(ctx.today.slice(0, 4)) : null,
    ageAtFundDate: birthYear !== null && mainFund?.startsWith('L 20') ? Number(mainFund.slice(2)) - birthYear : null,
    lFunds,
    asOf: latestTable?.asOf ?? null,
  };

  // ---- vs the fund itself and the core funds (latest TSP table) ----
  const vsFunds = latestTable
    ? Object.entries(latestTable.rows)
        .sort((a, b) => sortFunds(a[0], b[0]))
        .map(([fund, r]: [string, TspReturnRow]) => ({ fund, ...r, held: current.some((c) => c.fund === fund) }))
    : [];

  // ---- quarterly bars (most recent 24 periods between points) ----
  const periods = points.slice(1).map((p, i) => {
    const a = points[i];
    return { from: a.date, to: p.date, start: a.value, end: p.value, ret: a.value > 0 ? (p.index / a.index - 1) * 100 : null, gain: round2(p.value - a.value - flowsIn(a.date, p.date)) };
  });

  // ---- statements & checks ----
  const beneficiary = latest?.values.beneficiary ?? null;
  const statementList = sorted.map((s) => ({
    id: s.id,
    key: s.periodEnd,
    date: s.date,
    start: s.start,
    kind: s.values.kind,
    layout: s.values.layout,
    opening: s.values.opening + (s.values.converted ?? 0),
    closing: s.values.closing,
    gain: s.values.gain,
    contributions: s.values.contributions,
    prr: s.values.prr,
    fileId: s.fileId,
    checks: s.checks,
  }));
  const quarterEnds: string[] = [];
  if (first && last) {
    for (let y = Number(first.date.slice(0, 4)); y <= Number(last.date.slice(0, 4)); y++) for (const md of ['03-31', '06-30', '09-30', '12-31']) {
      const d = `${y}-${md}`;
      if (d > first.date && d <= last.date) quarterEnds.push(d);
    }
  }
  const missingQuarters = quarterEnds.filter((d) => !pts.has(d));

  // ---- Things to Check ----
  const insights: TspInsight[] = [];
  if (beneficiary === false)
    insights.push({
      key: 'beneficiary',
      severity: 'warn',
      title: 'No beneficiary on file',
      detail:
        'Your statements say no beneficiary is designated. Without one, the TSP pays by law in order: spouse, then children, then parents, then your estate. If that’s what you want, no action is needed; to name someone specific (for example a trust for Chase), designate online in My Account at tsp.gov (uniformed services form TSP-U-3). It takes a few minutes and overrides the default order.',
    });
  if (mainFund?.startsWith('L 20') && suggested && suggested !== mainFund && targetYear !== null)
    insights.push({
      key: 'target',
      severity: 'info',
      title: `${mainFund} vs retiring around ${targetYear}`,
      detail: `${mainFund} is built for someone who starts withdrawing in ${mainFund.slice(2)} — you’d be ${target.ageAtFundDate}. Retiring at ${ctx.retireAge} points to ${suggested}, which keeps more in stocks for longer (1-year ${fmtPct(lFunds.find((f) => f.fund === suggested)?.y1 ?? null)} vs ${fmtPct(lFunds.find((f) => f.fund === mainFund)?.y1 ?? null)}). Switching is a free interfund transfer on tsp.gov; staying put is also reasonable for a balance this size. The retirement age comes from the Merrill Retirement tab.`,
    });
  else if (mainFund?.startsWith('L 20') && suggested === mainFund && targetYear !== null)
    insights.push({ key: 'target', severity: 'good', title: `${mainFund} fits a ${targetYear} retirement`, detail: `Its glide path lines up with retiring at ${ctx.retireAge}.` });
  if (balance > 0 && contributions.lifetime > 0)
    insights.push({
      key: 'growth',
      severity: 'good',
      title: `$${contributions.lifetime.toFixed(2)} in → $${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} today`,
      detail: `Nothing has gone in since ${contributions.last ? contributions.last.slice(0, 4) : 'the 2000s'} — every dollar contributed is now ${contributions.multiple?.toFixed(1)}×. ${returns?.since !== null && returns?.since !== undefined ? `That’s ${returns.since.toFixed(1)}%/yr time-weighted since ${returns.sinceDate?.slice(0, 4)}.` : ''}`,
    });
  if (costs.rate !== null)
    insights.push({
      key: 'cost',
      severity: 'good',
      title: `Costs about $${(costs.perYear ?? 0).toFixed(2)} a year`,
      detail: `${costs.rate.toFixed(3)}% expense ratio (${costs.year}). The same balance would cost about $${costs.compare[3].perYear.toFixed(2)}/yr at ${costs.compare[3].rate.toFixed(2)}%. The TSP is one of the cheapest places this money can sit; rolling it into an IRA only helps if consolidation is worth more to you than the cost.`,
    });
  const daysStale = last ? yearsBetween(last.date, ctx.today) * 365.25 : 0;
  if (last && daysStale > 135)
    insights.push({ key: 'stale', severity: 'warn', title: 'Newest statement is over 4 months old', detail: `Latest in Drive ends ${last.date}. Download newer ones from My Account at tsp.gov (Statements).` });
  const recentMissing = missingQuarters.filter((d) => yearsBetween(d, ctx.today) <= 2);
  if (recentMissing.length)
    insights.push({ key: 'gap', severity: 'info', title: `${recentMissing.length} recent quarter${recentMissing.length > 1 ? 's' : ''} not in Drive`, detail: `No statement covers ${recentMissing.join(', ')} — returns bridge the gap from the neighboring statements.` });
  const moveIn = [...transfers].reverse().find((t) => t.amount > 0 && (!election || election[t.fund])) ?? null;
  if (inferred)
    insights.push({
      key: 'inferred',
      severity: 'info',
      title: `A ${inferred.from.slice(0, 4)} quarter is missing from Drive`,
      detail: `No statement covers ${inferred.from} → ${inferred.to} (a file for it may be a copy of another quarter). Your lifetime contributions ($${contributions.lifetime.toFixed(2)}) are $${inferred.amount.toFixed(2)} more than the statements list, so that amount is treated as money put in during that stretch (not as gain).`,
    });
  if (mismatch)
    insights.push({
      key: 'election',
      severity: 'info',
      title: 'History: new-money election vs your actual funds',
      detail: `From ${mismatch.from.slice(0, 4)} to ${mismatch.to.slice(0, 4)} your contribution election was ${Object.keys(election ?? {}).join(', ') || 'an L fund'} while the money itself stayed in ${eras[0]?.mix.map((m) => m.fund).join(' / ') ?? 'the C and S funds'} — an election only steers new money. ${moveIn ? `You moved it all into ${moveIn.fund} on ${moveIn.date} with an interfund transfer.` : ''}`,
    });
  const switchCheck = (() => {
    // The interfund move out of C/S: what staying 50/50 would have done since (TSP's yearly C and S returns).
    const move = moveIn;
    if (!move || !whatIf) return null;
    const y = Number(move.date.slice(0, 4));
    const cs = whatIf.lines.find((l) => l.fund === 'C/S 50/50');
    const lf = whatIf.lines.find((l) => l.fund === move.fund);
    if (!cs || !lf) return null;
    const base = at(`${y - 1}-12-31`)?.value;
    const csStart = cs.values.find((v) => v.year === y - 1)?.value ?? (y - 1 < whatIf.years[0] ? whatIf.start : null);
    const lfStart = lf.values.find((v) => v.year === y - 1)?.value ?? (y - 1 < whatIf.years[0] ? whatIf.start : null);
    if (!base || !csStart || !lfStart) return null;
    const csEnd = (cs.end / csStart) * base;
    const lfEnd = (lf.end / lfStart) * base;
    return { year: y, fund: move.fund, stayed: round2(csEnd), moved: round2(lfEnd), diff: round2(lfEnd - csEnd) };
  })();
  if (switchCheck)
    insights.push({
      key: 'switch',
      severity: 'info',
      title: `The ${switchCheck.year} move to ${switchCheck.fund}: ${switchCheck.diff >= 0 ? '+' : '−'}$${Math.abs(switchCheck.diff).toFixed(0)} so far`,
      detail: `Staying 50/50 in C and S from the start of ${switchCheck.year} would be about $${switchCheck.stayed.toLocaleString('en-US', { maximumFractionDigits: 0 })} now vs $${switchCheck.moved.toLocaleString('en-US', { maximumFractionDigits: 0 })} in ${switchCheck.fund} (TSP’s yearly fund returns; ignores timing within the year). ${switchCheck.fund} carries bonds and international stocks — less swing in a bad year like 2022.`,
    });

  return {
    asOf,
    balance,
    latest: latest
      ? {
          date: latest.date,
          kind: latest.values.kind,
          gain: latest.values.gain,
          prr: latest.values.prr,
          opening: latest.values.opening + (latest.values.converted ?? 0),
          fileId: latest.fileId,
        }
      : null,
    current: current.map((f) => ({ fund: f.fund, value: f.end, price: f.price, shares: f.shares, pct: balance ? round2((f.end / balance) * 100) : 0 })),
    election,
    beneficiary,
    returns,
    points: points.map((p) => ({ date: p.date, value: p.value, index: round2(p.index * 10000) / 10000, funds: p.funds })),
    periods,
    years,
    eras,
    transfers,
    navs,
    contributions,
    costs,
    whatIf,
    target,
    vsFunds,
    vsFundsAsOf: latestTable?.asOf ?? null,
    personalPrinted: latestTable?.personal ?? null,
    missingQuarters,
    uncovered,
    inferred,
    insights,
    statements: statementList,
  };
}

export type TspSummary = ReturnType<typeof summarizeTsp>;

/** The L fund closest to the retirement year (L funds come in 5-year steps; L Income once past). */
function ctxTarget(ctx: TspContext): string | null {
  if (!ctx.birthDate) return null;
  const year = Number(ctx.birthDate.slice(0, 4)) + ctx.retireAge;
  if (year <= Number(ctx.today.slice(0, 4))) return 'L Income';
  const step = Math.round(year / 5) * 5;
  return `L ${Math.max(2030, Math.min(2075, step))}`;
}

function fmtPct(x: number | null): string {
  return x === null ? '—' : `${x.toFixed(1)}%`;
}
