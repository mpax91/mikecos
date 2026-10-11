import type { Env } from '../types';
import { makeHasher, normalizeNumber } from './ingest';

/** Calls & Texts read side: a contact's numbers are hashed the same way the
 * importer hashed the phone backup, then rolled up. Group-chat messages
 * count toward "in touch" but not toward 1:1 calls/texts. */

export interface ContactComms {
  lastCall: { at: string; kind: string } | null;
  lastText: { at: string; kind: string } | null;
  lastGroupAt: string | null;
  lastTouch: string | null; // newest of call / text / their group message
  months: { month: string; calls: number; texts: number; minutes: number }[]; // last 12, oldest first
  year: {
    callsIn: number;
    callsOut: number;
    callsMissed: number;
    minutes: number;
    textsIn: number;
    textsOut: number;
    groupIn: number;
  };
  activeMonths: number; // of the last 12, months with a 1:1 call or text
  theyStartPct: number | null; // share of 1:1 calls + texts that came from them (12 mo)
  cadence: 'Weekly' | 'Monthly' | 'Every Few Months' | 'Occasional' | 'None This Year';
  groups: { count: number; lastAt: string | null };
  coverage: { textsSince: string | null; chatsSince: string | null };
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const easternMonth = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);

function last12Months(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15));
    out.push(easternMonth(x));
  }
  return [...new Set(out)];
}

export function phonesOf(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw ?? '[]') as unknown[];
    return [...new Set(arr.map((p) => normalizeNumber(typeof p === 'string' ? p : (p as { value?: string })?.value ?? '')).filter((x): x is string => !!x))];
  } catch {
    return [];
  }
}

async function hashesFor(env: Env, phonesJson: string | null | undefined): Promise<string[]> {
  const nums = phonesOf(phonesJson);
  if (!nums.length || !env.CLOUD_ACCOUNT_ENC_KEY) return [];
  const hash = await makeHasher(env);
  return Promise.all(nums.map((n) => hash(n)));
}

