import { fmtMdy, fmtMoney } from './common';
import { merchantOf } from './amazonSummary';

/** Shared "something looks off" rules (Mike, 2026-10-08), written once and
 * used by every template that has bills or card activity. Tuned to stay
 * quiet: each rule was backtested against the 12 years of Amazon Prime Visa
 * history and fires on none of it.
 *
 *  high_bill   a bill ≥ 25% AND ≥ $15 above the median of the prior 12,
 *              higher than every one of them, and (once there's 2 years of
 *              history) ≥ 25% above the same month last year — so seasonal
 *              bills don't flag every winter. Needs 6+ prior bills.
 *  dup_charge  the same card charge (identical description — Amazon
 *              orders include the order number — and amount, $10+) posted
 *              twice within a day. (A looser 3-day / any-amount rule hit 80
 *              everyday coffees and pharmacy runs in the history.)
 *  price_up    a subscription-like charge — same merchant exactly once in
 *              each of the 3 previous statements at the same amount — that
 *              went up by ≥ $1 and ≥ 5% on the latest statement.
 *
 * Their keys are "attention" keys (attention.ts), so they count toward the
 * Finance badge and strip. */

export interface Flag {
  key: string;
  severity: 'warn' | 'info';
  message: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** Bills oldest first: `amount` is what the bill charged for its period. */
export function highBillFlag(account: string, bills: { date: string; amount: number }[]): Flag | null {
  if (bills.length < 7) return null;
  const latest = bills[bills.length - 1];
  const prior = bills.slice(-13, -1).map((b) => b.amount);
  const usual = median(prior);
  if (latest.amount < usual * 1.25 || latest.amount - usual < 15) return null;
  if (latest.amount <= Math.max(...prior)) return null;
  const lastYear = bills.filter((b) => {
    const m = monthsBetween(b.date, latest.date);
    return m >= 11 && m <= 13;
  });
  const longHistory = monthsBetween(bills[0].date, latest.date) >= 24;
  if (longHistory && lastYear.length) {
    const ly = lastYear[lastYear.length - 1].amount;
    if (latest.amount < ly * 1.25) return null;
  }
  return {
    key: `high_bill:${latest.date}`,
    severity: 'warn',
    message: `The ${fmtMdy(latest.date)} ${account} bill is ${fmtMoney(latest.amount)} — usually about ${fmtMoney(usual)} (${Math.round((latest.amount / usual - 1) * 100)}% higher)`,
  };
}

export interface CardTxn {
  statementId?: string;
  date: string;
  description: string;
  kind: string;
  amount: number;
}

/** Card activity rules over the latest statement. `stmtIds` = statement
 * ids oldest first (the last one is the latest statement). */
export function cardChargeFlags(account: string, stmtIds: string[], txns: CardTxn[]): Flag[] {
  const out: Flag[] = [];
  if (!stmtIds.length) return out;
  const latestId = stmtIds[stmtIds.length - 1];
  const prevId = stmtIds[stmtIds.length - 2];
  const purchases = txns.filter((t) => t.kind === 'purchase');
  const byStmt = (id: string | undefined) => (id ? purchases.filter((t) => t.statementId === id) : []);
  const latest = byStmt(latestId);

  // ---- Duplicate charges ----
  const pool = [...byStmt(prevId), ...latest].sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set<string>();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (a.amount < 10) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      const gap = (Date.parse(`${b.date}T12:00:00Z`) - Date.parse(`${a.date}T12:00:00Z`)) / 86400000;
      if (gap > 1) break;
      if (b.statementId !== latestId) continue;
      if (b.description !== a.description || Math.abs(b.amount - a.amount) > 0.005) continue;
      const key = `dup_charge:${b.date}:${b.amount.toFixed(2)}:${b.description.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        severity: 'warn',
        message: `Possible duplicate charge on the ${account}: ${b.description.replace(/ · Order .*$/, '')} ${fmtMoney(b.amount)} on ${fmtMdy(a.date)}${a.date === b.date ? '' : ` and ${fmtMdy(b.date)}`}`,
      });
    }
  }

  // ---- Subscription price increases ----
  const merchant = (t: CardTxn) => {
    const m = merchantOf(t.description);
    return m === 'Amazon' || m === 'Whole Foods' ? null : m;
  };
  const prev3 = stmtIds.slice(-4, -1);
  if (prev3.length === 3) {
    const latestCounts = new Map<string, number>();
    for (const t of latest) {
      const m = merchant(t);
      if (m) latestCounts.set(m, (latestCounts.get(m) ?? 0) + 1);
    }
    for (const t of latest) {
      const m = merchant(t);
      if (!m || latestCounts.get(m) !== 1) continue;
      const amounts: number[] = [];
      for (const id of prev3) {
        const xs = byStmt(id).filter((x) => merchant(x) === m);
        if (xs.length !== 1) break;
        amounts.push(xs[0].amount);
      }
      if (amounts.length !== 3 || Math.max(...amounts) - Math.min(...amounts) > 0.01) continue;
      const was = amounts[2];
      if (t.amount - was >= 1 && t.amount >= was * 1.05) {
        out.push({ key: `price_up:${m}:${t.date}`, severity: 'warn', message: `${m} went up on the ${account}: ${fmtMoney(was)} → ${fmtMoney(t.amount)} (${fmtMdy(t.date)})` });
      }
    }
  }
  return out;
}
