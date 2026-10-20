import type { Env } from '../types';

// Public, read-only aggregate numbers for the Bedford Bee homepage
// (GET /public/bee-stats, outside authGate). Returns ONLY sums/counts —
// never emails, posts or row data.

export interface BeePublicStats {
  views: number;
  followers: number;
  breakdown: {
    fbViews: number;
    igViews: number;
    substackViews: number;
    fbFollowers: number;
    igFollowers: number;
    substackSubscribers: number;
  };
  updated: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function beePublicStats(env: Env): Promise<BeePublicStats> {
  const db = env.DB;
  const [fbViews, igViews, substackViews, fbFollowers, igFollowers, substackSubscribers] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(views),0) n FROM bee_meta_posts WHERE platform='fb'"),
    db.prepare("SELECT COALESCE(SUM(views),0) n FROM bee_meta_posts WHERE platform='ig'"),
    db.prepare('SELECT COALESCE(SUM(views),0) n FROM bee_posts'),
    db.prepare(
      "SELECT value n FROM bee_meta_days WHERE platform='fb' AND metric IN ('followers','page_follows') ORDER BY date DESC, CASE metric WHEN 'followers' THEN 0 ELSE 1 END LIMIT 1",
    ),
    db.prepare("SELECT value n FROM bee_meta_days WHERE platform='ig' AND metric='followers' ORDER BY date DESC LIMIT 1"),
    db.prepare("SELECT COUNT(*) n FROM bee_subscribers WHERE active=1 AND lower(COALESCE(type,'')) != 'author'"),
  ]);

  const first = (r: D1Result): number => num((r.results?.[0] as { n?: unknown } | undefined)?.n);

  const breakdown = {
    fbViews: first(fbViews),
    igViews: first(igViews),
    substackViews: first(substackViews),
    fbFollowers: first(fbFollowers),
    igFollowers: first(igFollowers),
    substackSubscribers: first(substackSubscribers),
  };

  return {
    views: breakdown.fbViews + breakdown.igViews + breakdown.substackViews,
    followers: breakdown.fbFollowers + breakdown.igFollowers + breakdown.substackSubscribers,
    breakdown,
    updated: new Date().toISOString(),
  };
}