export async function commsForContact(env: Env, contact: { phones: string | null }): Promise<ContactComms | null> {
  const settings = await env.DB.prepare('SELECT first_at, sms_wm, mms_wm, last_scan_at FROM comm_settings WHERE id = 1').first<{ first_at: number | null; last_scan_at: string | null }>().catch(() => null);
  if (!settings?.last_scan_at) return null; // feature not running yet
  const hashes = await hashesFor(env, contact.phones);
  if (!hashes.length) return null;
  const ph = hashes.map(() => '?').join(',');
  const months = last12Months();
  const [monthly, lasts, groups] = await env.DB.batch([
    env.DB.prepare(`SELECT month, kind, SUM(n) AS n, SUM(seconds) AS seconds FROM comm_monthly WHERE num_hash IN (${ph}) AND month >= ? GROUP BY month, kind`).bind(...hashes, months[0]),
    env.DB.prepare(`SELECT * FROM comm_last WHERE num_hash IN (${ph})`).bind(...hashes),
    env.DB.prepare(`SELECT COUNT(DISTINCT gm.group_hash) AS count, MAX(g.last_at) AS last_at FROM comm_group_members gm JOIN comm_groups g ON g.group_hash = gm.group_hash WHERE gm.num_hash IN (${ph})`).bind(...hashes),
  ]);
  const mrows = (monthly.results ?? []) as { month: string; kind: string; n: number; seconds: number }[];
  const lrows = (lasts.results ?? []) as { last_call_at: number | null; last_call_kind: string | null; last_text_at: number | null; last_text_kind: string | null; last_group_at: number | null }[];
  const grow = ((groups.results ?? [])[0] ?? { count: 0, last_at: null }) as { count: number; last_at: number | null };
  if (!mrows.length && !lrows.length && !grow.count) {
    return emptyComms(settings.first_at);
  }

  const year = { callsIn: 0, callsOut: 0, callsMissed: 0, minutes: 0, textsIn: 0, textsOut: 0, groupIn: 0 };
  const byMonth = new Map(months.map((m) => [m, { month: m, calls: 0, texts: 0, minutes: 0 }]));
  for (const r of mrows) {
    const b = byMonth.get(r.month);
    if (!b) continue;
    if (r.kind === 'call_in') year.callsIn += r.n;
    if (r.kind === 'call_out') year.callsOut += r.n;
    if (r.kind === 'call_missed') year.callsMissed += r.n;
    if (r.kind === 'text_in') year.textsIn += r.n;
    if (r.kind === 'text_out') year.textsOut += r.n;
    if (r.kind === 'group_in') year.groupIn += r.n;
    if (r.kind.startsWith('call')) {
      b.calls += r.n;
      b.minutes += Math.round(r.seconds / 60);
    } else if (r.kind !== 'group_in') b.texts += r.n;
    year.minutes += r.kind.startsWith('call') ? r.seconds / 60 : 0;
  }
  year.minutes = Math.round(year.minutes);

  let lastCall: ContactComms['lastCall'] = null;
  let lastText: ContactComms['lastText'] = null;
  let lastGroup = 0;
  for (const l of lrows) {
    if (l.last_call_at && (!lastCall || l.last_call_at > Date.parse(lastCall.at))) lastCall = { at: iso(l.last_call_at)!, kind: l.last_call_kind ?? '' };
    if (l.last_text_at && (!lastText || l.last_text_at > Date.parse(lastText.at))) lastText = { at: iso(l.last_text_at)!, kind: l.last_text_kind ?? '' };
    lastGroup = Math.max(lastGroup, l.last_group_at ?? 0);
  }
  const touches = [lastCall?.at, lastText?.at, lastGroup ? iso(lastGroup) : null].filter((x): x is string => !!x).sort();
  const monthList = [...byMonth.values()];
  const activeMonths = monthList.filter((m) => m.calls - 0 > 0 || m.texts > 0).length;
  // Weekly = roughly once a week or more over the last three months.
  const recent3 = monthList.slice(-3).reduce((a, m) => a + m.calls + m.texts, 0);
  const cadence: ContactComms['cadence'] =
    activeMonths === 0 ? 'None This Year' : recent3 >= 12 && activeMonths >= 6 ? 'Weekly' : activeMonths >= 9 ? 'Monthly' : activeMonths >= 4 ? 'Every Few Months' : 'Occasional';
  const theirs = year.callsIn + year.callsMissed + year.textsIn;
  const total = theirs + year.callsOut + year.textsOut;
  return {
    lastCall,
    lastText,
    lastGroupAt: lastGroup ? iso(lastGroup) : null,
    lastTouch: touches.length ? touches[touches.length - 1] : null,
    months: monthList,
    year,
    activeMonths,
    theyStartPct: total >= 5 ? Math.round((theirs / total) * 100) : null,
    cadence,
    groups: { count: grow.count ?? 0, lastAt: iso(grow.last_at) },
    coverage: await coverage(env),
  };
}

function emptyComms(_firstAt: number | null): ContactComms {
  return {
    lastCall: null,
    lastText: null,
    lastGroupAt: null,
    lastTouch: null,
    months: last12Months().map((m) => ({ month: m, calls: 0, texts: 0, minutes: 0 })),
    year: { callsIn: 0, callsOut: 0, callsMissed: 0, minutes: 0, textsIn: 0, textsOut: 0, groupIn: 0 },
    activeMonths: 0,
    theyStartPct: null,
    cadence: 'None This Year',
    groups: { count: 0, lastAt: null },
    coverage: { textsSince: null, chatsSince: null },
  };
}

/** When each stream's history starts: plain texts = oldest text month;
 * chat (RCS / picture) messages = oldest one in the backup's chat block. */
