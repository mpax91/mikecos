import type { SubscriberStats } from './ingest';

/** Subscriber Spotlight rules (Mike, 2026-10-10) — rule-based, no AI.
 *
 * Forward ratio = opens ÷ unique emails opened over the export's 6-month
 * window. A forwarded email carries its tracking pixel, so every reader it
 * reaches counts as the subscriber opening it again. Forwarder = at least
 * 5 emails opened and a ratio ≥ max(2.5, 2× the list's median ratio).
 *   Burst  = opens only some emails (< 40% of those received) but ≥ 4× each
 *            — picks the posts they like and passes them to a group.
 *   Steady = opens most emails, every one several times.
 * Work addresses (security scanners) and Apple Mail (auto-opens / several
 * devices) can inflate opens — flagged, not excluded.
 *
 * Superfan score 0–100: read share 40 + days active (30d) 20 + clicks 15 +
 * shares/comments 15 + post views 10. Superfan ≥ 70 with ≥ 5 emails
 * received. A free superfan is an upgrade candidate. */

export interface Engagement {
  ratio: number | null;
  readShare: number | null; // unique emails opened ÷ received (6 mo)
  score: number;
  forwarder: 'burst' | 'steady' | null;
  superfan: boolean;
  inflated: 'work' | 'apple' | null;
}

const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'optimum.net', 'optonline.net',
  'verizon.net', 'comcast.net', 'att.net', 'sbcglobal.net', 'protonmail.com', 'proton.me', 'earthlink.net', 'cox.net', 'charter.net', 'frontier.com',
  'gmx.com', 'mail.com', 'bellsouth.net', 'rocketmail.com', 'aim.com', 'icloud.com', 'me.com', 'mac.com', 'fastmail.com', 'hey.com',
]);
const APPLE_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com']);

export function inflationHint(email: string): Engagement['inflated'] {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (APPLE_DOMAINS.has(domain)) return 'apple';
  if (domain && !CONSUMER_DOMAINS.has(domain) && !domain.endsWith('.edu')) return 'work';
  return null;
}

export function forwardRatio(s: SubscriberStats): number | null {
  if (!s.seen6mo || s.seen6mo < 1 || s.opened6mo === null) return null;
  return s.opened6mo / s.seen6mo;
}

export function medianRatio(all: SubscriberStats[]): number {
  const rs = all
    .filter((s) => (s.seen6mo ?? 0) >= 5)
    .map(forwardRatio)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  if (!rs.length) return 1;
  const mid = Math.floor(rs.length / 2);
  return rs.length % 2 ? rs[mid] : (rs[mid - 1] + rs[mid]) / 2;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function engagementFor(email: string, s: SubscriberStats, median: number): Engagement {
  const ratio = forwardRatio(s);
  const readShare = s.received6mo ? clamp01((s.seen6mo ?? 0) / s.received6mo) : null;
  const score = Math.round(
    40 * (readShare ?? 0) +
      20 * clamp01((s.daysActive30d ?? 0) / 15) +
      15 * clamp01((s.clicks ?? 0) / 10) +
      15 * clamp01(((s.shares ?? 0) + (s.comments ?? 0)) / 5) +
      10 * clamp01((s.postViews ?? 0) / 20)
  );
  let forwarder: Engagement['forwarder'] = null;
  if (ratio !== null && (s.seen6mo ?? 0) >= 5 && ratio >= Math.max(2.5, 2 * median)) {
    forwarder = readShare !== null && readShare < 0.4 && ratio >= 4 ? 'burst' : 'steady';
  }
  return { ratio, readShare, score, forwarder, superfan: score >= 70 && (s.received6mo ?? 0) >= 5, inflated: inflationHint(email) };
}

export const isPaidType = (type: string | null) => !!type && !/^(free|author)$/i.test(type.trim());
