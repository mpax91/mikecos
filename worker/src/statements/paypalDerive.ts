import type { Env } from '../types';
import { fmtMdy, fmtMoney, round2 } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, kv, link, para, table, heading } from './vaultDoc';
import { crossCheckPaypal } from './templates/paypal';
import type { PaypalValues } from './templates/paypal';
import { templateById } from './templates';
import { summarizePaypal } from './paypalSummary';
import type { PaypalStmtRow } from './paypalSummary';
import { loadPaypalMatches } from './paypalMatch';
import { syncTaxPacketSection } from './taxPacket';

/** PayPal outputs: Vault entry "PayPal" (one auto note "Account Details"),
 * flags and a Tax Packet line for money received.
 *  - idle:<date>      money left sitting in PayPal at the end of the latest
 *                     statement (attention — withdraw it)
 *  - fee:<id>         PayPal kept a fee on the latest statement (attention)
 *  - price_up:…       a PayPal subscription went up (attention)
 *  - sub_new:<name>   a new subscription on the latest statement (info)
 *  - gap:<YYYY-MM>    a card shows PayPal charges in a month with no PayPal
 *                     statement in Drive (attention while recent). PayPal
 *                     sends nothing for a quiet month, so a missing month is
 *                     only flagged when a card proves there was activity.
 *  - file / dup / check  unreadable / duplicate files, failed math. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

/** A month's statement arrives mid-next-month; give it this long. */
const STATEMENT_GRACE_DAYS = 25;

export async function loadPaypalData(env: Env, folderId: string) {
  const [stmtRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: PaypalStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as PaypalValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckPaypal(i ? stmts[i - 1] : null, s)));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, files };
}

const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

