import type { Env } from '../types';
import { buildStories } from './stories';
import type { Story } from './stories';
import { substackDashboard } from './summary';
import { loadGsc } from './gsc';
import { merchTotals } from './merch';

/** GET /api/bee/review?year=2026 — Bedford Bee Year in Review across every
 * source (Mike, 2026-10-11): the year so far, vs the previous year on the
 * same dates and vs the previous full year (the Bee started July 2025).
 * Followers: Facebook from Meta's daily follows; Instagram only knows the
 * current count (Meta keeps 30 days), so its start-of-year is unknown. */

const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
interface Range {
  from: string;
  to: string;
}

async function rangeTotals(env: Env, r: Range, stories: Story[]) {
  const db = env.DB;
  const inR = (d: string) => d >= r.from && d <= r.to;
  const ss = stories.filter((s) => inR(s.date));
  const part = (plat: 'fb' | 'ig' | 'substack') => {
    const ps = ss.flatMap((s) => s.parts.filter((p) => p.platform === plat));
    const sum = (k: 'views' | 'likes' | 'comments' | 'shares' | 'saves') => ps.reduce((n, p) => n + (p[k] ?? 0), 0);
    return { posts: ps.length, views: sum('views'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves') };
  };
  const fb = part('fb');
  const ig = part('ig');
  const sub = part('substack');
  const one = async <T>(sql: string): Promise<T | null> => (await db.prepare(sql).bind(r.from, r.to).first<T>()) ?? null;
  const ga = await one<{ s: number | null; v: number | null }>('SELECT SUM(sessions) s, SUM(views) v FROM bee_ga_days WHERE date BETWEEN ? AND ?');
  const gsc = await one<{ c: number | null; i: number | null }>('SELECT SUM(clicks) c, SUM(impressions) i FROM bee_gsc_days WHERE date BETWEEN ? AND ?');
  const bing = await one<{ c: number | null; i: number | null }>('SELECT SUM(clicks) c, SUM(impressions) i FROM bee_bing_days WHERE date BETWEEN ? AND ?');
  const emails = await one<{ sent: number | null; opened: number | null; opens: number | null; posts: number }>(
    "SELECT SUM(sent) sent, SUM(opened) opened, SUM(opens) opens, COUNT(*) posts FROM bee_posts WHERE substr(post_date,1,10) BETWEEN ? AND ?"
  );
  const fbFollow = await db
    .prepare("SELECT date, value FROM bee_meta_days WHERE platform = 'fb' AND metric = 'page_follows' AND date BETWEEN ? AND ? ORDER BY date")
    .bind(r.from, r.to)
    .all<{ date: string; value: number }>();
  const fol = fbFollow.results ?? [];
  const merch = await merchTotals(env, r);
  const totalViews = fb.views + ig.views + sub.views + (ga?.v ?? 0);
  return {
    range: r,
    stories: ss.length,
    social: {
      posts: fb.posts + ig.posts,
      views: fb.views + ig.views,
      likes: fb.likes + ig.likes,
      comments: fb.comments + ig.comments,
      shares: fb.shares + ig.shares,
      saves: ig.saves,
    },
    facebook: { ...fb, followersStart: fol[0]?.value ?? null, followersEnd: fol[fol.length - 1]?.value ?? null },
    instagram: ig,
    substack: { ...sub, posts: emails?.posts ?? sub.posts, emailsSent: emails?.sent ?? 0, opened: emails?.opened ?? 0, opens: emails?.opens ?? 0 },
    website: { visits: ga?.s ?? 0, pageViews: ga?.v ?? 0 },
    merch,
    search: { googleClicks: gsc?.c ?? 0, googleImpressions: gsc?.i ?? 0, bingClicks: bing?.c ?? 0, bingImpressions: bing?.i ?? 0 },
    everything: {
      views: totalViews,
      likes: fb.likes + ig.likes + sub.likes,
      comments: fb.comments + ig.comments + sub.comments,
      shares: fb.shares + ig.shares + sub.shares,
    },
  };
}

const slim = (s: Story) => ({
  date: s.date,
  headline: s.headline,
  score: s.score,
  total: s.total,
  parts: s.parts.map((p) => ({ platform: p.platform, views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, permalink: p.permalink })),
});

export async function reviewDashboard(env: Env, year: number) {
  const today = easternToday();
  const ytdEnd = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  const partial = ytdEnd !== `${year}-12-31`;
  const prev = year - 1;
  const cur: Range = { from: `${year}-01-01`, to: ytdEnd };
  const prevSame: Range = { from: `${prev}-01-01`, to: `${prev}${ytdEnd.slice(4)}` };
  const prevFull: Range = { from: `${prev}-01-01`, to: `${prev}-12-31` };
  const stories = await buildStories(env);
  const [now, same, full] = await Promise.all([rangeTotals(env, cur, stories), rangeTotals(env, prevSame, stories), rangeTotals(env, prevFull, stories)]);

  // Substack subscribers + money from the Substack dashboard's year rows.
  const sub = await substackDashboard(env);
  const yr = (y: number) => sub.years.find((r) => r.year === y) ?? null;
  const money = (y: number) => sub.money.years.find((m) => m.year === y) ?? null;
  const subYear = (y: number) => {
    const r = yr(y);
    const m = money(y);
    return r
      ? { subsStart: r.subsStart, subsEnd: r.subsEnd, paidStart: r.paidStart, paidEnd: r.paidEnd, joined: r.freeGained, paidGained: r.paidGained, lost: r.lost, gross: m?.gross ?? 0, net: m?.net ?? 0 }
      : null;
  };

  // Visitors (de-duplicated) — only GA's own snapshot can count them.
  const gsc = await loadGsc(env);
  const snap = gsc?.ga_snapshot_json ? (JSON.parse(gsc.ga_snapshot_json) as Record<string, { users: number; from: string; to: string }>) : {};
  const visitors = { thisYear: String(year) === today.slice(0, 4) ? (snap.thisYear?.users ?? null) : null, lastYear: String(prev) === String(Number(today.slice(0, 4)) - 1) ? (snap.lastYear?.users ?? null) : null };

  const igFollowers = await env.DB.prepare("SELECT value FROM bee_meta_days WHERE platform = 'ig' AND metric = 'followers' ORDER BY date DESC LIMIT 1").first<{ value: number }>();
  const fbFollowersNow = await env.DB.prepare("SELECT value FROM bee_meta_days WHERE platform = 'fb' AND metric = 'followers' ORDER BY date DESC LIMIT 1").first<{ value: number }>();

  // Top stories of the year.
  const ys = stories.filter((s) => s.date >= cur.from && s.date <= cur.to);
  const topBy = (k: 'views' | 'likes' | 'comments' | 'shares', plat?: 'fb' | 'ig' | 'substack') =>
    [...ys]
      .filter((s) => !plat || s.parts.some((p) => p.platform === plat))
      .sort((a, b) => (plat ? (b.parts.find((p) => p.platform === plat)?.[k] ?? 0) - (a.parts.find((p) => p.platform === plat)?.[k] ?? 0) : b.total[k] - a.total[k]))
      .slice(0, 5)
      .map(slim);
  const tops = {
    combined: { views: topBy('views'), likes: topBy('likes'), comments: topBy('comments'), shares: topBy('shares') },
    facebook: { views: topBy('views', 'fb'), likes: topBy('likes', 'fb'), comments: topBy('comments', 'fb'), shares: topBy('shares', 'fb') },
    instagram: { views: topBy('views', 'ig'), likes: topBy('likes', 'ig'), comments: topBy('comments', 'ig'), shares: topBy('shares', 'ig') },
    substack: { views: topBy('views', 'substack'), likes: topBy('likes', 'substack'), comments: topBy('comments', 'substack'), shares: topBy('shares', 'substack') },
  };

  // Month by month (combined views + posts) for the chart.
  const months = new Map<string, { month: string; views: number; social: number; substack: number; website: number; stories: number }>();
  const mk = (m: string) => months.get(m) ?? (months.set(m, { month: m, views: 0, social: 0, substack: 0, website: 0, stories: 0 }), months.get(m)!);
  for (const s of stories) {
    if (s.date < prevFull.from || s.date > cur.to) continue;
    const m = mk(s.date.slice(0, 7));
    m.stories++;
    m.social += s.social.views;
    m.substack += s.parts.filter((p) => p.platform === 'substack').reduce((n, p) => n + (p.views ?? 0), 0);
  }
  const { results: gaMonths } = await env.DB.prepare('SELECT substr(date,1,7) m, SUM(views) v FROM bee_ga_days WHERE date BETWEEN ? AND ? GROUP BY m').bind(prevFull.from, cur.to).all<{ m: string; v: number }>();
  for (const g of gaMonths ?? []) mk(g.m).website = g.v;
  for (const m of months.values()) m.views = m.social + m.substack + m.website;
  const firstDate = stories.length ? stories[stories.length - 1].date : null;

  return {
    year,
    partial,
    today,
    started: firstDate,
    now,
    prevSame,
    prevSameTotals: same,
    prevFull: full,
    substack: { now: subYear(year), prev: subYear(prev) },
    visitors,
    followers: { facebook: fbFollowersNow?.value ?? now.facebook.followersEnd, instagram: igFollowers?.value ?? null },
    tops,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    sources: {
      // When each source's history starts — so a "0" for 2025 reads right.
      meta: firstDate,
      ga: (await env.DB.prepare('SELECT MIN(date) d FROM bee_ga_days').first<{ d: string | null }>())?.d ?? null,
      gsc: (await env.DB.prepare('SELECT MIN(date) d FROM bee_gsc_days').first<{ d: string | null }>())?.d ?? null,
      merch: (await env.DB.prepare('SELECT MIN(day) d FROM bee_fw_orders').first<{ d: string | null }>())?.d ?? null,
    },
  };
}
