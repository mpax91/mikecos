import type { Env } from '../types';

/** Post Grades A–F (Mike, 2026-10-14) — every Facebook post, Instagram post,
 * Substack post and combined story gets a letter grade. Rule-based, no AI.
 *
 * How a grade is made:
 *  1. Age-matched: a young post's numbers are projected to where a typical
 *     post ends up, using how past posts grew (24h / 3d / 7d snapshots vs
 *     their final numbers; Substack: day-7 opens vs all opens). Until a post
 *     is `matureHours` old its grade is PROVISIONAL and can move; under
 *     `minAgeHours` it's "Too Early".
 *  2. Rolling baseline: the same platform's posts from the `baselineDays`
 *     before it, recent ones weighted more (half-life `halfLifeDays`).
 *     Medians/percentiles, never averages, so one viral post doesn't sink
 *     everything after it.
 *  3. Weighted signals: each metric → weighted percentile vs the baseline;
 *     composite = weighted mean (weights editable in Settings). Inverted
 *     metrics (unfollows, unsubscribes) count against.
 *  4. Letter = where the composite ranks among the baseline posts' own
 *     composites: A top 10% · B 70–90th · C 35–70th · D 15–35th · F below.
 *  5. Stories: weighted mean of the parts' composites (platform weights),
 *     ranked the same way among earlier stories.
 *  Each grade carries its drivers + one "why" (best / worst signal) and a
 *  trend vs the last recorded grade (bee_grade_history, written hourly). */

export type Letter = 'A' | 'B' | 'C' | 'D' | 'F';
export type GradeKind = 'fb' | 'ig' | 'substack';

export interface MetricDef {
  key: string;
  label: string;
  weight: number;
  invert?: boolean;
}
export interface GradeConfig {
  baselineDays: number;
  halfLifeDays: number;
  minAgeHours: number;
  matureHours: { social: number; substack: number };
  cutoffs: { A: number; B: number; C: number; D: number };
  weights: Record<GradeKind, Record<string, number>>;
  storyWeights: { fb: number; ig: number; substack: number };
}

export const METRIC_LABELS: Record<GradeKind, Record<string, string>> = {
  fb: { views: 'Views', likes: 'Reactions', comments: 'Comments', shares: 'Shares', engagement: 'Engagement Rate', follows: 'Net Follows', unfollows: 'Unfollows' },
  ig: { views: 'Views', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', engagement: 'Engagement Rate', follows: 'New Followers' },
  substack: {
    openRate: 'Open Rate',
    forwards: 'Opens per Reader',
    clickRate: 'Click Rate',
    engagement: 'Likes, Comments & Restacks',
    views: 'Web Views',
    signups: 'Free Signups',
    paid: 'Paid Conversions',
    unsubs: 'Unsubscribes',
  },
};
const INVERTED = new Set(['unfollows', 'unsubs']);
/** Rates aren't projected — they're roughly age-stable. */
const RATE_METRICS = new Set(['engagement', 'forwards', 'openRate', 'clickRate', 'unsubs']);

export const DEFAULT_GRADE_CONFIG: GradeConfig = {
  baselineDays: 90,
  halfLifeDays: 45,
  minAgeHours: 3,
  matureHours: { social: 72, substack: 168 },
  cutoffs: { A: 90, B: 70, C: 35, D: 15 },
  weights: {
    fb: { views: 20, likes: 15, comments: 15, shares: 20, engagement: 10, follows: 15, unfollows: 5 },
    ig: { views: 20, likes: 15, comments: 15, shares: 15, saves: 5, engagement: 10, follows: 15 },
    substack: { openRate: 20, forwards: 10, clickRate: 10, engagement: 15, views: 10, signups: 10, paid: 20, unsubs: 10 },
  },
  storyWeights: { fb: 40, ig: 35, substack: 25 },
};

const DAY = 86400000;
const HOUR = 3600000;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Merge a stored/posted config over the defaults, clamping every number. */
export function cleanGradeConfig(raw: unknown): GradeConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<GradeConfig>;
  const d = DEFAULT_GRADE_CONFIG;
  const cut = { ...d.cutoffs, ...(r.cutoffs ?? {}) };
  const cutoffs = { A: num(cut.A, 1, 99, d.cutoffs.A), B: num(cut.B, 1, 99, d.cutoffs.B), C: num(cut.C, 1, 99, d.cutoffs.C), D: num(cut.D, 0, 99, d.cutoffs.D) };
  if (!(cutoffs.A > cutoffs.B && cutoffs.B > cutoffs.C && cutoffs.C > cutoffs.D)) throw new Error('Grade cutoffs must go down from A to D (e.g. 90 / 70 / 35 / 15).');
  const weights = {} as GradeConfig['weights'];
  for (const k of ['fb', 'ig', 'substack'] as const) {
    weights[k] = {};
    for (const m of Object.keys(d.weights[k])) weights[k][m] = num(r.weights?.[k]?.[m], 0, 100, d.weights[k][m]);
    if (!Object.values(weights[k]).some((w) => w > 0)) throw new Error(`At least one ${k === 'fb' ? 'Facebook' : k === 'ig' ? 'Instagram' : 'Substack'} weight must be above 0.`);
  }
  const sw = { ...d.storyWeights, ...(r.storyWeights ?? {}) };
  const storyWeights = { fb: num(sw.fb, 0, 100, d.storyWeights.fb), ig: num(sw.ig, 0, 100, d.storyWeights.ig), substack: num(sw.substack, 0, 100, d.storyWeights.substack) };
  if (!(storyWeights.fb + storyWeights.ig + storyWeights.substack > 0)) throw new Error('At least one story platform weight must be above 0.');
  return {
    baselineDays: Math.round(num(r.baselineDays, 14, 730, d.baselineDays)),
    halfLifeDays: Math.round(num(r.halfLifeDays, 7, 365, d.halfLifeDays)),
    minAgeHours: num(r.minAgeHours, 0, 48, d.minAgeHours),
    matureHours: { social: num(r.matureHours?.social, 6, 720, d.matureHours.social), substack: num(r.matureHours?.substack, 6, 720, d.matureHours.substack) },
    cutoffs,
    weights,
    storyWeights,
  };
}

