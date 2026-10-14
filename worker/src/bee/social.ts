import type { Env } from '../types';
import { loadMeta } from './meta';
import { gradeAllPosts, gradeMix } from './grades';

/** GET /api/bee/social — the Social tab (Facebook + Instagram).
 *
 * Mike's priorities (2026-10-11): likes, views, comments and shares are the
 * lifeblood; every post gets a scorecard; day-of-week and content type
 * matter, time of day doesn't (he posts at 3pm ET every day).
 *
 * Rules (no AI):
 *  - Typical = median of the platform's last 60 posts at least 7 days old.
 *  - Each metric → multiple of typical. Score 0–100 = average percentile
 *    of views, likes, comments, shares (+ saves on IG) among those 60.
 *    Verdict: ≥ 90 Top 10% · ≥ 65 Above Typical · ≥ 35 Typical · else Below.
 *  - Early read: the latest 24h / 3d / 7d snapshot vs the median snapshot
 *    of past posts at the same age.
 *  - Tags: format (Meta), topic (keyword rules, editable), style (BREAKING /
 *    DEVELOPING, emoji opener, question, headline length), manual tags.
 *    A tag is shown with n; under 8 posts is marked "few posts".
 *  - Story: a Facebook/Instagram post matched to a Substack post published
 *    within 2 days whose title shares ≥ 60% of its words.
 *  - Website visits: GA4 Facebook-sourced sessions landing on the post's
 *    link path within 7 days of posting. */

interface Post {
  platform: 'fb' | 'ig';
  id: string;
  created_at: string;
  text: string | null;
  permalink: string | null;
  format: string;
  link_url: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  views: number | null;
  reach: number | null;
  manual_tags: string;
}
interface Snap {
  platform: string;
  id: string;
  bucket: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  views: number | null;
}

const METRICS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;
type Metric = (typeof METRICS)[number];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY = 86400000;

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctRank = (x: number, xs: number[]) => (xs.length ? (xs.filter((v) => v < x).length + 0.5 * xs.filter((v) => v === x).length) / xs.length : 0.5);
const easternDow = (iso: string) => new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
const easternDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'its', 'into'].includes(w))
  );
const EMOJI_START = /^\s*\p{Extended_Pictographic}/u;

function styleTags(text: string | null): string[] {
  const t = (text ?? '').trim();
  const first = t.split('\n')[0];
  const out: string[] = [];
  if (/\bbreaking\b/i.test(first)) out.push('BREAKING headline');
  if (/\bdeveloping\b/i.test(first)) out.push('DEVELOPING headline');
  if (EMOJI_START.test(first)) out.push('Starts with emoji');
  if (/\?\s*$/.test(first) || /\?/.test(first.slice(0, 140))) out.push('Question');
  if (first.length && first.length <= 60) out.push('Short headline');
  else if (first.length > 110) out.push('Long headline');
  return out;
}

