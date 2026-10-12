import type { Env } from '../types';
import { decryptField, encryptField } from '../cryptoField';
import { loadKeys } from './bing';

/** Microsoft Clarity for the Bedford Bee (2026-10-11). Token from Clarity →
 * Settings → Data Export → Generate new API token (project admin), pasted
 * in Settings → Bedford Bee (encrypted). The API only returns the last
 * 1–3 days and allows 10 calls a day, so MikeOS takes one 24-hour snapshot
 * nightly (4 calls: site, by URL, by source, by device) and keeps it —
 * history builds from the day it's connected. Recordings and heatmaps stay
 * in Clarity. */

const API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const ENC = 'CLOUD_ACCOUNT_ENC_KEY';
const VIEWS: { view: string; dims: string[] }[] = [
  { view: '', dims: [] },
  { view: 'url', dims: ['URL'] },
  { view: 'source', dims: ['Source'] },
  { view: 'device', dims: ['Device'] },
];
const now = () => new Date().toISOString();
const yesterdayUtc = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

interface Metric {
  metricName: string;
  information: Record<string, unknown>[];
}

async function fetchInsights(token: string, dims: string[], numOfDays = 1): Promise<Metric[]> {
  const qs = new URLSearchParams({ numOfDays: String(numOfDays) });
  dims.forEach((d, i) => qs.set(`dimension${i + 1}`, d));
  const r = await fetch(`${API}?${qs}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (r.status === 429) throw new Error('Clarity’s daily limit (10 calls) is used up — it resets tomorrow.');
  if (r.status === 401 || r.status === 403) throw new Error('Clarity rejected the token — generate a new one in Clarity → Settings → Data Export.');
  if (!r.ok) throw new Error(`Clarity ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as Metric[];
}

/** Saves the token after one test call (counts toward the day's 10). */
export async function saveClarityToken(env: Env, token: string | null): Promise<void> {
  await loadKeys(env);
  if (!token) {
    await env.DB.prepare('UPDATE bee_keys SET clarity_token_enc = NULL, clarity_last_error = NULL, updated_at = ? WHERE id = 1').bind(now()).run();
    return;
  }
  const site = await fetchInsights(token, []);
  await env.DB.prepare('UPDATE bee_keys SET clarity_token_enc = ?, clarity_last_error = NULL, updated_at = ? WHERE id = 1').bind(await encryptField(env, token, ENC), now()).run();
  // That test call is a full site snapshot — keep it.
  await env.DB.prepare('INSERT OR REPLACE INTO bee_clarity_days (date, view, raw_json, fetched_at) VALUES (?, ?, ?, ?)').bind(yesterdayUtc(), '', JSON.stringify(site), now()).run();
}

/** One snapshot per day: skips views already fetched for that day. */
export async function syncClarity(env: Env): Promise<{ date: string; fetched: string[] }> {
  const row = await loadKeys(env);
  if (!row.clarity_token_enc) throw new Error('Clarity isn’t connected.');
  const token = await decryptField(env, row.clarity_token_enc, ENC);
  const date = yesterdayUtc();
  const { results } = await env.DB.prepare('SELECT view FROM bee_clarity_days WHERE date = ?').bind(date).all<{ view: string }>();
  const have = new Set((results ?? []).map((r) => r.view));
  const fetched: string[] = [];
  try {
    for (const v of VIEWS) {
      if (have.has(v.view)) continue;
      const data = await fetchInsights(token, v.dims);
      await env.DB.prepare('INSERT OR REPLACE INTO bee_clarity_days (date, view, raw_json, fetched_at) VALUES (?, ?, ?, ?)').bind(date, v.view, JSON.stringify(data), now()).run();
      fetched.push(v.view || 'site');
    }
    await env.DB.prepare('UPDATE bee_keys SET clarity_last_sync_at = ?, clarity_last_error = NULL WHERE id = 1').bind(now()).run();
  } catch (err) {
    await env.DB.prepare('UPDATE bee_keys SET clarity_last_sync_at = ?, clarity_last_error = ? WHERE id = 1').bind(now(), (err instanceof Error ? err.message : String(err)).slice(0, 500)).run();
    throw err;
  }
  return { date, fetched };
}

export async function claritySyncDue(env: Env, scheduledTime: number): Promise<boolean> {
  const row = await loadKeys(env);
  if (!row.clarity_token_enc) return false;
  // Once a day, after midnight UTC has closed yesterday: the 07:20 slot,
  // or later if yesterday's snapshot is still missing.
  if (new Date(scheduledTime).getUTCHours() < 7) return false;
  const y = new Date(scheduledTime - 86400000).toISOString().slice(0, 10);
  const n = await env.DB.prepare('SELECT COUNT(*) n FROM bee_clarity_days WHERE date = ?').bind(y).first<{ n: number }>();
  return (n?.n ?? 0) < VIEWS.length;
}

// ---- Reading the snapshots -------------------------------------------

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const metricKey = (m: string) => m.replace(/\s+/g, '').toLowerCase();

/** Pulls the numbers we use out of one metric's info row. */
function readRow(metric: string, r: Record<string, unknown>) {
  const k = metricKey(metric);
  const out: Record<string, number> = {};
  const set = (name: string, v: unknown) => {
    const n = num(v);
    if (n !== null) out[name] = n;
  };
  if (k === 'traffic') {
    set('sessions', r.totalSessionCount);
    set('bots', r.totalBotSessionCount);
    set('users', r.distantUserCount ?? r.distinctUserCount);
    set('pagesPerSession', r.PagesPerSessionPercentage ?? r.pagesPerSessionPercentage);
  } else if (k === 'scrolldepth') set('scrollDepth', r.averageScrollDepth ?? r.AverageScrollDepth);
  else if (k === 'engagementtime') {
    set('totalTime', r.totalTime);
    set('activeTime', r.activeTime);
  } else {
    // Dead/Rage/Quickback/Error clicks, Excessive scroll, Script errors:
    // share of sessions with it (%), and how many sessions.
    set(`${k}Pct`, r.sessionsWithMetricPercentage);
    set(`${k}Sessions`, r.sessionsCount ?? r.subTotal);
  }
  return out;
}

const DIM_FIELD: Record<string, string[]> = { url: ['Url', 'URL', 'url'], source: ['Source', 'source'], device: ['Device', 'device'] };

/** One day's view → { key → numbers } ('' key for the site view). */
function parseView(view: string, metrics: Metric[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const m of metrics ?? []) {
    for (const r of m.information ?? []) {
      const key = view ? String(DIM_FIELD[view].map((f) => r[f]).find((x) => x != null) ?? '(unknown)') : '';
      out.set(key, { ...(out.get(key) ?? {}), ...readRow(m.metricName, r) });
    }
  }
  return out;
}

/** GET /api/bee/clarity — Reading Behavior panel on the Website tab. */
export async function clarityDashboard(env: Env, asked: { from: string; to: string } | null = null) {
  const row = await loadKeys(env);
  const connection = { connected: !!row.clarity_token_enc, lastSyncAt: row.clarity_last_sync_at, lastError: row.clarity_last_error };
  const { results } = await env.DB.prepare('SELECT date, view, raw_json FROM bee_clarity_days ORDER BY date').all<{ date: string; view: string; raw_json: string }>();
  const rows = results ?? [];
  if (!rows.length) return { connection, empty: true as const };
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const last = dates[dates.length - 1];
  // Snapshot days inside the asked range (default: the last 28 days).
  const since = asked ? dates.filter((d) => d >= asked.from && d <= asked.to) : dates.filter((d) => d > new Date(new Date(`${last}T12:00:00Z`).getTime() - 28 * 86400000).toISOString().slice(0, 10));

  // Daily site series.
  const daily = rows
    .filter((r) => r.view === '')
    .map((r) => ({ date: r.date, ...(parseView('', JSON.parse(r.raw_json)).get('') ?? {}) }));

  // Sum per key over the last 28 snapshot days (rates weighted by sessions).
  const combine = (view: string) => {
    const acc = new Map<string, { days: number; sessions: number; bots: number; w: Record<string, number> }>();
    for (const r of rows.filter((x) => x.view === view && since.includes(x.date))) {
      for (const [key, v] of parseView(view, JSON.parse(r.raw_json))) {
        const a = acc.get(key) ?? (acc.set(key, { days: 0, sessions: 0, bots: 0, w: {} }), acc.get(key)!);
        const s = v.sessions ?? 0;
        a.days++;
        a.sessions += s;
        a.bots += v.bots ?? 0;
        for (const [f, n] of Object.entries(v)) if (f !== 'sessions' && f !== 'bots') a.w[f] = (a.w[f] ?? 0) + n * Math.max(1, s);
      }
    }
    return [...acc.entries()].map(([key, a]) => {
      const avg = (f: string) => (a.w[f] !== undefined ? a.w[f] / Math.max(1, a.sessions || a.days) : null);
      return {
        key,
        sessions: a.sessions,
        bots: a.bots,
        scrollDepth: avg('scrollDepth'),
        activeTime: avg('activeTime'),
        rageClicks: avg('rageclickcountPct'),
        deadClicks: avg('deadclickcountPct'),
        quickBacks: avg('quickbackclickPct'),
        excessiveScroll: avg('excessivescrollPct'),
        scriptErrors: avg('scripterrorcountPct'),
      };
    });
  };
  const site = combine('')[0] ?? null;
  const pages = combine('url').filter((p) => p.sessions >= 5);
  const frustrated = pages
    .filter((p) => (p.rageClicks ?? 0) + (p.deadClicks ?? 0) >= 5)
    .sort((a, b) => (b.rageClicks ?? 0) + (b.deadClicks ?? 0) - ((a.rageClicks ?? 0) + (a.deadClicks ?? 0)))
    .slice(0, 10);

  return {
    connection,
    empty: false as const,
    range: { from: dates[0], to: last, days: dates.length, windowDays: since.length },
    site,
    daily,
    readDepth: [...pages].filter((p) => p.scrollDepth !== null).sort((a, b) => b.sessions - a.sessions).slice(0, 15),
    frustrated,
    sources: combine('source').sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    devices: combine('device').sort((a, b) => b.sessions - a.sessions),
    projectUrl: 'https://clarity.microsoft.com/projects',
  };
}
