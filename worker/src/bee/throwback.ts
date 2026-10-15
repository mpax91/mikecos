import type { Env } from '../types';
import { buildStories, type Story } from './stories';
import { gradeAllPosts, gradeStories, type Grade } from './grades';

/** Throwback Thursday (Mike, 2026-10-14). Thursdays are a slow day, so Mike
 * reshares an older story for newer followers. This ranks candidates and
 * keeps track of what's been reused.
 *
 * Two lists for the coming Thursday (Eastern; Fri–Sun look at NEXT week's,
 * because Mike schedules the week's posts on Saturday):
 *  - This Time Last Year: original stories within ± window_days of the same
 *    date 1, 2, … years back, best social grade first.
 *  - Best Of: originals at least min_age_days old, ranked by social grade
 *    rank × (0.75 + 0.5 × share of today's Facebook followers who joined
 *    after it ran) — a strong post most of today's audience never saw wins.
 *
 * Reuse (computed from the posts, nothing to maintain):
 *  - a headline starting "🕰️THROWBACK THURSDAY" is a reshare of the best
 *    match (≥ 60% of the shorter headline's words) among stories 30+ days
 *    older;
 *  - an unprefixed post is a repurpose only when its headline words are the
 *    same set (2+ words) or share 3+ words making up ≥ 75% of the longer
 *    headline, again 30+ days later (checked on live data 2026-10-14: 28
 *    prefixed + 5 repurposes, no false matches).
 *  Plus Mike's marks (bee_throwback_marks): manual "I reshared this", a
 *  planned pick for a Thursday, Never Suggest, Not a Reshare.
 * A reused story sits out cooldown_days from its last use (planned counts).
 * Grades are the social-only story grades (FB + IG), the same as Stories
 * with Include Substack off. */

export const TBT_PREFIX = '🕰️THROWBACK THURSDAY: ';
const PREFIX_RE = /^\s*(?:🕰️?\s*)?throwback\s+thursday\b\s*[:\-–—|]?\s*/iu;
const LEAD_RE = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}️‍⃣#*]*(?:(?:breaking|developing|just in|update|new policy alert)\s*[:!\-–—]\s*)?/iu;
const DAY = 86400000;
const REUSE_MIN_DAYS = 30;
const LIST_LIMIT = 25;
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'its',
  'into',
  'bedford',
  'breaking',
  'developing',
  'new',
  'not',
  'but',
  'you',
  'your',
  'our',
  'throwback',
  'thursday',
]);

