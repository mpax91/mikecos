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
 * Open Grade A–F (Mike, 2026-10-12): an open is all it takes to read the
 * piece, so the grade is ONLY the read share (unique emails opened ÷
 * received, 6 months), curved to the list: each subscriber's share of the
 * graded list they match or beat → A > 80%, B > 60%, C > 40%, D > 20%, else
 * F (ties share the higher grade; opened nothing = F). Fewer than 5 emails
 * received = no grade yet ("New"). Forwarders are a separate badge, never
 * part of the grade. Work / Apple Mail inboxes are graded but marked.
 *
 * Score 0–100 (kept as a detail, open-heavy since 2026-10-12): read share 60
 * + forwarding 15 + days active (30d) 10 + clicks 5 + shares/comments 5 +
 * post views 5. Superfan = grade A. A free superfan is an upgrade
 * candidate. */

export type OpenGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export const GRADE_MIN_RECEIVED = 5;

export interface Engagement {
  ratio: number | null;
  readShare: number | null; // unique emails opened ÷ received (6 mo)
  score: number;
  grade: OpenGrade | null; // null = fewer than 5 emails received ("New")
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
    60 * (readShare ?? 0) +
      15 * clamp01(((ratio ?? 1) - 1) / Math.max(1, 2 * median - 1)) +
      10 * clamp01((s.daysActive30d ?? 0) / 15) +
      5 * clamp01((s.clicks ?? 0) / 10) +
      5 * clamp01(((s.shares ?? 0) + (s.comments ?? 0)) / 5) +
      5 * clamp01((s.postViews ?? 0) / 20)
  );
  let forwarder: Engagement['forwarder'] = null;
  if (ratio !== null && (s.seen6mo ?? 0) >= 5 && ratio >= Math.max(2.5, 2 * median)) {
    forwarder = readShare !== null && readShare < 0.4 && ratio >= 4 ? 'burst' : 'steady';
  }
  // grade + superfan are filled in by assignGrades once the whole list is known.
  return { ratio, readShare, score, grade: null, forwarder, superfan: false, inflated: inflationHint(email) };
}

/** Curve the Open Grade across the list (see header). Mutates `people`. */
export function assignGrades(people: { readShare: number | null; received6mo: number | null; grade: OpenGrade | null; superfan: boolean }[]): void {
  const graded = people.filter((p) => (p.received6mo ?? 0) >= GRADE_MIN_RECEIVED && p.readShare !== null);
  const shares = graded.map((p) => p.readShare!).sort((a, b) => a - b);
  const n = shares.length;
  for (const p of people) {
    p.grade = null;
    p.superfan = false;
  }
  for (const p of graded) {
    const v = p.readShare!;
    let atOrBelow = 0; // upper bound of v in the sorted list
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shares[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    atOrBelow = lo;
    const pct = atOrBelow / n;
    p.grade = v <= 0 ? 'F' : pct > 0.8 ? 'A' : pct > 0.6 ? 'B' : pct > 0.4 ? 'C' : pct > 0.2 ? 'D' : 'F';
    p.superfan = p.grade === 'A';
  }
}

export const GRADE_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

export const isPaidType = (type: string | null) => !!type && !/^(free|author)$/i.test(type.trim());