export async function derivePaypal(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('paypal')!;
  const today = easternToday();
  const { stmts, files } = await loadPaypalData(env, folder.id);
  const s = summarizePaypal(stmts, today);
  const latest = stmts[stmts.length - 1] ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;

  let meta: FolderMeta = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    meta = {};
  }
  const entry = await ensureVaultEntry(env, folder.vault_entry_id, template.account.nickname);
  if (entry.id !== folder.vault_entry_id) {
    await env.DB.prepare('UPDATE statement_folders SET vault_entry_id = ?, updated_at = ? WHERE id = ?').bind(entry.id, new Date().toISOString(), folder.id).run();
  }
  if (entry.created) {
    meta.vault = {};
    await seedFacts(env, entry.id, [
      { label: 'Type', value: 'Payment App (pass-through — balance usually $0)' },
      { label: 'Customer Service', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} PayPal statement failed “${c.name}” (${c.detail})` });
    }
  }
  if (latest) {
    if (s.idle) {
      flags.push({
        key: `idle:${s.idle.since}`,
        severity: 'warn',
        message: `${fmtMoney(s.idle.amount)} was sitting in PayPal at the end of the ${fmtMdy(s.idle.since)} statement — withdraw it to the bank`,
      });
    }
    for (const r of latest.values.rows.filter((r) => r.fee !== 0 && r.currency === 'USD')) {
      flags.push({
        key: `fee:${r.id ?? `${r.date}:${r.fee}`}`,
        severity: 'warn',
        message: `PayPal kept a ${fmtMoney(-r.fee)} fee on ${r.name || r.type}’s ${fmtMoney(r.amount)} (${fmtMdy(r.date)})`,
      });
    }
    for (const sub of s.subscriptions) {
      if (sub.change && sub.change.date >= latest.periodStart && sub.change.to > sub.change.from) {
        flags.push({
          key: `price_up:${sub.name}:${sub.change.date}`,
          severity: 'warn',
          message: `${sub.name} (through PayPal) went up: ${fmtMoney(sub.change.from)} → ${fmtMoney(sub.change.to)} (${fmtMdy(sub.change.date)})`,
        });
      }
      if (sub.first >= latest.periodStart && latest.values.rows.some((r) => r.recurring && (r.name || r.type) === sub.name)) {
        flags.push({ key: `sub_new:${sub.name}`, severity: 'info', message: `New subscription through PayPal: ${sub.name} ${fmtMoney(sub.amount)} (${fmtMdy(sub.first)})` });
      }
    }
  }
  // Missing months — only when a card proves there was PayPal activity.
  const match = await loadPaypalMatches(env);
  if (match.paypalFirst) {
    const byMonth = new Map<string, { n: number; total: number; cards: Set<string> }>();
    for (const t of match.unmatchedCard.filter((t) => t.amount > 0)) {
      const ym = t.date.slice(0, 7);
      // A card posts a day or two later — the PayPal row may sit in the previous month.
      const prev = new Date(Date.parse(`${ym}-15T12:00:00Z`) - 30 * 86400000).toISOString().slice(0, 7);
      if (ym < match.paypalFirst.slice(0, 7) || match.paypalMonths.has(ym) || (Number(t.date.slice(8, 10)) <= 5 && match.paypalMonths.has(prev))) continue;
      if (daysBetween(monthEnd(ym), today) < STATEMENT_GRACE_DAYS) continue;
      const cur = byMonth.get(ym) ?? { n: 0, total: 0, cards: new Set<string>() };
      cur.n++;
      cur.total = round2(cur.total + t.amount);
      cur.cards.add(match.cardNames.get(t.folderId) ?? 'a card');
      byMonth.set(ym, cur);
    }
    for (const [ym, g] of byMonth) {
      flags.push({
        key: `gap:${ym}`,
        severity: 'warn',
        message: `${[...g.cards].join(' and ')} show${g.cards.size === 1 ? 's' : ''} ${g.n} PayPal charge${g.n === 1 ? '' : 's'} in ${monthName(ym)} (${fmtMoney(g.total)}) but there’s no PayPal statement for that month in Drive — download it from paypal.com (Statements & Tax Documents)`,
      });
    }
  }
  await syncFlags(env, folder.id, flags);

  // ---- Auto note "Account Details" ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest) {
    const v = latest.values;
    sections.push({
      key: 'latest',
      match: (h) => /^Latest Statement\b/i.test(h),
      heading: `Latest Statement · ${shortMonth(latest.periodEnd)}`,
      blocks: [
        kv([
          ['Paid Out', `${fmtMoney(v.spent)} (stores and people)`],
          ['Received', fmtMoney(v.received)],
          ['Refunds', fmtMoney(v.refunds)],
          ['Withdrawn to Bank', fmtMoney(v.withdrawn)],
          ['PayPal Fees', fmtMoney(v.fees)],
          ['Balance', v.ending !== null ? fmtMoney(v.ending) : 'Not printed on this statement'],
        ]),
      ],
    });
    const active = s.subscriptions.filter((x) => x.active);
    sections.push({
      key: 'subs',
      match: (h) => /^Subscriptions$/i.test(h.trim()),
      heading: 'Subscriptions',
      blocks: active.length
        ? [
            table(
              ['Subscription', 'Amount', 'Last Charge', 'Since'],
              active.map((x) => [x.name, fmtMoney(x.amount), fmtMdy(x.last), shortMonth(x.first)]),
            ),
          ]
        : [para('No active subscriptions through PayPal.')],
    });
    const cutoff = s.last12.from ?? '';
    const recentFunding = s.funding.filter((f) => f.last >= cutoff);
    sections.push({
      key: 'funding',
      match: (h) => /^(How PayPal Is Funded|Funding)$/i.test(h.trim()),
      heading: 'How PayPal Is Funded',
      blocks: [
        recentFunding.length
          ? table(
              ['Source', 'Paid', 'Payments', 'Last Used'],
              recentFunding.map((f) => [f.label, fmtMoney(f.total), String(f.count), fmtMdy(f.last)]),
            )
          : para('Nothing paid through PayPal in the last 12 months.'),
        para('“Card” = a General Credit Card Deposit row — PayPal doesn’t print which card; the Finance dashboard matches it to your card statements.'),
      ],
    });
    sections.push({
      key: 'years',
      match: (h) => /^(Activity|Spend) by Year$/i.test(h.trim()),
      heading: 'Activity by Year',
      blocks: [
        table(
          ['Year', 'Stores', 'People', 'Received', 'Fees'],
          [...s.years].reverse().map((y) => [String(y.year), fmtMoney(y.purchases), fmtMoney(y.payments), fmtMoney(y.received), fmtMoney(y.fees)]),
        ),
        para([
          bold('Since '),
          `${s.firstStatement ? shortMonth(s.firstStatement) : '—'}: ${fmtMoney(s.totals.spent)} paid out, ${fmtMoney(s.totals.received)} received, ${fmtMoney(s.totals.fees)} in PayPal fees.`,
        ]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Statement', 'Paid Out', 'Received', 'Withdrawn', ''],
          [...stmts]
            .reverse()
            .slice(0, 12)
            .map((st) => {
              const url = fileUrl(st.fileId);
              return [shortMonth(st.periodEnd), fmtMoney(st.values.spent), fmtMoney(st.values.received), fmtMoney(st.values.withdrawn), url ? link('View', url) : ''];
            }),
        ),
        para(`PayPal only sends a statement for a month with activity. All ${stmts.length} statements are on the Finance dashboard.`),
      ],
    });
  }
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Provider', template.account.institution],
      ['Type', 'Payment App — money passes through to a card or bank'],
      ['Contact', template.account.site ? [link('paypal.com', template.account.site), ` · ${template.account.phone ?? ''}`] : (template.account.phone ?? '—')],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'PayPal', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();

  // ---- Tax Packet: money received through PayPal (this year and last) ----
  const thisYear = Number(today.slice(0, 4));
  for (const y of s.years.filter((y) => y.year >= thisYear - 1 && y.received > 0)) {
    const rows = s.activity.filter((a) => a.date.startsWith(String(y.year)) && a.cls === 'received' && a.currency === 'USD');
    const byName = new Map<string, { amount: number; fee: number }>();
    for (const r of rows) {
      const cur = byName.get(r.name) ?? { amount: 0, fee: 0 };
      cur.amount = round2(cur.amount + r.amount);
      cur.fee = round2(cur.fee - r.fee);
      byName.set(r.name, cur);
    }
    await syncTaxPacketSection(env, y.year, folder.id, {
      title: 'PayPal',
      blocks: [
        table(
          ['Received From', 'Amount', 'PayPal Fees'],
          [...byName.entries()].map(([name, v]) => [name, fmtMoney(v.amount), fmtMoney(v.fee)]),
        ),
        para(
          `Total ${fmtMoney(round2(rows.reduce((s2, r) => s2 + r.amount, 0)))} received through PayPal in ${y.year}${y.year === thisYear ? ' so far' : ''}. If any of it was payment for goods or services, check Statements & Tax Documents on paypal.com for a Form 1099-K.`,
        ),
      ],
      expected: [],
      links: [],
    });
  }
}
