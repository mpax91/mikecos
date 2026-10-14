import type { Env } from '../types';
import { gradeAllPosts } from './grades';
import { assignGrades, engagementFor, GRADE_ORDER, isPaidType, medianRatio } from './engagement';
import type { Engagement } from './engagement';
import type { SubscriberStats } from './ingest';
import { loadBeeSettings } from './ingest';
import { loadStripe, moneyByYear, stripeBalance } from './money';
import { BEE_TASK_DEF_ID, missingExports } from './reminder';

/** GET /api/bee/substack — everything the Substack part of the Bedford Bee
 * dashboard shows, computed from the stored exports. */

interface PostRow {
  post_date: string;
  title: string;
  sent: number | null;
  delivered: number | null;
  opens: number | null;
  opened: number | null;
  open_rate: number | null;
  opens_day7: number | null;
  opens_day28: number | null;
  clicks: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  restacks: number | null;
  signups: number | null;
  subscribes: number | null;
  upgrades: number | null;
  unsubscribes: number | null;
}

export interface SubscriberRow {
  email: string;
  name: string | null;
  type: string | null;
  start_date: string | null;
  first_paid_date: string | null;
  cancel_date: string | null;
  expiration_date: string | null;
  stripe_plan: string | null;
  revenue: number | null;
  source_free: string | null;
  source_paid: string | null;
  state: string | null;
  stats_json: string | null;
  active: number;
  left_date: string | null;
  contact_id: string | null;
}

export interface SpotlightPerson extends Engagement {
  email: string;
  name: string | null;
  contactId: string | null;
  type: string | null;
  paid: boolean;
  opened6mo: number | null;
  seen6mo: number | null;
  received6mo: number | null;
  clicks: number | null;
  shares: number | null;
  comments: number | null;
  daysActive30d: number | null;
  lastOpen: string | null;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const parseStats = (j: string | null): SubscriberStats => (j ? JSON.parse(j) : {}) as SubscriberStats;
const isAuthor = (s: SubscriberRow) => /^author$/i.test((s.type ?? '').trim());

/** Group raw Substack source strings into channels Mike thinks in. */
export function sourceChannel(raw: string | null): string {
  const s = (raw ?? '').toLowerCase().trim();
  if (!s) return 'Unknown';
  if (s.includes('facebook') || s === 'fb') return 'Facebook';
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('twitter') || s === 't.co' || s.includes('x.com')) return 'X / Twitter';
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('nextdoor')) return 'Nextdoor';
  if (s.includes('thebedfordbee.com')) return 'Bedford Bee Website';
  if (/google|duckduckgo|bing|yahoo|ecosia|brave/.test(s) && !s.startsWith('substack')) return 'Search Engines';
  if (s === 'direct') return 'Direct';
  if (s === 'import' || s === 'contributor') return 'Imported / Added';
  if (s === 'share' || s.includes('gift') || s.includes('referral')) return 'Shares & Referrals';
  if (s.startsWith('substack') || s.includes('substack.com') || s.includes('app') || s.includes('reader') || s.includes('recommend') || s.includes('notes')) return 'Substack Network';
  if (s.startsWith('post-') || s.startsWith('email-') || s.includes('cta') || s.includes('prompt') || s.includes('upsell') || s.includes('checkout') || s === 'pledge')
    return 'Substack Prompts';
  return 'Other';
}

export function spotlightFor(subs: SubscriberRow[]): { median: number; people: Map<string, SpotlightPerson> } {
  const active = subs.filter((s) => s.active && !isAuthor(s));
  const stats = new Map(active.map((s) => [s.email, parseStats(s.stats_json)]));
  const med = medianRatio([...stats.values()]);
  const people = new Map<string, SpotlightPerson>();
  for (const s of active) {
    const st = stats.get(s.email)!;
    people.set(s.email, {
      ...engagementFor(s.email, st, med),
      email: s.email,
      name: s.name,
      contactId: s.contact_id,
      type: s.type,
      paid: isPaidType(s.type),
      opened6mo: st.opened6mo,
      seen6mo: st.seen6mo,
      received6mo: st.received6mo,
      clicks: st.clicks,
      shares: st.shares,
      comments: st.comments,
      daysActive30d: st.daysActive30d,
      lastOpen: st.lastOpen,
    });
  }
  assignGrades([...people.values()]);
  return { median: med, people };
}