export const isThrowbackText = (t: string | null | undefined) => PREFIX_RE.test((t ?? '').split('\n')[0] ?? '');
const stripPrefix = (t: string) => t.replace(PREFIX_RE, '');
export function wordsOf(t: string): Set<string> {
  return new Set(
    stripPrefix((t ?? '').trim().split('\n')[0].trim())
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
const shared = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
};
/** Prefixed reshare: share of the shorter headline's words. */
export const prefixMatch = (a: Set<string>, b: Set<string>) => (a.size && b.size ? shared(a, b) / Math.min(a.size, b.size) : 0);
/** Unprefixed repurpose: stricter — same word set, or 3+ shared ≥ 75% of the longer. */
export function repurposeMatch(a: Set<string>, b: Set<string>): number {
  const n = shared(a, b);
  if (n >= 2 && n === a.size && n === b.size) return 1;
  if (n < 3) return 0;
  const v = n / Math.max(a.size, b.size);
  return v >= 0.75 ? v : 0;
}

/** The text to paste: prefix + the original first line minus its leading
 * emoji and "BREAKING:" (how Mike wrote his past throwbacks); the rest as is. */
export function throwbackText(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const lines = text.replace(/\r/g, '').split('\n');
  const first = stripPrefix(lines[0]).replace(LEAD_RE, '').trim() || stripPrefix(lines[0]).trim();
  return [TBT_PREFIX + first, ...lines.slice(1)].join('\n');
}

const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dayMs = (d: string) => new Date(`${d}T12:00:00Z`).getTime();
const addDays = (d: string, n: number) => new Date(dayMs(d) + n * DAY).toISOString().slice(0, 10);
/** The Thursday Mike is picking for: today if Thursday, else the next one. */
export function targetThursday(today = easternToday()): string {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (4 - dow + 7) % 7);
}
const yearsBack = (d: string, k: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  const day = m === 2 && dd === 29 ? 28 : dd;
  return `${y - k}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export interface ThrowbackSettings {
  windowDays: number;
  cooldownDays: number;
  minAgeDays: number;
}
export async function loadThrowbackSettings(env: Env): Promise<ThrowbackSettings> {
  const r = await env.DB.prepare('SELECT window_days, cooldown_days, min_age_days FROM bee_throwback_settings WHERE id = 1').first<{
    window_days: number;
    cooldown_days: number;
    min_age_days: number;
  }>();
  return { windowDays: r?.window_days ?? 14, cooldownDays: r?.cooldown_days ?? 365, minAgeDays: r?.min_age_days ?? 180 };
}
export async function saveThrowbackSettings(env: Env, raw: Partial<ThrowbackSettings>): Promise<ThrowbackSettings> {
  const cur = await loadThrowbackSettings(env);
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`must be between ${lo} and ${hi}`);
    return Math.round(n);
  };
  const s = {
    windowDays: num(raw.windowDays, 1, 60, cur.windowDays),
    cooldownDays: num(raw.cooldownDays, 0, 1825, cur.cooldownDays),
    minAgeDays: num(raw.minAgeDays, 30, 1825, cur.minAgeDays),
  };
  await env.DB.prepare('UPDATE bee_throwback_settings SET window_days = ?, cooldown_days = ?, min_age_days = ?, updated_at = ? WHERE id = 1')
    .bind(s.windowDays, s.cooldownDays, s.minAgeDays, new Date().toISOString())
    .run();
  return s;
}

interface Mark {
  id: string;
  kind: 'manual' | 'planned' | 'never' | 'not_reshare';
  orig_anchor: string | null;
  reuse_anchor: string | null;
  used_on: string | null;
  headline: string | null;
  created_at: string;
}
export interface ThrowbackUse {
  date: string;
  source: 'prefix' | 'repurpose' | 'manual' | 'planned';
  markId?: string;
  reuseAnchor?: string;
  reuseHeadline?: string;
  reuseGrade?: Grade | null;
}
export interface ThrowbackCandidate {
  anchor: string;
  date: string;
  headline: string;
  grade: Grade | null;
  social: Story['social'];
  links: { platform: 'fb' | 'ig' | 'substack'; url: string | null }[];
  followersThen: number | null;
  newFollowers: number | null;
  newShare: number | null;
  uses: ThrowbackUse[];
  lastUsed: string | null;
  coolingUntil: string | null;
  priority: number | null;
  yearsAgo?: number;
  daysOff?: number;
  fbText: string | null;
  igText: string | null;
}

export const anchorOf = (s: Story) => {
  const p = s.parts.find((x) => x.platform === 'fb') ?? s.parts.find((x) => x.platform === 'ig') ?? s.parts[0];
  return `${p.platform}:${p.id}`;
};

/** Find every reuse (newest stories list → chronological). */
export function detectReuses(stories: Story[], notReshare: Set<string>) {
  const chron = [...stories].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const info = chron.map((s) => ({ s, anchor: anchorOf(s), t: new Date(s.createdAt).getTime(), w: wordsOf(s.headline), prefixed: s.parts.some((p) => isThrowbackText(p.headline)) }));
  const reuseOf = new Map<string, { origAnchor: string; source: 'prefix' | 'repurpose' }>();
  for (const x of info) {
    if (notReshare.has(x.anchor)) continue;
    let best: (typeof info)[number] | null = null;
    let bestV = 0;
    for (const o of info) {
      if (o.t > x.t - REUSE_MIN_DAYS * DAY) break;
      if (reuseOf.has(o.anchor)) continue; // reshares point at the original
      const v = x.prefixed ? prefixMatch(x.w, o.w) : repurposeMatch(x.w, o.w);
      if (v > bestV) {
        bestV = v;
        best = o;
      }
    }
    if (best && (x.prefixed ? bestV >= 0.6 : bestV > 0)) reuseOf.set(x.anchor, { origAnchor: best.anchor, source: x.prefixed ? 'prefix' : 'repurpose' });
  }
  return reuseOf;
}

async function followerSeries(env: Env) {
  const { results } = await env.DB.prepare("SELECT date, value FROM bee_meta_days WHERE platform = 'fb' AND metric IN ('page_follows', 'followers') ORDER BY date, metric").all<{
    date: string;
    value: number;
  }>();
  const byDate = new Map<string, number>();
  for (const r of results ?? []) byDate.set(r.date, r.value); // 'page_follows' sorts before 'followers' — the snapshot wins
  return [...byDate.entries()].map(([date, value]) => ({ date, value }));
}
const followersOn = (series: { date: string; value: number }[], d: string) => {
  if (!series.length) return null;
  let v: number | null = null;
  for (const p of series) {
    if (p.date > d) break;
    v = p.value;
  }
  return v ?? series[0].value;
};

export async function throwbackDashboard(env: Env, opts: { target?: string; nowMs?: number } = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const target = opts.target && /^\d{4}-\d{2}-\d{2}$/.test(opts.target) ? opts.target : targetThursday(today);
  const settings = await loadThrowbackSettings(env);
  const stories = await buildStories(env);
  const all = await gradeAllPosts(env, nowMs);
  const input = stories
    .map((s) => ({ key: s.key, createdAt: s.createdAt, partKeys: s.parts.filter((p) => p.platform !== 'substack').map((p) => ({ platform: p.platform, key: `${p.platform}:${p.id}` })) }))
    .filter((s) => s.partKeys.length);
  const grades = gradeStories(input, all, nowMs, { socialOnly: true });
  const { results: markRows } = await env.DB.prepare('SELECT * FROM bee_throwback_marks ORDER BY created_at').all<Mark>();
  const marks = markRows ?? [];
  const notReshare = new Set(marks.filter((m) => m.kind === 'not_reshare' && m.reuse_anchor).map((m) => m.reuse_anchor as string));
  const never = new Set(marks.filter((m) => m.kind === 'never' && m.orig_anchor).map((m) => m.orig_anchor as string));
  const reuseOf = detectReuses(stories, notReshare);
  const byAnchor = new Map(stories.map((s) => [anchorOf(s), s]));

  // Uses per original.
  const uses = new Map<string, ThrowbackUse[]>();
  const push = (a: string, u: ThrowbackUse) => uses.set(a, [...(uses.get(a) ?? []), u]);
  for (const [reuse, r] of reuseOf) {
    const s = byAnchor.get(reuse);
    if (s) push(r.origAnchor, { date: s.date, source: r.source, reuseAnchor: reuse, reuseHeadline: s.headline, reuseGrade: grades.get(s.key) ?? null });
  }
  for (const m of marks) {
    if (!m.orig_anchor || !m.used_on || (m.kind !== 'manual' && m.kind !== 'planned')) continue;
    // A pick that has since run (detected within ±10 days) is shown once, as the real post.
    if (m.kind === 'planned' && (uses.get(m.orig_anchor) ?? []).some((u) => u.reuseAnchor && Math.abs(dayMs(u.date) - dayMs(m.used_on!)) <= 10 * DAY)) continue;
    push(m.orig_anchor, { date: m.used_on, source: m.kind, markId: m.id });
  }
  for (const list of uses.values()) list.sort((a, b) => b.date.localeCompare(a.date));

  const series = await followerSeries(env);
  const followersNow = series.length ? series[series.length - 1].value : null;

  const fullText = new Map<string, string | null>();
  const { results: texts } = await env.DB.prepare('SELECT platform, id, text FROM bee_meta_posts').all<{ platform: string; id: string; text: string | null }>();
  for (const t of texts ?? []) fullText.set(`${t.platform}:${t.id}`, t.text);

  const candidate = (s: Story): ThrowbackCandidate => {
    const anchor = anchorOf(s);
    const u = uses.get(anchor) ?? [];
    // This Thursday's own pick doesn't bench it — it stays in the list, marked Picked.
    const lastUsed = u.find((x) => !(x.source === 'planned' && x.date === target))?.date ?? null;
    const coolingUntil = lastUsed && settings.cooldownDays > 0 ? addDays(lastUsed, settings.cooldownDays) : null;
    const followersThen = followersOn(series, s.date);
    const newFollowers = followersNow != null && followersThen != null ? Math.max(0, followersNow - followersThen) : null;
    const newShare = newFollowers != null && followersNow ? newFollowers / followersNow : null;
    const grade = grades.get(s.key) ?? null;
    const fb = s.parts.find((p) => p.platform === 'fb');
    const ig = s.parts.find((p) => p.platform === 'ig');
    return {
      anchor,
      date: s.date,
      headline: s.headline,
      grade,
      social: s.social,
      links: s.parts.map((p) => ({ platform: p.platform, url: p.permalink })),
      followersThen,
      newFollowers,
      newShare,
      uses: u,
      lastUsed,
      coolingUntil: coolingUntil && coolingUntil > target ? coolingUntil : null,
      priority: grade?.rank != null ? Math.round(grade.rank * (0.75 + 0.5 * (newShare ?? 0)) * 10) / 10 : null,
      fbText: fb ? throwbackText(fullText.get(`fb:${fb.id}`) ?? fb.headline) : null,
      igText: ig ? throwbackText(fullText.get(`ig:${ig.id}`) ?? ig.headline) : null,
    };
  };

  // Originals: social, graded, settled, not a reshare themselves, not hidden.
  const originals = stories.filter((s) => {
    const a = anchorOf(s);
    if (reuseOf.has(a) || never.has(a)) return false;
    if (!s.parts.some((p) => p.platform !== 'substack')) return false;
    if (s.parts.some((p) => isThrowbackText(p.headline))) return false;
    const g = grades.get(s.key);
    return !!g?.letter && !g.provisional && dayMs(s.date) < dayMs(target) - REUSE_MIN_DAYS * DAY;
  });

  const seasonal: ThrowbackCandidate[] = [];
  for (const s of originals) {
    for (let k = 1; k <= 5; k++) {
      const off = Math.round((dayMs(s.date) - dayMs(yearsBack(target, k))) / DAY);
      if (Math.abs(off) <= settings.windowDays) {
        seasonal.push({ ...candidate(s), yearsAgo: k, daysOff: off });
        break;
      }
    }
  }
  const byRank = (a: ThrowbackCandidate, b: ThrowbackCandidate) => Number(!!a.coolingUntil) - Number(!!b.coolingUntil) || (b.grade?.rank ?? -1) - (a.grade?.rank ?? -1);
  seasonal.sort(byRank);

  const oldEnough = originals.filter((s) => dayMs(s.date) <= dayMs(target) - settings.minAgeDays * DAY).map(candidate);
  const best = oldEnough.filter((c) => !c.coolingUntil).sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
  const coolingCount = oldEnough.length - best.length;

  // Every reuse, newest first — with how the reshare graded vs the original.
  const history = [...uses.entries()]
    .flatMap(([orig, list]) => {
      const o = byAnchor.get(orig);
      return list.map((u) => ({
        ...u,
        origAnchor: orig,
        origHeadline: o?.headline ?? marks.find((m) => m.orig_anchor === orig)?.headline ?? orig,
        origDate: o?.date ?? null,
        origGrade: o ? (grades.get(o.key) ?? null) : null,
      }));
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // Do throwbacks beat other Thursdays? (social grade rank, posted reshares only)
  const reuseKeys = new Set([...reuseOf.keys()]);
  const thursday = stories.filter((s) => new Date(`${s.date}T12:00:00Z`).getUTCDay() === 4 && grades.get(s.key)?.rank != null && !grades.get(s.key)?.provisional);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const tbtRanks = thursday.filter((s) => reuseKeys.has(anchorOf(s))).map((s) => grades.get(s.key)!.rank!);
  const otherRanks = thursday.filter((s) => !reuseKeys.has(anchorOf(s))).map((s) => grades.get(s.key)!.rank!);

  const planned =
    marks
      .filter((m) => m.kind === 'planned' && m.used_on === target && m.orig_anchor)
      .map((m) => ({ markId: m.id, anchor: m.orig_anchor!, headline: byAnchor.get(m.orig_anchor!)?.headline ?? m.headline ?? '' }))[0] ?? null;

  return {
    today,
    target,
    settings,
    followersNow,
    planned,
    // Top picks plus every one still cooling (greyed in the UI, so a recent reshare is visible).
    seasonal: [...seasonal.filter((c) => !c.coolingUntil).slice(0, LIST_LIMIT), ...seasonal.filter((c) => c.coolingUntil)],
    seasonalCount: seasonal.length,
    best: best.slice(0, LIST_LIMIT),
    bestCount: best.length,
    coolingCount,
    hidden: marks.filter((m) => m.kind === 'never').map((m) => ({ markId: m.id, anchor: m.orig_anchor, headline: byAnchor.get(m.orig_anchor ?? '')?.headline ?? m.headline })),
    history,
    stats: { reshares: reuseOf.size, thursdayTbt: { n: tbtRanks.length, avgRank: avg(tbtRanks) }, thursdayOther: { n: otherRanks.length, avgRank: avg(otherRanks) } },
  };
}

// ------------------------------------------------------------------ marks + task

export const THROWBACK_TASK_DEF_ID = 'bee-throwback';

async function headlineFor(env: Env, anchor: string): Promise<string | null> {
  const [platform, ...rest] = anchor.split(':');
  const id = rest.join(':');
  if (platform === 'fb' || platform === 'ig') {
    const r = await env.DB.prepare('SELECT text FROM bee_meta_posts WHERE platform = ? AND id = ?').bind(platform, id).first<{ text: string | null }>();
    return r ? (r.text ?? '').split('\n')[0].trim() || null : null;
  }
  if (platform === 'substack') {
    const r = await env.DB.prepare('SELECT title FROM bee_posts WHERE post_date = ?').bind(id).first<{ title: string }>();
    return r?.title ?? null;
  }
  return null;
}

/** Check off the open Saturday task (a pick was made). */
async function completeThrowbackTask(env: Env) {
  const def = await env.DB.prepare('SELECT current_task_id FROM recurring_task_definitions WHERE id = ?').bind(THROWBACK_TASK_DEF_ID).first<{ current_task_id: string | null }>();
  if (!def?.current_task_id) return false;
  const t = await env.DB.prepare('SELECT id, title, status FROM entities WHERE id = ?').bind(def.current_task_id).first<{ id: string; title: string; status: string }>();
  if (!t || t.status !== 'open') return false;
  const ts = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, t.id),
    env.DB.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), t.id, t.title, ts, easternToday()),
  ]);
  return true;
}

export class MarkError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

/** kind: 'planned' (pick for `date`, a Thursday — replaces that Thursday's pick
 * and checks off the Saturday task), 'manual' (ran again on `date`), 'never',
 * 'not_reshare' (anchor = the post wrongly detected as a reshare). */
export async function addMark(env: Env, body: { kind?: string; anchor?: string; date?: string }) {
  const kind = body.kind;
  if (kind !== 'planned' && kind !== 'manual' && kind !== 'never' && kind !== 'not_reshare') throw new MarkError('kind must be planned, manual, never or not_reshare');
  const anchor = (body.anchor ?? '').trim();
  if (!/^(fb|ig|substack):.+/.test(anchor)) throw new MarkError('anchor required (e.g. fb:<post id>)');
  const headline = await headlineFor(env, anchor);
  if (headline == null) throw new MarkError('post not found', 404);
  let date: string | null = null;
  if (kind === 'planned' || kind === 'manual') {
    date = body.date ?? (kind === 'planned' ? targetThursday() : easternToday());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dayMs(date))) throw new MarkError('date must be YYYY-MM-DD');
  }
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const stmts = [];
  if (kind === 'planned') stmts.push(env.DB.prepare("DELETE FROM bee_throwback_marks WHERE kind = 'planned' AND used_on = ?").bind(date));
  if (kind === 'never') stmts.push(env.DB.prepare("DELETE FROM bee_throwback_marks WHERE kind = 'never' AND orig_anchor = ?").bind(anchor));
  if (kind === 'not_reshare') stmts.push(env.DB.prepare("DELETE FROM bee_throwback_marks WHERE kind = 'not_reshare' AND reuse_anchor = ?").bind(anchor));
  stmts.push(
    env.DB.prepare('INSERT INTO bee_throwback_marks (id, kind, orig_anchor, reuse_anchor, used_on, headline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      kind,
      kind === 'not_reshare' ? null : anchor,
      kind === 'not_reshare' ? anchor : null,
      date,
      headline,
      ts,
    ),
  );
  await env.DB.batch(stmts);
  const taskDone = kind === 'planned' ? await completeThrowbackTask(env) : false;
  return { id, kind, anchor, date, taskDone };
}

export async function deleteMark(env: Env, id: string) {
  const r = await env.DB.prepare('DELETE FROM bee_throwback_marks WHERE id = ?').bind(id).run();
  if (!r.meta.changes) throw new MarkError('mark not found', 404);
  return { ok: true };
}
