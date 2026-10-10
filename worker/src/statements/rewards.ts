import type { Env } from '../types';
import { round2, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { loadFolder } from './engine';
import type { AmexCardSummary } from './amexCardSummary';
import type { AmazonSummary } from './amazonSummary';
import type { BofaCardSummary } from './bofaCardSummary';

/** Card rewards in one shape, whatever the card pays in (Amex Reward
 * Dollars are $1 each, Chase points are 100 per $1). Every credit-card
 * template builds one from its summary (`rewardsFromAmexCard`,
 * `rewardsFromAmazon`) and stores it as the folder's `meta.rewards`;
 * engine.derive then runs `syncRedeemReminder`. The Finance overview and
 * `GET /api/statements/rewards` add them up across cards. All money is in
 * dollars; "calendar year" = the year of the statement's closing date. */

export interface RewardsYear {
  year: number;
  statements: number;
  earned: number; // $
  net: number; // purchases − refunds, $
  rate: number | null; // earned ÷ net, percent
  /** The year's total is short or estimated: fewer than 12 statements (a
   * first / current year, or months missing from Drive) or a month whose
   * earnings couldn't be worked out. */
  partial: boolean;
  current: boolean;
}

export interface CardRewards {
  unit: 'dollars' | 'points';
  unitLabel: string; // "Reward Dollars" | "Points"
  pointsPerDollar: number; // 1 for dollars, 100 for Chase points
  available: number | null; // $
  availablePoints: number | null; // in the card's own unit
  asOf: string | null;
  earnedAllTime: number; // $
  redeemedAllTime: number; // $
  earnedYtd: number; // $
  rate12: number | null; // percent back, last 12 statements
  since: string | null; // first statement closing date
  years: RewardsYear[];
}

/** Default "remind me to redeem" threshold, in dollars (Settings →
 * Statements → the card → Redeem Reminder At; 0 turns it off). */
export const DEFAULT_REDEEM_AT = 50;

export interface CardRewardsSettings {
  redeemAt: number;
}

export function cardRewardsSettings(row: Pick<FolderRow, 'settings_json'>): CardRewardsSettings {
  let s: Partial<CardRewardsSettings> = {};
  try {
    s = row.settings_json ? JSON.parse(row.settings_json) : {};
  } catch {
    s = {};
  }
  const n = Number(s.redeemAt);
  return { redeemAt: Number.isFinite(n) && n >= 0 ? n : DEFAULT_REDEEM_AT };
}

const thisYear = (today: string) => Number(today.slice(0, 4));

export function rewardsFromAmexCard(s: AmexCardSummary, today: string): CardRewards {
  const cy = thisYear(today);
  const estimatedYears = new Set(s.statements.filter((r) => r.rewardsEarned === null || r.rewardsBridged).map((r) => Number(r.closingDate.slice(0, 4))));
  const first = s.years[0]?.year;
  return {
    unit: 'dollars',
    unitLabel: 'Reward Dollars',
    pointsPerDollar: 1,
    available: s.rewardDollars,
    availablePoints: s.rewardDollars,
    asOf: s.rewardDollarsAsOf,
    earnedAllTime: s.lifetimeRewardsEarned,
    redeemedAllTime: s.lifetimeRewardsRedeemed,
    earnedYtd: s.ytdRewardsEarned,
    rate12: s.rewardRate,
    since: s.firstStatement,
    years: s.years.map((y) => {
      // The first year also carries the balance the first statement showed
      // (earned before the earliest statement in Drive), like the lifetime total.
      const opening = y.year === first ? (s.rewards[0]?.balance ?? 0) : 0;
      const earned = round2(y.rewardsEarned + opening);
      return {
        year: y.year,
        statements: y.statements,
        earned,
        net: y.net,
        rate: y.net > 0 ? round2((earned / y.net) * 100) : null,
        partial: y.statements < 12 || estimatedYears.has(y.year),
        current: y.year === cy,
      };
    }),
  };
}

export function rewardsFromAmazon(s: AmazonSummary, today: string): CardRewards {
  const cy = thisYear(today);
  const missing = new Set(s.statements.filter((r) => r.pointsEarned === null).map((r) => Number(r.closingDate.slice(0, 4))));
  return {
    unit: 'points',
    unitLabel: 'Points',
    pointsPerDollar: 100,
    available: s.pointsValue,
    availablePoints: s.pointsBalance,
    asOf: s.pointsAsOf,
    earnedAllTime: round2(s.lifetimePointsEarned / 100),
    redeemedAllTime: round2(s.lifetimePointsRedeemed / 100),
    earnedYtd: round2(s.ytdPointsEarned / 100),
    rate12: s.rewardRate,
    since: s.firstStatement,
    years: s.years.map((y) => {
      const earned = round2(y.pointsEarned / 100);
      return {
        year: y.year,
        statements: y.statements,
        earned,
        net: y.net,
        rate: y.net > 0 ? round2((earned / y.net) * 100) : null,
        partial: y.statements < 12 || missing.has(y.year),
        current: y.year === cy,
      };
    }),
  };
}

/** Bank of America prints each month's cash back exactly; only months
 * missing from Drive (not quiet no-activity months) are bridged estimates. */
export function rewardsFromBofaCard(s: BofaCardSummary, today: string): CardRewards {
  const cy = thisYear(today);
  return {
    unit: 'dollars',
    unitLabel: 'Cash Back',
    pointsPerDollar: 1,
    available: s.cashBackAvailable,
    availablePoints: s.cashBackAvailable,
    asOf: s.cashBackAsOf,
    earnedAllTime: s.lifetimeCashBackEarned,
    redeemedAllTime: s.lifetimeCashBackRedeemed,
    earnedYtd: s.ytdCashBackEarned,
    rate12: s.rewardRate,
    since: s.firstStatement,
    years: s.years.map((y) => ({
      year: y.year,
      statements: y.statements,
      earned: y.cashBackEarned,
      net: y.net,
      rate: y.net > 0 ? round2((y.cashBackEarned / y.net) * 100) : null,
      partial: y.estimated || (y.statements < 12 && (y.year === cy || y.year === s.years[0]?.year)),
      current: y.year === cy,
    })),
  };
}

// ---- Across cards (Finance) ----

export interface RewardsCardLine {
  folderId: string;
  name: string;
  owner: FolderRow['owner'];
  rewards: CardRewards;
  redeemAt: number;
}

export interface RewardsOverview {
  available: number;
  earnedAllTime: number;
  redeemedAllTime: number;
  earnedYtd: number;
  /** Every calendar year any card earned in, newest first, with each card's share. */
  years: { year: number; earned: number; net: number; rate: number | null; partial: boolean; current: boolean; byCard: { folderId: string; earned: number }[] }[];
  cards: RewardsCardLine[];
}

export function combineRewards(cards: RewardsCardLine[]): RewardsOverview {
  const years = new Map<number, RewardsOverview['years'][number]>();
  for (const c of cards) {
    for (const y of c.rewards.years) {
      const cur = years.get(y.year) ?? { year: y.year, earned: 0, net: 0, rate: null, partial: false, current: y.current, byCard: [] };
      cur.earned = round2(cur.earned + y.earned);
      cur.net = round2(cur.net + y.net);
      cur.partial = cur.partial || y.partial;
      cur.byCard.push({ folderId: c.folderId, earned: y.earned });
      years.set(y.year, cur);
    }
  }
  // A year is only "partial" overall when a card that existed all year is
  // short — a card opened mid-year isn't missing anything.
  for (const y of years.values()) {
    y.rate = y.net > 0 ? round2((y.earned / y.net) * 100) : null;
    y.partial = cards.some((c) => {
      const cy = c.rewards.years.find((x) => x.year === y.year);
      if (!cy || !cy.partial) return false;
      const firstYear = c.rewards.years[0]?.year;
      return cy.current || cy.year !== firstYear || cy.statements >= 12;
    });
  }
  const sum = (f: (c: RewardsCardLine) => number | null) => round2(cards.reduce((s, c) => s + (f(c) ?? 0), 0));
  return {
    available: sum((c) => c.rewards.available),
    earnedAllTime: sum((c) => c.rewards.earnedAllTime),
    redeemedAllTime: sum((c) => c.rewards.redeemedAllTime),
    earnedYtd: sum((c) => c.rewards.earnedYtd),
    years: [...years.values()].sort((a, b) => b.year - a.year),
    cards,
  };
}

// ---- "Redeem your rewards" reminder ----

/** Folder `meta.redeemTask`: the open reminder task, or (taskId null) a
 * quiet period after Mike closed or deleted one without the balance
 * dropping — the next reminder waits until another `redeemAt` dollars have
 * piled up. Dropping below the threshold (a redemption showed up on a
 * statement) resets it. */
export interface RedeemTaskState {
  taskId: string | null;
  amount: number;
  quietUntil?: number;
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export function redeemTaskTitle(name: string, r: CardRewards): string {
  const what = r.unit === 'points' ? `${Math.round(r.availablePoints ?? 0).toLocaleString('en-US')} Points (${fmtMoney(r.available ?? 0)})` : `${fmtMoney(r.available ?? 0)} Cash Back`;
  return `Redeem ${name} ${what}`;
}

/** Pure decision, unit-tested through the derive: what to do with the
 * reminder given the current balance, threshold and stored state. */
export function decideRedeem(
  available: number | null,
  redeemAt: number,
  state: RedeemTaskState | undefined,
  task: { status: string | null } | null
): { action: 'none' | 'create' | 'update' | 'complete' | 'delete'; state: RedeemTaskState | undefined } {
  const want = redeemAt > 0 && available !== null && available >= redeemAt - 0.005;
  const open = task && task.status !== 'done';
  if (open && state?.taskId) {
    if (want) return { action: 'update', state: { taskId: state.taskId, amount: available! } };
    // Below the threshold → a redemption landed: check it off. Turned off → remove it.
    return { action: redeemAt > 0 && available !== null ? 'complete' : 'delete', state: undefined };
  }
  let st = state;
  // Mike checked it off or deleted it while the balance was still up there
  // (he may have redeemed — statements lag a month): go quiet.
  if (st?.taskId) st = { taskId: null, amount: st.amount, quietUntil: round2(st.amount + Math.max(redeemAt, 1)) };
  if (!want) return { action: 'none', state: undefined };
  if (st?.quietUntil !== undefined && available! < st.quietUntil - 0.005) return { action: 'none', state: st };
  return { action: 'create', state: { taskId: null, amount: available! } };
}

export async function syncRedeemReminder(env: Env, folderId: string, today: string): Promise<void> {
  const folder = await loadFolder(env, folderId);
  if (!folder) return;
  let meta: { rewards?: CardRewards; redeemTask?: RedeemTaskState; rewardsName?: string } = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    return;
  }
  if (!meta.rewards && !meta.redeemTask) return;
  const r = meta.rewards;
  const name = meta.rewardsName ?? folder.folder_name;
  const { redeemAt } = cardRewardsSettings(folder);
  const task = meta.redeemTask?.taskId
    ? await env.DB.prepare('SELECT id, status, title FROM entities WHERE id = ?').bind(meta.redeemTask.taskId).first<{ id: string; status: string | null; title: string }>()
    : null;
  const d = decideRedeem(folder.status === 'live' ? (r?.available ?? null) : null, folder.status === 'live' ? redeemAt : 0, meta.redeemTask, task);
  const ts = nowIso();
  if (d.action === 'update' && task && r) {
    const title = redeemTaskTitle(name, r);
    if (title !== task.title) await env.DB.prepare('UPDATE entities SET title = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(title, title, ts, task.id).run();
  } else if (d.action === 'complete' && task) {
    await env.DB.prepare(`UPDATE entities SET status = 'done', updated_at = ? WHERE id = ?`).bind(ts, task.id).run();
    await env.DB.prepare('INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)').bind(uid(), task.id, task.title, ts, today).run();
  } else if (d.action === 'delete' && task) {
    await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(task.id).run();
  } else if (d.action === 'create' && r && d.state) {
    const id = uid();
    const title = redeemTaskTitle(name, r);
    await env.DB.prepare(
      `INSERT INTO entities (id, type, title, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'task', ?, ?, 0, 'open', 0, ?, ?, ?, ?, ?)`
    )
      .bind(id, title, folder.vault_entry_id, today, ts, ts, ts, title)
      .run();
    d.state.taskId = id;
  }
  const before = JSON.stringify(meta.redeemTask ?? null);
  if (JSON.stringify(d.state ?? null) === before) return;
  if (d.state) meta.redeemTask = d.state;
  else delete meta.redeemTask;
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