export async function loadGradeConfig(env: Env): Promise<{ config: GradeConfig; custom: boolean }> {
  const row = await env.DB.prepare('SELECT config_json FROM bee_grade_settings WHERE id = 1').first<{ config_json: string | null }>();
  if (!row?.config_json) return { config: DEFAULT_GRADE_CONFIG, custom: false };
  try {
    return { config: cleanGradeConfig(JSON.parse(row.config_json)), custom: true };
  } catch {
    return { config: DEFAULT_GRADE_CONFIG, custom: false };
  }
}
export async function saveGradeConfig(env: Env, raw: unknown | null) {
  const config = raw == null ? null : cleanGradeConfig(raw);
  await env.DB.prepare(
    'INSERT INTO bee_grade_settings (id, config_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at',
  )
    .bind(config ? JSON.stringify(config) : null, new Date().toISOString())
    .run();
  return loadGradeConfig(env);
}

// ---------------------------------------------------------------- core math

export interface GradeItem {
  key: string;
  t: number; // published, ms
  ageH: number;
  values: Record<string, number | null>; // already projected where needed
  raw?: Record<string, number | null>; // as reported (for display)
  projected?: boolean;
}
export interface Driver {
  key: string;
  label: string;
  weight: number;
  pct: number; // 0–100, higher = better for the post (inverted metrics flipped)
  value: number | null;
  typical: number | null;
  ratio: number | null;
}
export interface Grade {
  letter: Letter | null;
  score: number | null; // composite 0–100
  rank: number | null; // percentile of the composite among the baseline, 0–100
  provisional: boolean;
  tooEarly: boolean;
  ageHours: number;
  confidence: 'low' | 'medium' | 'high';
  baselineN: number;
  projected: boolean;
  drivers: Driver[];
  best: string | null;
  worst: string | null;
  trend: 'up' | 'down' | 'flat' | null;
  prevLetter: Letter | null;
  history?: { at: string; letter: Letter | null; rank: number | null }[];
  note?: string;
}

/** Weighted percentile: share of baseline weight below x (+ half of ties). */
export function weightedPct(x: number, vals: { v: number; w: number }[]): number {
  let below = 0;
  let tie = 0;
  let tot = 0;
  for (const { v, w } of vals) {
    tot += w;
    if (v < x) below += w;
    else if (v === x) tie += w;
  }
  return tot > 0 ? (below + tie / 2) / tot : 0.5;
}
export function weightedMedian(vals: { v: number; w: number }[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a.v - b.v);
  const tot = s.reduce((n, x) => n + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= tot / 2) return x.v;
  }
  return s[s.length - 1].v;
}