export async function loadSubscribers(env: Env): Promise<SubscriberRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM bee_subscribers ORDER BY start_date').all<SubscriberRow>();
  return results ?? [];
}

export async function substackDashboard(env: Env) {
  const today = easternToday();
  const settings = await loadBeeSettings(env);
  const { results: fileRows } = await env.DB.prepare('SELECT * FROM bee_files ORDER BY export_date DESC, file_name').all<{
    file_id: string;
    file_name: string;
    kind: string;
    export_date: string | null;
    status: string;
    error: string | null;
    row_count: number | null;
    web_url: string | null;
  }>();
  const files = (fileRows ?? []).map((f) => ({ fileId: f.file_id, name: f.file_name, kind: f.kind, exportDate: f.export_date, status: f.status, error: f.error, rows: f.row_count, url: f.web_url }));
  const asOf = (kind: string) => files.filter((f) => f.kind === kind && f.status === 'parsed').map((f) => f.exportDate ?? '').sort().pop() || null;

  // ---- Monthly export reminder state
  const def = await env.DB.prepare('SELECT rrule, active, current_task_id FROM recurring_task_definitions WHERE id = ?').bind(BEE_TASK_DEF_ID).first<{
    rrule: string;
    active: number;
    current_task_id: string | null;
  }>();
  let exportTask: { taskId: string; dueDate: string; status: string; missing: string[] } | null = null;
  if (def?.current_task_id) {
    const t = await env.DB.prepare('SELECT id, status, due_date FROM entities WHERE id = ?').bind(def.current_task_id).first<{ id: string; status: string; due_date: string | null }>();
    if (t?.due_date) exportTask = { taskId: t.id, dueDate: t.due_date, status: t.status, missing: t.status === 'open' ? await missingExports(env, t.due_date) : [] };
  }
  const dayOfMonth = Number(def?.rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? 1);

  // ---- Posts
  const { results: postRows } = await env.DB.prepare('SELECT * FROM bee_posts ORDER BY post_date DESC').all<PostRow>();
  const postGrades = await gradeAllPosts(env);
  const posts = (postRows ?? []).map((p) => {
    const emailed = (p.sent ?? 0) > 0;
    return {
      date: p.post_date,
      title: p.title,
      emailed,
      sent: p.sent ?? 0,
      delivered: p.delivered ?? 0,
      opened: p.opened ?? 0,
      opens: p.opens ?? 0,
      openRate: emailed && p.delivered ? (p.opened ?? 0) / p.delivered : null,
      ratio: emailed && p.opened ? (p.opens ?? 0) / p.opened : null,
      opensDay7: p.opens_day7,
      opensDay28: p.opens_day28,
      clicks: p.clicks ?? 0,
      views: p.views ?? 0,
      likes: p.likes ?? 0,
      comments: p.comments ?? 0,
      shares: p.shares ?? 0,
      restacks: p.restacks ?? 0,
      signups: p.signups ?? 0,
      paid: (p.subscribes ?? 0) + (p.upgrades ?? 0),
      unsubscribes: p.unsubscribes ?? 0,
      grade: postGrades.posts.get(`substack:${p.post_date}`) ?? null,
    };
  });
  const emailed = posts.filter((p) => p.emailed && p.delivered >= 10);
  const postMedians = {
    openRate: median(emailed.map((p) => p.openRate!)),
    ratio: median(emailed.map((p) => p.ratio ?? 0).filter((r) => r > 0)),
    views: median(posts.map((p) => p.views)),
    recentOpenRate: median(emailed.slice(0, 10).map((p) => p.openRate!)),
  };

  // ---- Subscribers
  const subsAll = await loadSubscribers(env);
  const subs = subsAll.filter((s) => !isAuthor(s));
  const active = subs.filter((s) => s.active);
  const paidActive = active.filter((s) => isPaidType(s.type));
  const byType = new Map<string, number>();
  for (const s of active) byType.set(s.type ?? 'Unknown', (byType.get(s.type ?? 'Unknown') ?? 0) + 1);
  const firstExport = asOf('subscribers') ? (await env.DB.prepare('SELECT MIN(export_date) AS d FROM bee_subscriber_snapshots').first<{ d: string | null }>())?.d ?? null : null;

  // Growth: +1 on each start date, −1 when they left (known from export
  // diffs). Paid: +1 on the first paid date, −1 once a cancelled plan has
  // expired or the person left.
  const events: { date: string; total: number; paid: number }[] = [];
  for (const s of subs) {
    const start = day(s.start_date);
    if (start) events.push({ date: start, total: 1, paid: 0 });
    if (!s.active && s.left_date) events.push({ date: s.left_date, total: -1, paid: 0 });
    const fp = day(s.first_paid_date);
    if (fp) {
      events.push({ date: fp, total: 0, paid: 1 });
      const exp = day(s.expiration_date);
      // Left the list, or still here but no longer paid (cancelled and
      // expired, or now Free) — ended at expiry, else the cancel date.
      const ended =
        !s.active && s.left_date
          ? s.left_date
          : s.active && !isPaidType(s.type)
            ? (exp && exp <= today ? exp : day(s.cancel_date) ?? today)
            : s.cancel_date && exp && exp <= today
              ? exp
              : null;
      if (ended) events.push({ date: ended, total: 0, paid: -1 });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  const growth: { date: string; total: number; paid: number }[] = [];
  let tot = 0;
  let pd = 0;
  for (const e of events) {
    tot += e.total;
    pd += e.paid;
    const last = growth[growth.length - 1];
    if (last && last.date === e.date) {
      last.total = tot;
      last.paid = pd;
    } else growth.push({ date: e.date, total: tot, paid: pd });
  }
  if (growth.length && growth[growth.length - 1].date < today) growth.push({ date: today, total: tot, paid: pd });

  // Gained & lost by month.
  const months = new Map<string, { month: string; freeJoined: number; paidJoined: number; upgrades: number; left: number; cancelled: number }>();
  const m = (iso: string) => months.get(iso.slice(0, 7)) ?? (months.set(iso.slice(0, 7), { month: iso.slice(0, 7), freeJoined: 0, paidJoined: 0, upgrades: 0, left: 0, cancelled: 0 }), months.get(iso.slice(0, 7))!);
  for (const s of subs) {
    const start = day(s.start_date);
    const fp = day(s.first_paid_date);
    if (start) {
      if (fp && fp <= addDays(start, 1)) m(start).paidJoined++;
      else m(start).freeJoined++;
    }
    if (fp && start && fp > addDays(start, 1)) m(fp).upgrades++;
    if (!s.active && s.left_date) m(s.left_date).left++;
    if (s.cancel_date) m(s.cancel_date).cancelled++;
  }
  const monthList = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));

  // Sources (current subscribers).
  const tally = (pick: (s: SubscriberRow) => string | null, list: SubscriberRow[]) => {
    const out = new Map<string, { channel: string; count: number; paid: number; raw: Map<string, number> }>();
    for (const s of list) {
      const raw = pick(s);
      const ch = sourceChannel(raw);
      const row = out.get(ch) ?? (out.set(ch, { channel: ch, count: 0, paid: 0, raw: new Map() }), out.get(ch)!);
      row.count++;
      if (isPaidType(s.type)) row.paid++;
      row.raw.set(raw ?? '—', (row.raw.get(raw ?? '—') ?? 0) + 1);
    }
    return [...out.values()]
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ channel: r.channel, count: r.count, paid: r.paid, raw: [...r.raw.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })) }));
  };

  // Spotlight.
  const { median: medRatio, people } = spotlightFor(subsAll);
  const everyone = [...people.values()];
  const forwarders = everyone.filter((p) => p.forwarder).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  const byOpens = (a: (typeof everyone)[number], b: (typeof everyone)[number]) =>
    (GRADE_ORDER[a.grade ?? ''] ?? 9) - (GRADE_ORDER[b.grade ?? ''] ?? 9) || (b.readShare ?? -1) - (a.readShare ?? -1) || (b.ratio ?? 0) - (a.ratio ?? 0) || b.score - a.score;
  const readers = [...everyone].sort(byOpens);
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0, new: 0 };
  for (const p of everyone) grades[p.grade ?? 'new']++;
  const superfans = everyone.filter((p) => p.superfan).sort(byOpens);
  const upgradeCandidates = superfans.filter((p) => !p.paid);
  const dormant = {
    neverOpened: everyone.filter((p) => (p.received6mo ?? 0) >= 3 && !p.seen6mo).length,
    quiet30d: active.filter((s) => {
      const st = parseStats(s.stats_json);
      return (st.received6mo ?? 0) >= 3 && !st.opened30d;
    }).length,
  };

  // Renewals: paid plans by expiration date.
  const renewals = paidActive
    .filter((s) => s.expiration_date && !/never/i.test(s.expiration_date))
    .map((s) => ({ email: s.email, name: s.name, contactId: s.contact_id, type: s.type, plan: s.stripe_plan, expires: day(s.expiration_date)!, cancelled: !!s.cancel_date }))
    .sort((a, b) => a.expires.localeCompare(b.expires));

  // ---- Money
  const txns = await loadStripe(env);
  const moneyYears = moneyByYear(txns);
  const charges = txns
    .filter((t) => /^(charge|payment|refund|payment_refund)$/i.test(t.type))
    .reverse()
    .map((t) => ({ id: t.id, date: t.created.slice(0, 10), type: t.type, description: t.description, amount: t.amount, fee: t.fee, net: t.net, payoutDate: day(t.transfer_date) }));
  const payouts = txns
    .filter((t) => t.type === 'payout')
    .reverse()
    .map((t) => ({ id: t.id, date: t.created.slice(0, 10), amount: -t.amount }));

  // ---- Year in review
  const yearsSet = new Set<number>([...posts.map((p) => Number(p.date.slice(0, 4))), ...moneyYears.map((y) => y.year), ...subs.map((s) => Number((s.start_date ?? '0').slice(0, 4))).filter((y) => y > 2000)]);
  const yearReview = [...yearsSet]
    .sort((a, b) => b - a)
    .map((year) => {
      const ys = `${year}-01-01`;
      const ye = `${year}-12-31`;
      const end = ye < today ? ye : today;
      const yp = posts.filter((p) => p.date.startsWith(String(year)));
      const ye_ = yp.filter((p) => p.emailed);
      const sent = ye_.reduce((n, p) => n + p.sent, 0);
      const delivered = ye_.reduce((n, p) => n + p.delivered, 0);
      const opened = ye_.reduce((n, p) => n + p.opened, 0);
      const opens = ye_.reduce((n, p) => n + p.opens, 0);
      const alive = (s: SubscriberRow, at: string, inclusive: boolean) => {
        const start = day(s.start_date);
        if (!start || (inclusive ? start > at : start >= at)) return false;
        return s.active || !s.left_date || s.left_date > at;
      };
      const isPaidAt = (s: SubscriberRow, at: string) => {
        const fp = day(s.first_paid_date);
        if (!fp || fp > at || !alive(s, at, true)) return false;
        if (at >= today) return s.active === 1 && isPaidType(s.type); // today: the export's own word
        const exp = day(s.expiration_date);
        return !(s.cancel_date && exp && exp <= at);
      };
      const money = moneyYears.find((y) => y.year === year);
      const top = (score: (p: (typeof posts)[number]) => number) =>
        [...ye_]
          .filter((p) => p.delivered >= 20)
          .sort((a, b) => score(b) - score(a))
          .slice(0, 5)
          .map((p) => ({ date: p.date, title: p.title, openRate: p.openRate, ratio: p.ratio, opens: p.opens }));
      return {
        year,
        partial: end !== ye,
        posts: yp.length,
        emailedPosts: ye_.length,
        sent,
        delivered,
        opened,
        opens,
        openRate: delivered ? opened / delivered : null,
        clicks: ye_.reduce((n, p) => n + p.clicks, 0),
        views: yp.reduce((n, p) => n + p.views, 0),
        likes: yp.reduce((n, p) => n + p.likes, 0),
        comments: yp.reduce((n, p) => n + p.comments, 0),
        unsubscribes: yp.reduce((n, p) => n + p.unsubscribes, 0),
        subsStart: subs.filter((s) => alive(s, ys, false)).length,
        subsEnd: subs.filter((s) => alive(s, end, true)).length,
        paidStart: subs.filter((s) => isPaidAt(s, addDays(ys, -1))).length,
        paidEnd: subs.filter((s) => isPaidAt(s, end)).length,
        freeGained: subs.filter((s) => (s.start_date ?? '').startsWith(String(year))).length,
        paidGained: subs.filter((s) => (s.first_paid_date ?? '').startsWith(String(year))).length,
        lost: subs.filter((s) => !s.active && (s.left_date ?? '').startsWith(String(year))).length,
        gross: money?.gross ?? 0,
        net: money?.net ?? 0,
        topByOpenRate: top((p) => p.openRate ?? 0),
        topByForward: top((p) => p.ratio ?? 0),
      };
    });

  return {
    today,
    settings: { folderName: settings.folder_name, folderUrl: settings.folder_url, lastScanAt: settings.last_scan_at, lastError: settings.last_error },
    asOf: { posts: asOf('posts'), subscribers: asOf('subscribers'), stripe: asOf('stripe') },
    firstSubscriberExport: firstExport,
    files,
    exportTask,
    reminder: { active: !!def?.active, dayOfMonth },
    list: {
      total: active.length,
      free: active.filter((s) => !isPaidType(s.type)).length,
      paid: paidActive.length,
      byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      left: subs.filter((s) => !s.active).length,
      joined30d: active.filter((s) => (day(s.start_date) ?? '') > addDays(today, -30)).length,
    },
    growth,
    months: monthList,
    sources: { free: tally((s) => s.source_free, active), paid: tally((s) => s.source_paid, paidActive) },
    posts,
    postMedians,
    spotlight: { medianRatio: medRatio, grades, readers, forwarders, superfans, upgradeCandidates, dormant },
    renewals,
    // Every subscriber ever (incl. people who left) with the dates the
    // dashboard filters by — the page computes any date range from these.
    people: subs.map((s) => {
      const start = day(s.start_date);
      const fp = day(s.first_paid_date);
      return {
        email: s.email,
        name: s.name,
        contactId: s.contact_id,
        type: s.type,
        active: !!s.active,
        paidNow: !!s.active && isPaidType(s.type),
        start,
        firstPaid: fp,
        upgraded: !!(fp && start && fp > addDays(start, 1)),
        left: !s.active ? s.left_date : null,
        cancelled: day(s.cancel_date),
        expires: day(s.expiration_date),
        source: sourceChannel(s.source_free),
        sourceRaw: s.source_free,
        paidSource: fp ? sourceChannel(s.source_paid) : null,
      };
    }),
    money: { years: moneyYears, balance: stripeBalance(txns), charges, payouts },
    years: yearReview,
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