export async function socialDashboard(env: Env) {
  const acct = await loadMeta(env);
  const connection = {
    hasApp: !!acct.app_id && !!acct.app_secret_enc,
    appId: acct.app_id,
    connected: !!acct.page_token_enc,
    status: acct.status,
    userName: acct.user_name,
    page: acct.page_name,
    instagram: acct.ig_username,
    scopes: acct.scopes,
    lastSyncAt: acct.last_sync_at,
    lastRecentAt: acct.last_recent_at,
    lastError: acct.last_error,
  };
  const db = env.DB;
  const { results: postRows } = await db.prepare('SELECT * FROM bee_meta_posts ORDER BY created_at DESC').all<Post>();
  const posts = postRows ?? [];
  if (!posts.length) return { connection, empty: true as const };
  const { results: snapRows } = await db.prepare('SELECT * FROM bee_meta_snaps').all<Snap>();
  const { results: rules } = await db.prepare('SELECT topic, keywords FROM bee_topic_rules ORDER BY position, topic').all<{ topic: string; keywords: string }>();
  // Whole words only (plural s/es allowed): "bus" must not match "business".
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const topicRules = (rules ?? []).map((r) => ({
    topic: r.topic,
    res: r.keywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
      .map((k) => new RegExp(`(^|[^a-z0-9])${esc(k)}(s|es)?(?![a-z0-9])`, 'i')),
  }));
  const nowMs = Date.now();
  const grades = await gradeAllPosts(env, nowMs);

  // Baselines per platform.
  const mature = (p: Post) => nowMs - new Date(p.created_at).getTime() >= 7 * DAY;
  const baseline = new Map<string, Post[]>();
  for (const plat of ['fb', 'ig'] as const) baseline.set(plat, posts.filter((p) => p.platform === plat && mature(p)).slice(0, 60));
  const typical = (plat: string, m: Metric) => median((baseline.get(plat) ?? []).map((p) => p[m]).filter((v): v is number => v != null));
  const snapsBy = new Map<string, Snap[]>();
  for (const s of snapRows ?? []) snapsBy.set(`${s.platform}|${s.id}`, [...(snapsBy.get(`${s.platform}|${s.id}`) ?? []), s]);
  const baseIds = new Map([...baseline.entries()].map(([k, v]) => [k, new Set(v.map((p) => p.id))]));
  const snapTypical = (plat: string, bucket: string, m: Metric) =>
    median((snapRows ?? []).filter((s) => s.platform === plat && s.bucket === bucket && baseIds.get(plat)?.has(s.id)).map((s) => s[m]).filter((v): v is number => v != null));

  // Substack posts for story matching.
  const { results: subs } = await db.prepare('SELECT post_date, title, sent, opened, opens, views FROM bee_posts').all<{ post_date: string; title: string; sent: number | null; opened: number | null; opens: number | null; views: number | null }>();
  const subWords = (subs ?? []).map((s) => ({ ...s, w: words(s.title) }));

  // GA Facebook visits by landing path and date.
  const { results: gaRows } = await db
    .prepare(
      "SELECT date, landing, SUM(sessions) s FROM bee_ga_landing WHERE lower(source) LIKE '%facebook%' OR lower(source) IN ('fb', 'm.facebook.com', 'l.facebook.com', 'lm.facebook.com') GROUP BY date, landing"
    )
    .all<{ date: string; landing: string; s: number }>();

  const tagsFor = (p: Post): string[] => {
    // Topics come from the headline (first line): long posts mention everything.
    const t = (p.text ?? '').trim().split('\n')[0].toLowerCase();
    const topics = topicRules.filter((r) => r.res.some((re) => re.test(t))).map((r) => r.topic);
    let manual: string[] = [];
    try {
      manual = JSON.parse(p.manual_tags || '[]');
    } catch {
      manual = [];
    }
    return [`Format: ${p.format.charAt(0).toUpperCase()}${p.format.slice(1)}`, ...topics.map((x) => `Topic: ${x}`), ...styleTags(p.text).map((x) => `Style: ${x}`), ...manual.map((x) => `Tag: ${x}`)];
  };

  // Each post is judged against the 60 posts on its platform published
  // before it (the audience it actually had), so old posts aren't graded
  // against today's bigger reach. The first posts use the first 60.
  const chrono = new Map<string, Post[]>();
  for (const plat of ['fb', 'ig'] as const) chrono.set(plat, posts.filter((p) => p.platform === plat).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  const priorOf = (p: Post): Post[] => {
    const list = chrono.get(p.platform) ?? [];
    const i = list.findIndex((x) => x.id === p.id);
    const before = list.slice(Math.max(0, i - 60), i);
    return before.length >= 20 ? before : list.slice(0, 60).filter((x) => x.id !== p.id);
  };
  const scored = posts.map((p) => {
    // Under a week old: judged against the latest mature baseline.
    const base = mature(p) ? priorOf(p) : baseline.get(p.platform) ?? [];
    const used = METRICS.filter((m) => p[m] != null && (m !== 'saves' || p.platform === 'ig'));
    const ranks = used.map((m) => pctRank(p[m]!, base.map((b) => b[m]).filter((v): v is number => v != null)));
    const score = ranks.length ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 100) : null;
    const vsTypical: Record<string, number | null> = {};
    for (const m of used) {
      const t = median(base.map((b) => b[m]).filter((v): v is number => v != null));
      vsTypical[m] = t && t > 0 ? p[m]! / t : null;
    }
    // Early read: latest snapshot.
    const sn = (snapsBy.get(`${p.platform}|${p.id}`) ?? []).sort((a, b) => ['24h', '3d', '7d'].indexOf(b.bucket) - ['24h', '3d', '7d'].indexOf(a.bucket))[0];
    // Until enough past posts have a snapshot at the same age, the early
    // read compares against a typical post's final numbers ("so far").
    let early: { bucket: string; vsTypical: Record<string, number | null>; baseline: 'same-age' | 'final' } | null = null;
    if (!mature(p)) {
      const v: Record<string, number | null> = {};
      let sameAge = true;
      for (const m of METRICS) {
        const ts = sn ? snapTypical(p.platform, sn.bucket, m) : null;
        const t = ts ?? typical(p.platform, m);
        if (ts == null) sameAge = false;
        const val = sn ? sn[m] : p[m];
        v[m] = val != null && t && t > 0 ? val / t : null;
      }
      early = { bucket: sn?.bucket ?? 'so far', vsTypical: v, baseline: sameAge && sn ? 'same-age' : 'final' };
    }
    // Story match.
    const pw = words(p.text ?? '');
    let story: { title: string; date: string; sent: number | null; opened: number | null; views: number | null } | null = null;
    if (pw.size >= 3) {
      const t0 = new Date(p.created_at).getTime();
      const best = subWords
        .filter((s) => Math.abs(new Date(s.post_date).getTime() - t0) <= 2 * DAY)
        .map((s) => ({ s, sim: [...s.w].filter((w) => pw.has(w)).length / Math.max(1, Math.min(s.w.size, pw.size)) }))
        .sort((a, b) => b.sim - a.sim)[0];
      if (best && best.sim >= 0.6) story = { title: best.s.title, date: best.s.post_date, sent: best.s.sent, opened: best.s.opened, views: best.s.views };
    }
    // Website visits from this post's link.
    let siteVisits: number | null = null;
    if (p.platform === 'fb' && p.link_url && /thebedfordbee\.com/i.test(p.link_url)) {
      try {
        const path = new URL(p.link_url).pathname;
        const d0 = easternDate(p.created_at);
        const d1 = new Date(new Date(`${d0}T12:00:00Z`).getTime() + 7 * DAY).toISOString().slice(0, 10);
        siteVisits = (gaRows ?? []).filter((g) => g.date >= d0 && g.date <= d1 && (g.landing === path || g.landing.replace(/\/$/, '') === path.replace(/\/$/, ''))).reduce((n, g) => n + g.s, 0);
      } catch {
        siteVisits = null;
      }
    }
    const verdict = score === null ? null : score >= 90 ? 'Top 10%' : score >= 65 ? 'Above Typical' : score >= 35 ? 'Typical' : 'Below Typical';
    const per1k = (m: Metric) => (p.views && p[m] != null ? (p[m]! / p.views) * 1000 : null);
    return {
      platform: p.platform,
      id: p.id,
      createdAt: p.created_at,
      day: DOW[easternDow(p.created_at)],
      text: p.text,
      permalink: p.permalink,
      format: p.format,
      linkUrl: p.link_url,
      views: p.views,
      reach: p.reach,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      saves: p.saves,
      per1k: { likes: per1k('likes'), comments: per1k('comments'), shares: per1k('shares') },
      vsTypical,
      score,
      verdict,
      mature: mature(p),
      early,
      tags: tagsFor(p),
      manualTags: (() => {
        try {
          return JSON.parse(p.manual_tags || '[]') as string[];
        } catch {
          return [] as string[];
        }
      })(),
      story,
      siteVisits,
      grade: grades.posts.get(`${p.platform}:${p.id}`) ?? null,
    };
  });

  // Period stats (28 days vs prior 28) per platform.
  const period = (from: number, to: number, plat?: string) => {
    const ps = posts.filter((p) => (!plat || p.platform === plat) && new Date(p.created_at).getTime() >= from && new Date(p.created_at).getTime() < to);
    const sum = (m: Metric) => ps.reduce((n, p) => n + (p[m] ?? 0), 0);
    return { posts: ps.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves') };
  };
  const p28 = { all: period(nowMs - 28 * DAY, nowMs), fb: period(nowMs - 28 * DAY, nowMs, 'fb'), ig: period(nowMs - 28 * DAY, nowMs, 'ig') };
  const pPrev = { all: period(nowMs - 56 * DAY, nowMs - 28 * DAY), fb: period(nowMs - 56 * DAY, nowMs - 28 * DAY, 'fb'), ig: period(nowMs - 56 * DAY, nowMs - 28 * DAY, 'ig') };

  // Followers.
  const { results: dayRows } = await db.prepare('SELECT platform, date, metric, value FROM bee_meta_days ORDER BY date').all<{ platform: string; date: string; metric: string; value: number }>();
  const days = dayRows ?? [];
  const latest = (plat: string, metric: string) => [...days].reverse().find((d) => d.platform === plat && d.metric === metric)?.value ?? null;
  const followSeries = (plat: string) => {
    const fol = days.filter((d) => d.platform === plat && (d.metric === (plat === 'fb' ? 'page_follows' : 'follower_count') || d.metric === 'followers'));
    const byDate = new Map<string, number>();
    for (const d of fol) if (d.metric === 'followers' || !byDate.has(d.date)) byDate.set(d.date, d.value);
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
  };
  const igDaily = days.filter((d) => d.platform === 'ig' && d.metric === 'follower_count'); // new followers per day (30d)
  const fbNew = days.filter((d) => d.platform === 'fb' && d.metric === 'page_daily_follows_unique');
  const fbLost = days.filter((d) => d.platform === 'fb' && d.metric === 'page_daily_unfollows_unique');

  // Weekly scorecard (Mon–Sun, Eastern), last 12 weeks.
  const weekStart = (iso: string) => {
    const d = new Date(`${easternDate(iso)}T12:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { week: string; fb: ReturnType<typeof emptyW>; ig: ReturnType<typeof emptyW>; best: (typeof scored)[number] | null; worst: (typeof scored)[number] | null }>();
  function emptyW() {
    return { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, newFollowers: 0 };
  }
  for (const s of scored) {
    const wk = weekStart(s.createdAt);
    const w = weeks.get(wk) ?? (weeks.set(wk, { week: wk, fb: emptyW(), ig: emptyW(), best: null, worst: null }), weeks.get(wk)!);
    const t = w[s.platform];
    t.posts++;
    for (const m of METRICS) t[m] += s[m] ?? 0;
    // Best / worst of the week by grade rank (falls back to the old score).
    const r = s.grade?.rank ?? s.score;
    if (r != null && s.mature) {
      if (!w.best || (w.best.grade?.rank ?? w.best.score ?? 0) < r) w.best = s;
      if (!w.worst || (w.worst.grade?.rank ?? w.worst.score ?? 100) > r) w.worst = s;
    }
  }
  for (const d of fbNew) {
    const w = weeks.get(weekStart(`${d.date}T16:00:00Z`));
    if (w) w.fb.newFollowers += d.value;
  }
  for (const d of fbLost) {
    const w = weeks.get(weekStart(`${d.date}T16:00:00Z`));
    if (w) w.fb.newFollowers -= d.value;
  }
  for (const d of igDaily) {
    const w = weeks.get(weekStart(`${d.date}T16:00:00Z`));
    if (w) w.ig.newFollowers += d.value;
  }
  // Substack + website per week.
  const { results: subWeeks } = await db.prepare('SELECT post_date, sent, opened FROM bee_posts').all<{ post_date: string; sent: number | null; opened: number | null }>();
  const { results: gaDays } = await db.prepare('SELECT date, sessions FROM bee_ga_days').all<{ date: string; sessions: number }>();
  const extra = new Map<string, { emails: number; opened: number; siteVisits: number }>();
  const ex = (wk: string) => extra.get(wk) ?? (extra.set(wk, { emails: 0, opened: 0, siteVisits: 0 }), extra.get(wk)!);
  for (const s of subWeeks ?? []) {
    const e = ex(weekStart(s.post_date));
    e.emails += s.sent ?? 0;
    e.opened += s.opened ?? 0;
  }
  for (const g of gaDays ?? []) ex(weekStart(`${g.date}T16:00:00Z`)).siteVisits += g.sessions;
  const slim = (s: (typeof scored)[number] | null) => (s ? { platform: s.platform, id: s.id, text: (s.text ?? '').split('\n')[0].slice(0, 120), score: s.score, grade: s.grade?.letter ?? null, permalink: s.permalink } : null);
  const weekly = [...weeks.values()]
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 12)
    .map((w) => ({ week: w.week, fb: w.fb, ig: w.ig, best: slim(w.best), worst: slim(w.worst), substack: extra.get(w.week) ?? null }));

  // Day of week (mature posts, last 365 days).
  const yearAgo = nowMs - 365 * DAY;
  const dayOfWeek = (['fb', 'ig'] as const).map((plat) => ({
    platform: plat,
    days: DOW.map((day, i) => {
      const ps = scored.filter((s) => s.platform === plat && s.mature && new Date(s.createdAt).getTime() >= yearAgo && easternDow(s.createdAt) === i);
      const md = (m: Metric) => median(ps.map((p) => p[m]).filter((v): v is number => v != null));
      return { day, posts: ps.length, views: md('views'), likes: md('likes'), comments: md('comments'), shares: md('shares'), score: median(ps.map((p) => p.score).filter((v): v is number => v != null)) };
    }),
  }));

  // What works: tag performance (mature posts).
  const tagPerf = (['fb', 'ig'] as const).map((plat) => {
    const ps = scored.filter((s) => s.platform === plat && s.mature);
    const all = (m: Metric) => median(ps.map((p) => p[m]).filter((v): v is number => v != null));
    const overall = { views: all('views'), likes: all('likes'), comments: all('comments'), shares: all('shares') };
    const byTag = new Map<string, typeof ps>();
    for (const p of ps) for (const t of p.tags) byTag.set(t, [...(byTag.get(t) ?? []), p]);
    const rows = [...byTag.entries()]
      .filter(([, list]) => list.length >= 3)
      .map(([tag, list]) => {
        const md = (m: Metric) => median(list.map((p) => p[m]).filter((v): v is number => v != null));
        const ratio = (m: 'views' | 'likes' | 'comments' | 'shares') => {
          const a = md(m);
          const b = overall[m];
          return a !== null && b ? a / b : null;
        };
        return { tag, posts: list.length, few: list.length < 8, grades: gradeMix(list.map((p) => p.grade)), score: median(list.map((p) => p.score).filter((v): v is number => v != null)), views: ratio('views'), likes: ratio('likes'), comments: ratio('comments'), shares: ratio('shares') };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { platform: plat, posts: ps.length, rows };
  });

  return {
    connection,
    empty: false as const,
    range: { from: posts[posts.length - 1].created_at, to: posts[0].created_at, fbPosts: posts.filter((p) => p.platform === 'fb').length, igPosts: posts.filter((p) => p.platform === 'ig').length },
    period: { now: p28, prev: pPrev },
    typical: Object.fromEntries((['fb', 'ig'] as const).map((plat) => [plat, Object.fromEntries(METRICS.map((m) => [m, typical(plat, m)]))])),
    followers: {
      fb: { now: latest('fb', 'followers') ?? latest('fb', 'page_follows'), series: followSeries('fb') },
      ig: { now: latest('ig', 'followers'), series: followSeries('ig'), newLast30: igDaily.reduce((n, d) => n + d.value, 0) },
    },
    posts: scored,
    weekly,
    dayOfWeek,
    tagPerf,
    topicRules: (rules ?? []).map((r) => ({ topic: r.topic, keywords: r.keywords })),
    gradeConfig: grades.config,
  };
}