async function coverage(env: Env): Promise<ContactComms['coverage']> {
  const r = await env.DB.prepare(`SELECT MIN(month) AS texts FROM comm_monthly WHERE kind IN ('text_in','text_out')`).first<{ texts: string | null }>();
  const s = await env.DB.prepare('SELECT stats_json FROM comm_settings WHERE id = 1').first<{ stats_json: string | null }>();
  let chats: string | null = null;
  try {
    const at = s?.stats_json ? (JSON.parse(s.stats_json) as { chatsFirstAt?: number }).chatsFirstAt : undefined;
    if (at) chats = easternMonth(new Date(at));
  } catch {
    chats = null;
  }
  return { textsSince: r?.texts ?? null, chatsSince: chats };
}

/** People you used to be in regular touch with who've gone quiet: a 1:1
 * call or text in ≥4 distinct months of the year before the last 60 days,
 * and nothing (calls, texts, their group messages) in the last 60 days.
 * Personal contacts only (voter-roll phone numbers are unreliable). */
export async function goneQuiet(env: Env): Promise<{ id: string; name: string; lastTouch: string | null; activeMonths: number; perMonth: number }[]> {
  const s = await env.DB.prepare('SELECT last_scan_at, mms_done FROM comm_settings WHERE id = 1').first<{ last_scan_at: string | null; mms_done: number }>().catch(() => null);
  if (!s?.last_scan_at || !env.CLOUD_ACCOUNT_ENC_KEY) return [];
  const { results } = await env.DB.prepare(`SELECT id, name, phones FROM contacts WHERE source != 'voter_file' AND phones IS NOT NULL AND phones != '[]'`).all<{ id: string; name: string; phones: string }>();
  const hash = await makeHasher(env);
  const byHash = new Map<string, { id: string; name: string }>();
  for (const c of results ?? []) for (const n of phonesOf(c.phones)) byHash.set(await hash(n), { id: c.id, name: c.name });
  if (!byHash.size) return [];

  const cutoffMs = Date.now() - 60 * 86400000;
  const cutoffMonth = easternMonth(new Date(cutoffMs));
  const startMonth = easternMonth(new Date(cutoffMs - 365 * 86400000));
  const { results: rows } = await env.DB.prepare(
    `SELECT num_hash, COUNT(DISTINCT month) AS months, SUM(n) AS n FROM comm_monthly
      WHERE kind != 'group_in' AND month >= ? AND month < ? GROUP BY num_hash HAVING COUNT(DISTINCT month) >= 4`
  ).bind(startMonth, cutoffMonth).all<{ num_hash: string; months: number; n: number }>();
  const { results: lasts } = await env.DB.prepare('SELECT num_hash, MAX(COALESCE(last_call_at,0), COALESCE(last_text_at,0), COALESCE(last_group_at,0)) AS last FROM comm_last').all<{ num_hash: string; last: number }>();
  const lastBy = new Map((lasts ?? []).map((l) => [l.num_hash, l.last]));

  // Combine a contact's numbers.
  const agg = new Map<string, { id: string; name: string; months: number; n: number; last: number }>();
  for (const r of rows ?? []) {
    const c = byHash.get(r.num_hash);
    if (!c) continue;
    const a = agg.get(c.id) ?? { ...c, months: 0, n: 0, last: 0 };
    a.months = Math.max(a.months, r.months);
    a.n += r.n;
    agg.set(c.id, a);
  }
  for (const [h, c] of byHash) {
    const a = agg.get(c.id);
    if (a) a.last = Math.max(a.last, lastBy.get(h) ?? 0);
  }
  return [...agg.values()]
    .filter((a) => a.last && a.last < cutoffMs)
    .sort((a, b) => b.n - a.n)
    .map((a) => ({ id: a.id, name: a.name, lastTouch: iso(a.last), activeMonths: a.months, perMonth: Math.round((a.n / 12) * 10) / 10 }));
}