export function letterFor(rank: number, c: GradeConfig['cutoffs']): Letter {
  return rank >= c.A ? 'A' : rank >= c.B ? 'B' : rank >= c.C ? 'C' : rank >= c.D ? 'D' : 'F';
}

const MIN_BASE = 15;
const MIN_METRIC_VALUES = 5;

/** The posts an item is judged against: same series, published before it,
 * within the window and old enough to be settled. Falls back to the 30 most
 * recent earlier settled posts, then (cold start) the first 60. */
export function baselineFor<T extends { key: string; t: number; ageH: number }>(item: T, sorted: T[], cfg: GradeConfig, matureH: number): T[] {
  const settled = sorted.filter((b) => b.key !== item.key && b.ageH >= matureH);
  const earlier = settled.filter((b) => b.t < item.t);
  const inWindow = earlier.filter((b) => b.t >= item.t - cfg.baselineDays * DAY);
  if (inWindow.length >= MIN_BASE) return inWindow;
  const last30 = earlier.slice(-30);
  if (last30.length >= MIN_BASE) return last30;
  return settled.slice(0, 60);
}

const fmtRatio = (r: number) => (r >= 10 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`);

function whyText(d: Driver, good: boolean): string {
  if (d.key === 'unfollows') return good ? 'Few unfollows' : 'Unfollows spiked';
  if (d.key === 'unsubs') return good ? 'Few unsubscribes' : 'Unsubscribes spiked';
  if (d.key === 'paid' && good && (d.value ?? 0) > 0) return `${Math.round(d.value ?? 0)} paid conversion${Math.round(d.value ?? 0) === 1 ? '' : 's'}`;
  if (d.ratio != null && d.typical) {
    if (good && d.ratio >= 1.3) return `${d.label} ${fmtRatio(d.ratio)} typical`;
    if (!good && d.ratio <= 0.75) return `${d.label} ${fmtRatio(d.ratio)} typical`;
  }
  return good ? `${d.label} top ${Math.max(1, Math.round(100 - d.pct))}%` : `${d.label} bottom ${Math.max(1, Math.round(d.pct))}%`;
}

/** Stage 1: weighted-percentile composite for every item. */
export function composites(items: GradeItem[], defs: MetricDef[], cfg: GradeConfig, matureH: number) {
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const out = new Map<string, { score: number | null; drivers: Driver[]; baseline: GradeItem[] }>();
  for (const it of sorted) {
    const base = baselineFor(it, sorted, cfg, matureH);
    const wOf = (b: GradeItem) => Math.pow(0.5, Math.max(0, it.t - b.t) / (cfg.halfLifeDays * DAY));
    const drivers: Driver[] = [];
    for (const def of defs) {
      if (def.weight <= 0) continue;
      const v = it.values[def.key];
      if (v == null || !Number.isFinite(v)) continue;
      const vals = base.map((b) => ({ v: b.values[def.key], w: wOf(b) })).filter((x): x is { v: number; w: number } => x.v != null && Number.isFinite(x.v));
      if (vals.length < MIN_METRIC_VALUES) continue;
      let pct = weightedPct(v, vals);
      if (def.invert) pct = 1 - pct;
      const typical = weightedMedian(vals);
      drivers.push({
        key: def.key,
        label: def.label,
        weight: def.weight,
        pct: Math.round(pct * 1000) / 10,
        value: it.raw?.[def.key] ?? v,
        typical,
        ratio: typical && typical > 0 ? v / typical : null,
      });
    }
    const wsum = drivers.reduce((n, d) => n + d.weight, 0);
    const score = wsum > 0 ? Math.round((drivers.reduce((n, d) => n + d.pct * d.weight, 0) / wsum) * 10) / 10 : null;
    out.set(it.key, { score, drivers, baseline: base });
  }
  return out;
}

/** Stage 2: rank each composite among its baseline's composites → letter. */
export function rankAndGrade(
  items: { key: string; t: number; ageH: number; score: number | null }[],
  cfg: GradeConfig,
  matureH: number,
): Map<string, { rank: number | null; letter: Letter | null; baselineN: number; provisional: boolean; tooEarly: boolean; confidence: Grade['confidence'] }> {
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const out = new Map<string, { rank: number | null; letter: Letter | null; baselineN: number; provisional: boolean; tooEarly: boolean; confidence: Grade['confidence'] }>();
  for (const it of sorted) {
    const tooEarly = it.ageH < cfg.minAgeHours;
    const provisional = it.ageH < matureH;
    const base = baselineFor(it, sorted, cfg, matureH).filter((b) => b.score != null);
    const wOf = (b: { t: number }) => Math.pow(0.5, Math.max(0, it.t - b.t) / (cfg.halfLifeDays * DAY));
    let rank: number | null = null;
    if (it.score != null)
      rank =
        base.length >= MIN_METRIC_VALUES
          ? Math.round(
              weightedPct(
                it.score,
                base.map((b) => ({ v: b.score as number, w: wOf(b) })),
              ) * 1000,
            ) / 10
          : it.score;
    const letter = rank == null || tooEarly ? null : letterFor(rank, cfg.cutoffs);
    const frac = it.ageH / matureH;
    const confidence: Grade['confidence'] = base.length < MIN_BASE || frac < 0.34 ? 'low' : frac < 1 ? 'medium' : 'high';
    out.set(it.key, { rank, letter, baselineN: base.length, provisional, tooEarly, confidence });
  }
  return out;
}

function buildGrades(items: GradeItem[], defs: MetricDef[], cfg: GradeConfig, matureH: number): Map<string, Grade> {
  const comp = composites(items, defs, cfg, matureH);
  const ranked = rankAndGrade(
    items.map((i) => ({ key: i.key, t: i.t, ageH: i.ageH, score: comp.get(i.key)?.score ?? null })),
    cfg,
    matureH,
  );
  const out = new Map<string, Grade>();
  for (const it of items) {
    const c = comp.get(it.key)!;
    const r = ranked.get(it.key)!;
    const contrib = (d: Driver) => (d.pct - 50) * d.weight;
    // Ties (several signals maxed out) go to the most striking multiple.
    const goods = c.drivers.filter((d) => d.pct >= 60).sort((a, b) => contrib(b) - contrib(a) || (b.ratio ?? 0) - (a.ratio ?? 0));
    const bads = c.drivers.filter((d) => d.pct <= 40).sort((a, b) => contrib(a) - contrib(b) || (a.ratio ?? 9) - (b.ratio ?? 9));
    out.set(it.key, {
      letter: r.letter,
      score: c.score,
      rank: r.rank,
      provisional: r.provisional,
      tooEarly: r.tooEarly,
      ageHours: Math.round(it.ageH * 10) / 10,
      confidence: r.confidence,
      baselineN: r.baselineN,
      projected: !!it.projected,
      drivers: c.drivers.sort((a, b) => b.weight - a.weight),
      best: goods[0] ? whyText(goods[0], true) : null,
      worst: bads[0] ? whyText(bads[0], false) : null,
      trend: null,
      prevLetter: null,
    });
  }
  return out;
}

// ------------------------------------------------------------ growth curves

/** Fraction of the final number a post has typically reached at `ageH`.
 * Points from snapshots: (24, f24), (72, f3d), (168, f7d), final = 1 at
 * 28 days. Under 24h the curve is concave (social posts are front-loaded). */
export function growthAt(ageH: number, pts: { h: number; f: number }[]): number {
  if (ageH <= 0) return 0.05;
  const curve = [...pts].sort((a, b) => a.h - b.h);
  const first = curve[0];
  if (ageH <= first.h) return Math.max(0.05, first.f * Math.sqrt(ageH / first.h));
  const all = [...curve, { h: 28 * 24, f: 1 }];
  for (let i = 1; i < all.length; i++) {
    if (ageH <= all[i].h) {
      const a = all[i - 1];
      const b = all[i];
      return a.f + ((b.f - a.f) * (ageH - a.h)) / (b.h - a.h);
    }
  }
  return 1;
}
const DEFAULT_SOCIAL_CURVE = [
  { h: 24, f: 0.75 },
  { h: 72, f: 0.92 },
  { h: 168, f: 0.98 },
];
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// -------------------------------------------------------------- data → grades

interface MetaRow {
  platform: 'fb' | 'ig';
  id: string;
  created_at: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  views: number | null;
}
interface SnapRow {
  platform: string;
  id: string;
  bucket: string;
  age_hours: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  views: number | null;
}
interface SubRow {
  post_date: string;
  title: string;
  sent: number | null;
  delivered: number | null;
  opens: number | null;
  opened: number | null;
  opens_day7: number | null;
  clicks: number | null;
  clicked: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  restacks: number | null;
  signups: number | null;
  subscribes: number | null;
  upgrades: number | null;
  unsubscribes: number | null;
  export_date: string | null;
  updated_at: string;
}

const easternDate = (iso: string | number) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const nextDate = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + DAY).toISOString().slice(0, 10);

export interface AllGrades {
  config: GradeConfig;
  posts: Map<string, Grade>; // `fb:<id>` | `ig:<id>` | `substack:<post_date>`
  composites: Map<string, { t: number; ageH: number; score: number | null; provisional: boolean }>;
  curves: Record<'fb' | 'ig', Record<string, { h: number; f: number }[]>>;
}

/** Grade every FB, IG and Substack post. `nowMs` is injectable for tests. */
export async function gradeAllPosts(env: Env, nowMs = Date.now()): Promise<AllGrades> {
  const { config: cfg } = await loadGradeConfig(env);
  const db = env.DB;
  const [{ results: meta }, { results: snaps }, { results: days }, { results: subs }] = await Promise.all([
    db.prepare('SELECT platform, id, created_at, likes, comments, shares, saves, views FROM bee_meta_posts').all<MetaRow>(),
    db.prepare('SELECT platform, id, bucket, age_hours, likes, comments, shares, saves, views FROM bee_meta_snaps').all<SnapRow>(),
    db
      .prepare("SELECT platform, date, metric, value FROM bee_meta_days WHERE metric IN ('page_daily_follows_unique', 'page_daily_unfollows_unique', 'follower_count')")
      .all<{ platform: string; date: string; metric: string; value: number }>(),
    db
      .prepare(
        'SELECT p.post_date, p.title, p.sent, p.delivered, p.opens, p.opened, p.opens_day7, p.clicks, p.clicked, p.views, p.likes, p.comments, p.shares, p.restacks, p.signups, p.subscribes, p.upgrades, p.unsubscribes, p.updated_at, f.export_date FROM bee_posts p LEFT JOIN bee_files f ON f.file_id = p.file_id',
      )
      .all<SubRow>(),
  ]);

  const posts = new Map<string, Grade>();
  const compOut = new Map<string, { t: number; ageH: number; score: number | null; provisional: boolean }>();
  const curves = { fb: {}, ig: {} } as AllGrades['curves'];

  // ---- follows per Eastern day
  const dayVal = new Map<string, number>();
  for (const d of days ?? []) dayVal.set(`${d.platform}|${d.metric}|${d.date}`, d.value);
  /** Posts go out at 3pm: credit the post with its own day and the next
   * (averaged), since follows after 3pm and the following morning are its. */
  const perPostDay = (plat: string, metric: string, created: string, ageH: number): number | null => {
    if (ageH < 24) return null;
    const d0 = easternDate(created);
    const vals = [dayVal.get(`${plat}|${metric}|${d0}`), dayVal.get(`${plat}|${metric}|${nextDate(d0)}`)].filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  // ---- Facebook + Instagram
  const snapBy = new Map<string, SnapRow[]>();
  for (const s of snaps ?? []) snapBy.set(`${s.platform}|${s.id}`, [...(snapBy.get(`${s.platform}|${s.id}`) ?? []), s]);
  const SOCIAL_COUNTS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;
  for (const plat of ['fb', 'ig'] as const) {
    const rows = (meta ?? []).filter((m) => m.platform === plat);
    // Growth curve per metric from settled posts (≥ 28 days) with snapshots.
    const settled = rows.filter((r) => nowMs - new Date(r.created_at).getTime() >= 28 * DAY);
    for (const m of SOCIAL_COUNTS) {
      const pts: { h: number; f: number }[] = [];
      for (const [bucket, h] of [
        ['24h', 24],
        ['3d', 72],
        ['7d', 168],
      ] as const) {
        const fr: number[] = [];
        for (const r of settled) {
          const s = snapBy.get(`${plat}|${r.id}`)?.find((x) => x.bucket === bucket);
          const fin = r[m];
          const v = s?.[m];
          if (s && v != null && fin != null && fin > 0) fr.push(Math.min(1, v / fin));
        }
        const md = fr.length >= 8 ? median(fr) : null;
        pts.push({ h, f: md ?? DEFAULT_SOCIAL_CURVE.find((p) => p.h === h)!.f });
      }
      // Keep it monotonic.
      for (let i = 1; i < pts.length; i++) pts[i].f = Math.max(pts[i].f, pts[i - 1].f);
      curves[plat][m] = pts;
    }
    const items: GradeItem[] = rows.map((r) => {
      const t = new Date(r.created_at).getTime();
      const ageH = Math.max(0, (nowMs - t) / HOUR);
      const raw: Record<string, number | null> = {};
      const values: Record<string, number | null> = {};
      let projected = false;
      for (const m of SOCIAL_COUNTS) {
        if (m === 'saves' && plat === 'fb') continue;
        raw[m] = r[m];
        const g = ageH < 28 * 24 ? growthAt(ageH, curves[plat][m]) : 1;
        if (r[m] != null && g < 0.999) projected = true;
        values[m] = r[m] == null ? null : r[m]! / g;
      }
      const eng = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (plat === 'ig' ? (r.saves ?? 0) : 0);
      values.engagement = r.views && r.views > 0 ? eng / r.views : null;
      raw.engagement = values.engagement;
      if (plat === 'fb') {
        const f = perPostDay('fb', 'page_daily_follows_unique', r.created_at, ageH);
        const u = perPostDay('fb', 'page_daily_unfollows_unique', r.created_at, ageH);
        values.follows = f == null ? null : f - (u ?? 0);
        values.unfollows = u;
      } else {
        values.follows = perPostDay('ig', 'follower_count', r.created_at, ageH);
      }
      raw.follows = values.follows;
      if (plat === 'fb') raw.unfollows = values.unfollows;
      return { key: `${plat}:${r.id}`, t, ageH, values, raw, projected };
    });
    const defs: MetricDef[] = Object.entries(cfg.weights[plat]).map(([key, weight]) => ({ key, weight, label: METRIC_LABELS[plat][key] ?? key, invert: INVERTED.has(key) }));
    const g = buildGrades(items, defs, cfg, cfg.matureHours.social);
    for (const it of items) {
      const gr = g.get(it.key)!;
      posts.set(it.key, gr);
      compOut.set(it.key, { t: it.t, ageH: it.ageH, score: gr.score, provisional: gr.provisional });
    }
  }

  // ---- Substack (emailed posts only; numbers are as of the export)
  const emailed = (subs ?? []).filter((s) => (s.delivered ?? 0) >= 10);
  const settledSubs = emailed.filter((s) => s.opens_day7 != null && (s.opens ?? 0) > 0);
  const r7 = median(settledSubs.map((s) => Math.min(1, (s.opens_day7 ?? 0) / (s.opens ?? 1)))) ?? 0.95;
  const subItems: GradeItem[] = emailed.map((s) => {
    const t = new Date(s.post_date).getTime();
    const asOf = s.export_date ? new Date(`${s.export_date}T23:59:00-04:00`).getTime() : new Date(s.updated_at).getTime();
    const ageH = Math.max(0, (Math.min(asOf, nowMs) - t) / HOUR);
    // Growth by age: day 7 ≈ r7 of all opens; younger = concave below that.
    const g = ageH >= 28 * 24 ? 1 : ageH >= 168 ? r7 + ((1 - r7) * (ageH - 168)) / (28 * 24 - 168) : Math.max(0.2, r7 * Math.sqrt(ageH / 168));
    const proj = (v: number | null) => (v == null ? null : v / g);
    const delivered = s.delivered ?? 0;
    const opened = proj(s.opened ?? 0) ?? 0;
    const values: Record<string, number | null> = {
      openRate: delivered ? Math.min(1, opened / delivered) : null,
      forwards: (s.opened ?? 0) > 0 ? (s.opens ?? 0) / (s.opened ?? 1) : null,
      clickRate: delivered ? (proj(s.clicked ?? s.clicks ?? 0) ?? 0) / delivered : null,
      engagement: proj((s.likes ?? 0) + (s.comments ?? 0) + (s.restacks ?? 0) + (s.shares ?? 0)),
      views: proj(s.views ?? 0),
      signups: proj(s.signups ?? 0),
      paid: proj((s.subscribes ?? 0) + (s.upgrades ?? 0)),
      unsubs: delivered ? (s.unsubscribes ?? 0) / delivered : null,
    };
    const raw: Record<string, number | null> = {
      openRate: delivered ? (s.opened ?? 0) / delivered : null,
      forwards: values.forwards,
      clickRate: delivered ? (s.clicked ?? s.clicks ?? 0) / delivered : null,
      engagement: (s.likes ?? 0) + (s.comments ?? 0) + (s.restacks ?? 0) + (s.shares ?? 0),
      views: s.views ?? 0,
      signups: s.signups ?? 0,
      paid: (s.subscribes ?? 0) + (s.upgrades ?? 0),
      unsubs: values.unsubs,
    };
    return { key: `substack:${s.post_date}`, t, ageH, values, raw, projected: g < 0.999 };
  });
  const subDefs: MetricDef[] = Object.entries(cfg.weights.substack).map(([key, weight]) => ({ key, weight, label: METRIC_LABELS.substack[key] ?? key, invert: INVERTED.has(key) }));
  const sg = buildGrades(subItems, subDefs, cfg, cfg.matureHours.substack);
  for (const it of subItems) {
    const gr = sg.get(it.key)!;
    if (it.ageH < cfg.matureHours.substack) gr.note = 'Numbers are as of the last Substack export — the grade settles once a newer export covers its first week.';
    posts.set(it.key, gr);
    compOut.set(it.key, { t: it.t, ageH: it.ageH, score: gr.score, provisional: gr.provisional });
  }
  for (const s of (subs ?? []).filter((x) => (x.delivered ?? 0) < 10)) {
    const t = new Date(s.post_date).getTime();
    posts.set(`substack:${s.post_date}`, {
      letter: null,
      score: null,
      rank: null,
      provisional: false,
      tooEarly: false,
      ageHours: Math.round((nowMs - t) / HOUR),
      confidence: 'low',
      baselineN: 0,
      projected: false,
      drivers: [],
      best: null,
      worst: null,
      trend: null,
      prevLetter: null,
      note: 'Not emailed — web-only posts aren’t graded.',
    });
  }

  await attachTrends(env, posts, nowMs).catch(() => null);
  return { config: cfg, posts, composites: compOut, curves };
}

/** Story grades: weighted mean of the parts' composites, ranked among the
 * stories before it. Parts = keys like `fb:<id>` / `substack:<post_date>`. */
export function gradeStories(
  stories: { key: string; createdAt: string; partKeys: { platform: 'fb' | 'ig' | 'substack'; key: string }[] }[],
  all: AllGrades,
  nowMs = Date.now(),
  opts: { socialOnly?: boolean } = {},
): Map<string, Grade> {
  const cfg: GradeConfig = opts.socialOnly ? { ...all.config, storyWeights: { ...all.config.storyWeights, substack: 0 } } : all.config;
  if (opts.socialOnly && cfg.storyWeights.fb + cfg.storyWeights.ig <= 0) cfg.storyWeights = { fb: 1, ig: 1, substack: 0 };
  const items = stories.map((s) => {
    const t = new Date(s.createdAt).getTime();
    let wsum = 0;
    let acc = 0;
    let provisional = false;
    const drivers: Driver[] = [];
    for (const p of s.partKeys) {
      const c = all.composites.get(p.key);
      const g = all.posts.get(p.key);
      const w = cfg.storyWeights[p.platform];
      if (!c || c.score == null || w <= 0) continue;
      wsum += w;
      acc += c.score * w;
      provisional = provisional || c.provisional;
      drivers.push({
        key: p.platform,
        label: p.platform === 'fb' ? 'Facebook' : p.platform === 'ig' ? 'Instagram' : 'Substack',
        weight: w,
        pct: c.score,
        value: g?.rank ?? null,
        typical: null,
        ratio: null,
      });
    }
    return { key: s.key, t, ageH: Math.max(0, (nowMs - t) / HOUR), score: wsum > 0 ? Math.round((acc / wsum) * 10) / 10 : null, provisional, drivers };
  });
  // Stories settle with the social posts.
  const ranked = rankAndGrade(items, cfg, cfg.matureHours.social);
  const out = new Map<string, Grade>();
  for (const it of items) {
    const r = ranked.get(it.key)!;
    const best = [...it.drivers].sort((a, b) => b.pct - a.pct)[0];
    const worst = [...it.drivers].sort((a, b) => a.pct - b.pct)[0];
    const subPart = stories.find((s) => s.key === it.key)?.partKeys.find((p) => p.platform === 'substack');
    const paid = subPart ? (all.posts.get(subPart.key)?.drivers.find((d) => d.key === 'paid')?.value ?? 0) : 0;
    out.set(it.key, {
      letter: r.letter,
      score: it.score,
      rank: r.rank,
      provisional: it.provisional || r.provisional,
      tooEarly: r.tooEarly,
      ageHours: Math.round(it.ageH * 10) / 10,
      confidence: r.confidence,
      baselineN: r.baselineN,
      projected: false,
      drivers: it.drivers,
      best: paid && paid > 0 ? `${Math.round(paid)} paid conversion${Math.round(paid) === 1 ? '' : 's'}` : best && best.pct >= 60 && it.drivers.length > 1 ? `Strongest on ${best.label}` : null,
      worst: worst && worst.pct <= 40 && it.drivers.length > 1 ? `Weakest on ${worst.label}` : null,
      trend: null,
      prevLetter: null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ history

const HISTORY_DAYS = 14;
const RECORD_EVERY_H = 3;

/** Trend: compare with the newest recorded grade at least 2 hours older. */
async function attachTrends(env: Env, posts: Map<string, Grade>, nowMs: number) {
  const since = new Date(nowMs - HISTORY_DAYS * DAY).toISOString();
  const { results } = await env.DB.prepare('SELECT kind, id, at, letter, rank FROM bee_grade_history WHERE at >= ? ORDER BY at')
    .bind(since)
    .all<{ kind: string; id: string; at: string; letter: Letter | null; rank: number | null }>();
  const by = new Map<string, { at: string; letter: Letter | null; rank: number | null }[]>();
  for (const h of results ?? []) {
    const k = `${h.kind}:${h.id}`;
    by.set(k, [...(by.get(k) ?? []), { at: h.at, letter: h.letter, rank: h.rank }]);
  }
  const cutoff = new Date(nowMs - 2 * HOUR).toISOString();
  for (const [k, g] of posts) {
    const hist = by.get(k);
    if (!hist?.length) continue;
    g.history = hist.slice(-12);
    const prev = [...hist].reverse().find((h) => h.at <= cutoff);
    if (!prev || prev.rank == null || g.rank == null) continue;
    g.prevLetter = prev.letter;
    const diff = g.rank - prev.rank;
    g.trend = diff >= 5 ? 'up' : diff <= -5 ? 'down' : 'flat';
  }
}

/** Hourly (after the Meta refresh): store the grade of every post still
 * inside its first 14 days — when the letter changed or every 3 hours. */
export async function recordGradeHistory(env: Env, nowMs = Date.now()) {
  const all = await gradeAllPosts(env, nowMs);
  const since = new Date(nowMs - HISTORY_DAYS * DAY).toISOString();
  const { results } = await env.DB.prepare('SELECT kind, id, MAX(at) AS at, letter FROM bee_grade_history WHERE at >= ? GROUP BY kind, id')
    .bind(since)
    .all<{ kind: string; id: string; at: string; letter: string | null }>();
  const last = new Map((results ?? []).map((r) => [`${r.kind}:${r.id}`, r]));
  const at = new Date(nowMs).toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const [k, g] of all.posts) {
    if (g.ageHours > HISTORY_DAYS * 24 || g.rank == null) continue;
    const prev = last.get(k);
    const stale = !prev || nowMs - new Date(prev.at).getTime() >= RECORD_EVERY_H * HOUR;
    if (!stale && prev?.letter === g.letter) continue;
    const i = k.indexOf(':');
    stmts.push(
      env.DB.prepare('INSERT OR REPLACE INTO bee_grade_history (kind, id, at, letter, rank, score) VALUES (?, ?, ?, ?, ?, ?)').bind(k.slice(0, i), k.slice(i + 1), at, g.letter, g.rank, g.score),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.prepare('DELETE FROM bee_grade_history WHERE at < ?')
    .bind(new Date(nowMs - 60 * DAY).toISOString())
    .run();
  return { recorded: stmts.length };
}

/** Counts per letter for a set of grades. */
export function gradeMix(grades: (Grade | null | undefined)[]) {
  const mix: Record<Letter | 'pending', number> = { A: 0, B: 0, C: 0, D: 0, F: 0, pending: 0 };
  for (const g of grades) {
    if (!g) continue;
    if (g.letter) mix[g.letter]++;
    else if (g.tooEarly) mix.pending++;
  }
  return mix;
}
