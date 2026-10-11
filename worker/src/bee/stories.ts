import type { Env } from '../types';

/** Stories (Mike, 2026-10-11): the same post goes out on Facebook,
 * Instagram and Substack every day — group them into one story.
 *
 * Matching (rule-based): headline = first line, emoji/punctuation removed,
 * common words dropped. A Facebook and an Instagram post published within
 * 36 hours whose headline words overlap ≥ 60% are one story; a Substack post
 * published within 48 hours with ≥ 60% overlap joins it. Anything unmatched
 * is a one-platform story.
 *
 * Combined numbers: views = FB views + IG views + Substack views (email
 * opens + web views); likes, comments; shares = FB + IG + Substack shares and
 * restacks. Saves (IG) are reported but not in the combined score.
 * Score = mean percentile of combined views, likes, comments, shares among
 * the 60 stories before it (mature: ≥ 7 days old). */

export interface StoryPart {
  platform: 'fb' | 'ig' | 'substack';
  id: string;
  createdAt: string;
  headline: string;
  permalink: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  extra?: Record<string, number | null>;
}
export interface Story {
  key: string;
  date: string; // Eastern date of the earliest part
  createdAt: string;
  headline: string;
  parts: StoryPart[];
  total: { views: number; likes: number; comments: number; shares: number; saves: number };
  social: { views: number; likes: number; comments: number; shares: number; saves: number };
  score: number | null;
  scoreSocial: number | null;
  mature: boolean;
}

const DAY = 86400000;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'its', 'into', 'bedford', 'breaking', 'developing', 'new', 'not', 'but', 'you', 'your', 'our']);
export const headlineOf = (t: string | null) => (t ?? '').trim().split('\n')[0].trim();
const wordsOf = (t: string) =>
  new Set(
    headlineOf(t)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
const overlap = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
};
const easternDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const pctRank = (x: number, xs: number[]) => (xs.length ? (xs.filter((v) => v < x).length + 0.5 * xs.filter((v) => v === x).length) / xs.length : 0.5);

export async function buildStories(env: Env): Promise<Story[]> {
  const db = env.DB;
  const { results: meta } = await db
    .prepare('SELECT platform, id, created_at, text, permalink, likes, comments, shares, saves, views FROM bee_meta_posts ORDER BY created_at')
    .all<{ platform: 'fb' | 'ig'; id: string; created_at: string; text: string | null; permalink: string | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; views: number | null }>();
  const { results: subs } = await db
    .prepare('SELECT post_date, title, views, likes, comments, shares, restacks, sent, opened, opens, signups, subscribes, upgrades FROM bee_posts ORDER BY post_date')
    .all<{
      post_date: string;
      title: string;
      views: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
      restacks: number | null;
      sent: number | null;
      opened: number | null;
      opens: number | null;
      signups: number | null;
      subscribes: number | null;
      upgrades: number | null;
    }>();

  const toPart = (m: NonNullable<typeof meta>[number]): StoryPart => ({
    platform: m.platform,
    id: m.id,
    createdAt: m.created_at,
    headline: headlineOf(m.text) || '(no text)',
    permalink: m.permalink,
    views: m.views,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
  });
  const fb = (meta ?? []).filter((m) => m.platform === 'fb').map((m) => ({ p: toPart(m), w: wordsOf(m.text ?? ''), t: new Date(m.created_at).getTime() }));
  const ig = (meta ?? []).filter((m) => m.platform === 'ig').map((m) => ({ p: toPart(m), w: wordsOf(m.text ?? ''), t: new Date(m.created_at).getTime(), used: false }));
  const sb = (subs ?? []).map((s) => ({
    p: {
      platform: 'substack' as const,
      id: s.post_date,
      createdAt: new Date(s.post_date).toISOString(),
      headline: s.title,
      permalink: null,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      shares: (s.shares ?? 0) + (s.restacks ?? 0),
      saves: null,
      extra: { sent: s.sent, opened: s.opened, opens: s.opens, signups: s.signups, paid: (s.subscribes ?? 0) + (s.upgrades ?? 0) },
    },
    w: wordsOf(s.title),
    t: new Date(s.post_date).getTime(),
    used: false,
  }));

  const best = <T extends { w: Set<string>; t: number; used: boolean }>(list: T[], w: Set<string>, t: number, windowMs: number) => {
    let pick: T | null = null;
    let score = 0;
    for (const c of list) {
      if (c.used || Math.abs(c.t - t) > windowMs) continue;
      const o = overlap(w, c.w);
      if (o >= 0.6 && o > score) {
        score = o;
        pick = c;
      }
    }
    return pick;
  };

  const groups: StoryPart[][] = [];
  for (const f of fb) {
    const parts = [f.p];
    const i = best(ig, f.w, f.t, 36 * 3600000);
    if (i) {
      i.used = true;
      parts.push(i.p);
    }
    const s = best(sb, f.w, f.t, 2 * DAY);
    if (s) {
      s.used = true;
      parts.push(s.p);
    }
    groups.push(parts);
  }
  for (const i of ig) {
    if (i.used) continue;
    const parts = [i.p];
    const s = best(sb, i.w, i.t, 2 * DAY);
    if (s) {
      s.used = true;
      parts.push(s.p);
    }
    groups.push(parts);
  }
  // Substack posts before Meta's 2-year window or never posted socially.
  for (const s of sb) if (!s.used) groups.push([s.p]);

  const nowMs = Date.now();
  const sum = (parts: StoryPart[], k: 'views' | 'likes' | 'comments' | 'shares' | 'saves') => parts.reduce((n, p) => n + (p[k] ?? 0), 0);
  const stories: Story[] = groups.map((parts) => {
    parts.sort((a, b) => ['fb', 'ig', 'substack'].indexOf(a.platform) - ['fb', 'ig', 'substack'].indexOf(b.platform));
    const first = [...parts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const social = parts.filter((p) => p.platform !== 'substack');
    const pick = (ps: StoryPart[]) => ({ views: sum(ps, 'views'), likes: sum(ps, 'likes'), comments: sum(ps, 'comments'), shares: sum(ps, 'shares'), saves: sum(ps, 'saves') });
    return {
      key: parts.map((p) => `${p.platform}:${p.id}`).join('|'),
      date: easternDate(first.createdAt),
      createdAt: first.createdAt,
      headline: (parts.find((p) => p.platform === 'substack') ?? parts.find((p) => p.platform === 'fb') ?? parts[0]).headline,
      parts,
      total: pick(parts),
      social: pick(social),
      score: null,
      scoreSocial: null,
      mature: nowMs - new Date(first.createdAt).getTime() >= 7 * DAY,
    };
  });
  stories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Rolling score against the 60 stories before each one.
  const keys = ['views', 'likes', 'comments', 'shares'] as const;
  stories.forEach((s, i) => {
    const prior = stories.slice(Math.max(0, i - 60), i);
    const base = prior.length >= 20 ? prior : stories.slice(0, 60).filter((x) => x !== s);
    const score = (pick: (x: Story) => Story['total']) => Math.round((keys.reduce((n, k) => n + pctRank(pick(s)[k], base.map((b) => pick(b)[k])), 0) / keys.length) * 100);
    s.score = score((x) => x.total);
    s.scoreSocial = s.social.views || s.social.likes ? score((x) => x.social) : null;
  });
  return stories.reverse();
}
