import type { Env } from '../types';

/** Monthly index prices for "are we beating the market?" (migration 0142).
 * Month-end ADJUSTED closes (dividends reinvested = total return) of a few
 * plain index ETFs, used as benchmarks:
 *   SPY  — S&P 500
 *   VTI  — total US stock market      } blended: the account's own
 *   VXUS — total international stocks } stock / bond / cash mix
 *   AGG  — US investment-grade bonds  } in index funds
 *   BIL  — 1–3 month T-bills (cash)   }
 * Pulled from Yahoo Finance's public chart endpoint (no key) at most every
 * 20 hours when a Merrill derive runs; a failed pull keeps what's stored
 * and the dashboard says how fresh it is. Public market data only — nothing
 * personal leaves MikeOS. Can also be loaded by hand: POST
 * /api/statements/market/import {rows:[{symbol, month, adjClose}]}. */

export const BENCHMARK_SYMBOLS = ['SPY', 'VTI', 'VXUS', 'AGG', 'BIL'] as const;
export type BenchSymbol = (typeof BENCHMARK_SYMBOLS)[number];

export interface MarketMonth {
  symbol: string;
  month: string; // YYYY-MM
  adjClose: number;
}

const REFRESH_HOURS = 20;

export async function loadMarket(env: Env): Promise<{ rows: MarketMonth[]; fetchedAt: string | null; error: string | null }> {
  const [rows, state] = await env.DB.batch([
    env.DB.prepare('SELECT symbol, month, adj_close FROM market_monthly ORDER BY symbol, month'),
    env.DB.prepare(`SELECT fetched_at, last_error FROM market_state WHERE id = 'yahoo'`),
  ]);
  const st = (state.results?.[0] ?? null) as { fetched_at: string | null; last_error: string | null } | null;
  return {
    rows: ((rows.results ?? []) as { symbol: string; month: string; adj_close: number }[]).map((r) => ({ symbol: r.symbol, month: r.month, adjClose: r.adj_close })),
    fetchedAt: st?.fetched_at ?? null,
    error: st?.last_error ?? null,
  };
}

async function fetchSymbol(symbol: string): Promise<MarketMonth[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1mo&range=10y&includeAdjustedClose=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MikeOS benchmark fetch)', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const body = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { adjclose?: { adjclose?: (number | null)[] }[] } }[]; error?: { description?: string } | null };
  };
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
  if (!ts.length || ts.length !== adj.length) throw new Error(`${symbol}: ${body.chart?.error?.description ?? 'no data'}`);
  const out = new Map<string, number>();
  ts.forEach((t, i) => {
    const v = adj[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    // Bars are stamped at the month's first trading day; the close is the month's last.
    const d = new Date(t * 1000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.set(month, v);
  });
  return [...out].map(([month, adjClose]) => ({ symbol, month, adjClose }));
}

/** Refreshes the benchmark table when it's older than REFRESH_HOURS (or `force`). */
export async function refreshMarket(env: Env, force = false): Promise<{ fetched: number; error: string | null }> {
  const st = await env.DB.prepare(`SELECT fetched_at FROM market_state WHERE id = 'yahoo'`).first<{ fetched_at: string | null }>();
  if (!force && st?.fetched_at && Date.now() - Date.parse(st.fetched_at) < REFRESH_HOURS * 3600 * 1000) return { fetched: 0, error: null };
  const rows: MarketMonth[] = [];
  const errors: string[] = [];
  for (const sym of BENCHMARK_SYMBOLS) {
    try {
      rows.push(...(await fetchSymbol(sym)));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const now = new Date().toISOString();
  if (rows.length) await storeMarket(env, rows);
  await env.DB.prepare(
    `INSERT INTO market_state (id, fetched_at, last_error) VALUES ('yahoo', ?, ?)
     ON CONFLICT(id) DO UPDATE SET fetched_at = CASE WHEN ? > 0 THEN excluded.fetched_at ELSE market_state.fetched_at END, last_error = excluded.last_error`
  )
    .bind(now, errors.length ? errors.join(' · ').slice(0, 500) : null, rows.length)
    .run();
  return { fetched: rows.length, error: errors.length ? errors.join(' · ') : null };
}

export async function storeMarket(env: Env, rows: MarketMonth[]): Promise<number> {
  const clean = rows.filter((r) => /^[A-Z.]{1,8}$/.test(r.symbol) && /^\d{4}-\d{2}$/.test(r.month) && Number.isFinite(r.adjClose) && r.adjClose > 0);
  for (let i = 0; i < clean.length; i += 80) {
    await env.DB.batch(
      clean.slice(i, i + 80).map((r) =>
        env.DB.prepare('INSERT INTO market_monthly (symbol, month, adj_close) VALUES (?, ?, ?) ON CONFLICT(symbol, month) DO UPDATE SET adj_close = excluded.adj_close').bind(r.symbol, r.month, r.adjClose)
      )
    );
  }
  return clean.length;
}

/** symbol → month → total return for that month (from the previous month-end). */
export function monthlyReturns(rows: MarketMonth[]): Map<string, Map<string, number>> {
  const bySym = new Map<string, MarketMonth[]>();
  for (const r of rows) {
    const list = bySym.get(r.symbol) ?? [];
    list.push(r);
    bySym.set(r.symbol, list);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [sym, list] of bySym) {
    list.sort((a, b) => a.month.localeCompare(b.month));
    const m = new Map<string, number>();
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (nextMonth(prev.month) !== cur.month) continue; // a hole — no return for that month
      m.set(cur.month, cur.adjClose / prev.adjClose - 1);
    }
    out.set(sym, m);
  }
  return out;
}

export function nextMonth(ym: string): string {
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + 1;
  if (m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}
