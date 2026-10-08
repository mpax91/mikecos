import { Hono } from 'hono';
import type { Env } from './types';
import { autoAutopayFrom, autoDueDayFrom, fmtMoney, loadPayer, ordinal } from './accountPayers';
import type { BillCycle, BillingFacts } from './accountPayers';
import { templateById } from './statements/templates';

/** Bills & Due Dates (Mike, 2026-10-08). See migrations/0096_bills.sql.
 *
 * One row per bill: every live statement folder whose template is a bill
 * or card account (auto rows), plus bills Mike adds by hand. Each row has
 * an effective due day of the month and Auto-Pay:
 *   - statement rows follow the statements (the same numbers as the Due
 *     Date / Auto-Pay Quick Facts) unless Mike edited the row — his edit
 *     is stored in due_day / autopay and wins until he resets it;
 *   - manual rows are whatever Mike typed.
 *
 * NOT on Auto-Pay → a monthly recurring task (recurring_task_definitions
 * with bill_id set — hidden from Settings → Recurring Tasks) due ON the due
 * day. When that month's statement is in, the open task shows the amount
 * and the statement's exact due date; it checks itself off when the next
 * statement shows the balance paid (or nothing was owed). This replaced
 * the old per-statement pay tasks in amazonDerive/adtDerive.
 * On Auto-Pay → no task; the Calendar (Day/Week/Month) shows a
 * non-checkable "Auto-Pay" entry on the due date (billsOnCalendar). */

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export interface BillRow {
  id: string;
  source: 'statement' | 'manual';
  folder_id: string | null;
  entry_id: string | null;
  name: string;
  enabled: number;
  due_day: number | null;
  autopay: number | null;
  amount: number | null;
  auto_due_day: number | null;
  auto_autopay: number | null;
  recurring_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Effective {
  dueDay: number | null;
  autopay: boolean;
  dueEdited: boolean;
  autopayEdited: boolean;
}

export function effective(b: BillRow): Effective {
  const dueEdited = b.source === 'statement' && b.due_day != null;
  const autopayEdited = b.source === 'statement' && b.autopay != null;
  return {
    dueDay: b.due_day ?? b.auto_due_day ?? null,
    autopay: (b.autopay ?? b.auto_autopay ?? 0) === 1,
    dueEdited,
    autopayEdited,
  };
}

// ---- Dates ----
export function easternTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
/** The due date in a month, clamped to its last day (31st → Feb 28). */
export function dayInMonth(ym: string, day: number): string {
  return `${ym}-${String(Math.min(day, daysInMonth(ym))).padStart(2, '0')}`;
}
const monthEnd = (ym: string) => dayInMonth(ym, 31);
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** Monthly RRULE on a day, falling back to the month's last day when the
 * month is shorter (BYMONTHDAY=31 alone would skip 30-day months). */
export function monthlyRrule(day: number): string {
  return day >= 29 ? `FREQ=MONTHLY;BYMONTHDAY=${day},-1;BYSETPOS=1` : `FREQ=MONTHLY;BYMONTHDAY=${day}`;
}

// ---- Statement side ----
interface FolderInfo {
  id: string;
  template_id: string | null;
  vault_entry_id: string | null;
  meta_json: string | null;
}

function billingOf(meta: string | null): BillingFacts | null {
  try {
    return meta ? (JSON.parse(meta).billing ?? null) : null;
  } catch {
    return null;
  }
}

/** Mike's own "Due Date" Quick Fact (he edited the auto one, which made it
 * his) — "14th", "14", "10/14/2026" or "2026-10-14" → 14. */
async function mikesDueDay(db: D1Database, entryId: string): Promise<number | null> {
  const released = await db.prepare(`SELECT 1 AS x FROM vault_fact_releases WHERE entry_id = ? AND managed_key = 'pay:due'`).bind(entryId).first();
  if (!released) return null;
  const fact = await db
    .prepare(`SELECT value FROM vault_facts WHERE entry_id = ? AND managed_key IS NULL AND LOWER(TRIM(label)) = 'due date' ORDER BY position LIMIT 1`)
    .bind(entryId)
    .first<{ value: string | null }>();
  const v = fact?.value?.trim() ?? '';
  let m = v.match(/^(\d{1,2})(st|nd|rd|th)?\b/i);
  if (m && !/^\d{1,2}\//.test(v)) return clampDay(Number(m[1]));
  m = v.match(/^\d{1,2}\/(\d{1,2})\/\d{2,4}$/);
  if (m) return clampDay(Number(m[1]));
  m = v.match(/^\d{4}-\d{2}-(\d{2})$/);
  if (m) return clampDay(Number(m[1]));
  return null;
}
const clampDay = (n: number) => (n >= 1 && n <= 31 ? n : null);

/** Makes sure every live bill/card statement folder has a bill row with
 * current auto values, removes rows for folders that are no longer live,
 * then reconciles each bill's task. Cheap; run after any derive and on
 * every Bills list load. */
export async function syncBills(env: Env): Promise<void> {
  const db = env.DB;
  const [{ results: folders }, { results: rows }] = await Promise.all([
    db.prepare(`SELECT id, template_id, vault_entry_id, meta_json FROM statement_folders WHERE status = 'live'`).all<FolderInfo>(),
    db.prepare('SELECT * FROM bills').all<BillRow>(),
  ]);
  const byFolder = new Map((rows ?? []).filter((r) => r.folder_id).map((r) => [r.folder_id!, r]));
  const liveIds = new Set<string>();
  for (const f of folders ?? []) {
    const kind = f.template_id ? templateById(f.template_id)?.account.kind : undefined;
    if (kind !== 'bill' && kind !== 'card') continue;
    if (!f.vault_entry_id) continue;
    liveIds.add(f.id);
    const billing = billingOf(f.meta_json);
    const payer = await loadPayer(env, f.vault_entry_id);
    const entry = await db.prepare('SELECT title FROM entities WHERE id = ?').bind(f.vault_entry_id).first<{ title: string }>();
    const name = entry?.title?.trim() || templateById(f.template_id!)?.account.nickname || 'Bill';
    const autoDay = (await mikesDueDay(db, f.vault_entry_id)) ?? autoDueDayFrom(billing, payer);
    const auto = autoAutopayFrom(billing, payer);
    const autoAutopay = auto === null ? null : auto ? 1 : 0;
    const cur = byFolder.get(f.id);
    if (!cur) {
      await db
        .prepare(
          `INSERT INTO bills (id, source, folder_id, entry_id, name, enabled, auto_due_day, auto_autopay, created_at, updated_at) VALUES (?, 'statement', ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .bind(uid(), f.id, f.vault_entry_id, name, autoDay, autoAutopay, now(), now())
        .run();
    } else if (cur.name !== name || cur.auto_due_day !== autoDay || cur.auto_autopay !== autoAutopay || cur.entry_id !== f.vault_entry_id) {
      await db
        .prepare('UPDATE bills SET name = ?, entry_id = ?, auto_due_day = ?, auto_autopay = ?, updated_at = ? WHERE id = ?')
        .bind(name, f.vault_entry_id, autoDay, autoAutopay, now(), cur.id)
        .run();
    }
  }
  for (const r of rows ?? []) {
    if (r.source === 'statement' && r.folder_id && !liveIds.has(r.folder_id)) await removeBill(db, r);
  }
  const { results: all } = await db.prepare('SELECT * FROM bills').all<BillRow>();
  for (const b of all ?? []) await reconcileBill(db, b);
}

/** Deletes a bill, its recurring definition and any still-open task. */
export async function removeBill(db: D1Database, b: BillRow): Promise<void> {
  if (b.recurring_id) {
    const def = await db.prepare('SELECT current_task_id FROM recurring_task_definitions WHERE id = ?').bind(b.recurring_id).first<{ current_task_id: string | null }>();
    if (def?.current_task_id) await db.prepare(`DELETE FROM entities WHERE id = ? AND status = 'open'`).bind(def.current_task_id).run();
    await db.prepare('DELETE FROM recurring_task_definitions WHERE id = ?').bind(b.recurring_id).run();
  }
  await db.prepare('DELETE FROM bills WHERE id = ?').bind(b.id).run();
}

const taskName = (b: BillRow) => `Pay ${b.name}`;

/** Keeps a bill's recurring task definition in line with the row:
 * needed only while the bill is on, not on Auto-Pay and has a due day. */
export async function reconcileBill(db: D1Database, b: BillRow): Promise<void> {
  const eff = effective(b);
  const wantTask = b.enabled === 1 && !eff.autopay && eff.dueDay != null;
  const def = b.recurring_id
    ? await db
        .prepare('SELECT id, rrule, active, current_task_id, last_spawned_due_date, title FROM recurring_task_definitions WHERE id = ?')
        .bind(b.recurring_id)
        .first<{ id: string; rrule: string; active: number; current_task_id: string | null; last_spawned_due_date: string | null; title: string }>()
    : null;
  const today = easternTodayIso();
  const yesterday = addDays(today, -1);

  if (!wantTask) {
    if (def && def.active) {
      // Remove this month's still-open task, and roll the spawn marker back
      // so turning the bill back on brings it back (a task Mike already
      // checked off keeps the month marked, so it never comes back twice).
      let lastSpawned = def.last_spawned_due_date;
      if (def.current_task_id) {
        const open = await db.prepare(`SELECT due_date FROM entities WHERE id = ? AND status = 'open'`).bind(def.current_task_id).first<{ due_date: string | null }>();
        if (open) {
          await db.prepare('DELETE FROM entities WHERE id = ?').bind(def.current_task_id).run();
          if (open.due_date) lastSpawned = addDays(`${open.due_date.slice(0, 7)}-01`, -1);
        }
      }
      await db
        .prepare('UPDATE recurring_task_definitions SET active = 0, current_task_id = NULL, last_spawned_due_date = ?, updated_at = ? WHERE id = ?')
        .bind(lastSpawned, now(), def.id)
        .run();
    }
    return;
  }

  const rrule = monthlyRrule(eff.dueDay!);
  const projectId = b.source === 'statement' ? b.entry_id : null;
  if (!def) {
    // New: the first task is the next due date from today on — never an
    // already-past (overdue) one.
    const id = uid();
    await db
      .prepare(
        `INSERT INTO recurring_task_definitions (id, title, project_id, rrule, dtstart, active, current_task_id, last_spawned_due_date, created_at, updated_at, bill_id)
         VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`
      )
      .bind(id, taskName(b), projectId, rrule, today, yesterday, now(), now(), b.id)
      .run();
    await db.prepare('UPDATE bills SET recurring_id = ? WHERE id = ?').bind(id, b.id).run();
    return;
  }

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (!def.active) {
    // Turned back on (or off Auto-Pay): pick up from today, no overdue backfill.
    sets.push('active = 1', 'current_task_id = NULL', 'last_spawned_due_date = ?');
    vals.push(def.last_spawned_due_date && def.last_spawned_due_date > yesterday ? def.last_spawned_due_date : yesterday);
  }
  if (def.title !== taskName(b)) sets.push('title = ?'), vals.push(taskName(b));
  if (def.rrule !== rrule) sets.push('rrule = ?'), vals.push(rrule);
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now(), def.id);
    await db.prepare(`UPDATE recurring_task_definitions SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
  if (def.active && def.current_task_id) await refreshBillTask(db, b, def.current_task_id);
}

/** The statement cycle due in a given month (YYYY-MM), if any. */
async function cycleFor(db: D1Database, b: BillRow, ym: string): Promise<BillCycle | null> {
  if (b.source !== 'statement' || !b.folder_id) return null;
  const f = await db.prepare('SELECT meta_json FROM statement_folders WHERE id = ?').bind(b.folder_id).first<{ meta_json: string | null }>();
  const cycles = billingOf(f?.meta_json ?? null)?.cycles ?? [];
  return [...cycles].reverse().find((c) => c.dueDate?.slice(0, 7) === ym) ?? null;
}

/** The due date shown for a month: Mike's edited day wins; otherwise the
 * statement's exact due date when that month's statement is in (unless
 * Mike's own Due Date Quick Fact names a different day — then his day);
 * otherwise the usual day. */
function dueDateFor(b: BillRow, ym: string, cycle: BillCycle | null): string | null {
  const eff = effective(b);
  if (eff.dueDay == null) return null;
  const usual = dayInMonth(ym, eff.dueDay);
  if (b.source === 'statement' && !eff.dueEdited && cycle?.dueDate) {
    // A statement date a few days off the usual day (a weekend shift) is
    // still the real due date; a different day altogether means Mike set it.
    const diff = Math.abs(Date.parse(cycle.dueDate) - Date.parse(usual)) / 86_400_000;
    if (diff <= 3) return cycle.dueDate;
  }
  return usual;
}

function titleFor(b: BillRow, cycle: BillCycle | null): string {
  if (cycle) return `${taskName(b)} (${fmtMoney(cycle.amount)})`;
  if (b.source === 'manual' && b.amount != null && b.amount > 0) return `${taskName(b)} (~${fmtMoney(b.amount)})`;
  return taskName(b);
}

/** Brings one open bill task up to date: title with the amount, due date,
 * and checks it off when the statements show it paid / nothing owed. */
export async function refreshBillTask(db: D1Database, b: BillRow, taskId: string): Promise<void> {
  const task = await db.prepare('SELECT id, status, title, due_date FROM entities WHERE id = ?').bind(taskId).first<{ id: string; status: string; title: string; due_date: string | null }>();
  if (!task || task.status !== 'open' || !task.due_date) return;
  const ym = task.due_date.slice(0, 7);
  const cycle = await cycleFor(db, b, ym);
  const title = titleFor(b, cycle);
  const due = dueDateFor(b, ym, cycle) ?? task.due_date;
  const paid = cycle && (cycle.amount <= 0.005 || cycle.paid === true);
  const ts = now();
  if (paid) {
    await db.prepare(`UPDATE entities SET title = ?, due_date = ?, status = 'done', updated_at = ? WHERE id = ?`).bind(title, due, ts, task.id).run();
    await db
      .prepare(`INSERT INTO task_completions (id, entity_id, title, completed_at, completed_date) VALUES (?, ?, ?, ?, ?)`)
      .bind(uid(), task.id, title, ts, easternTodayIso())
      .run();
    return;
  }
  if (title !== task.title || due !== task.due_date) {
    await db.prepare('UPDATE entities SET title = ?, due_date = ?, search_text = ?, updated_at = ? WHERE id = ?').bind(title, due, title, ts, task.id).run();
  }
}

/** Called by spawnDueRecurringTasks right after it creates a bill's task:
 * marks the whole month as spawned (so moving the due day can't create a
 * second task in the same month) and fills in the amount. */
export async function afterBillTaskSpawned(db: D1Database, billId: string, defId: string, taskId: string, dueDate: string): Promise<void> {
  await db.prepare('UPDATE recurring_task_definitions SET last_spawned_due_date = ? WHERE id = ?').bind(monthEnd(dueDate.slice(0, 7)), defId).run();
  const b = await db.prepare('SELECT * FROM bills WHERE id = ?').bind(billId).first<BillRow>();
  if (b) await refreshBillTask(db, b, taskId);
}

/** Auto-Pay bills on the Calendar: one non-checkable entry per month on its
 * due date, inside [start, end]. */
export interface CalendarBill {
  billId: string;
  date: string;
  name: string;
  amount: number | null;
  entryId: string | null;
}

export async function billsOnCalendar(db: D1Database, start: string, end: string): Promise<CalendarBill[]> {
  const { results } = await db.prepare('SELECT * FROM bills WHERE enabled = 1').all<BillRow>();
  const out: CalendarBill[] = [];
  for (const b of results ?? []) {
    const eff = effective(b);
    if (!eff.autopay || eff.dueDay == null) continue;
    for (let ym = start.slice(0, 7); ym <= end.slice(0, 7); ym = nextMonth(ym)) {
      const cycle = await cycleFor(db, b, ym);
      const date = dueDateFor(b, ym, cycle);
      if (!date || date < start || date > end) continue;
      out.push({ billId: b.id, date, name: b.name, amount: cycle ? cycle.amount : b.amount, entryId: b.entry_id });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

// ---- API: /api/bills ----
async function billJson(db: D1Database, b: BillRow) {
  const eff = effective(b);
  let latest: { amount: number; dueDate: string | null } | null = null;
  if (b.folder_id) {
    const f = await db.prepare('SELECT meta_json FROM statement_folders WHERE id = ?').bind(b.folder_id).first<{ meta_json: string | null }>();
    const billing = billingOf(f?.meta_json ?? null);
    if (billing?.latestAmount != null) latest = { amount: billing.latestAmount, dueDate: billing.dueDate };
  }
  let nextDue: string | null = null;
  if (eff.dueDay != null) {
    const today = easternTodayIso();
    for (let ym = today.slice(0, 7), i = 0; i < 3 && !nextDue; ym = nextMonth(ym), i++) {
      const cycle = await cycleFor(db, b, ym);
      if (cycle && !eff.autopay && (cycle.paid === true || cycle.amount <= 0.005)) continue; // already paid
      const d = dueDateFor(b, ym, cycle);
      if (d && d >= today) nextDue = d;
    }
  }
  let openTask: { id: string; title: string; dueDate: string | null } | null = null;
  if (b.recurring_id) {
    const t = await db
      .prepare(
        `SELECT e.id, e.title, e.due_date FROM recurring_task_definitions r JOIN entities e ON e.id = r.current_task_id WHERE r.id = ? AND r.active = 1 AND e.status = 'open'`
      )
      .bind(b.recurring_id)
      .first<{ id: string; title: string; due_date: string | null }>();
    if (t) openTask = { id: t.id, title: t.title, dueDate: t.due_date };
  }
  return {
    id: b.id,
    source: b.source,
    name: b.name,
    entryId: b.entry_id,
    folderId: b.folder_id,
    enabled: b.enabled === 1,
    dueDay: eff.dueDay,
    dueDayLabel: eff.dueDay != null ? ordinal(eff.dueDay) : null,
    autoDueDay: b.auto_due_day,
    dueEdited: eff.dueEdited,
    autopay: eff.autopay,
    autoAutopay: b.auto_autopay == null ? null : b.auto_autopay === 1,
    autopayEdited: eff.autopayEdited,
    amount: b.amount,
    latest,
    nextDue,
    openTask,
  };
}

const parseDay = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : undefined;
};

export const billsRouter = new Hono<{ Bindings: Env }>();

billsRouter.get('/', async (c) => {
  await syncBills(c.env);
  const { results } = await c.env.DB.prepare(`SELECT * FROM bills ORDER BY source = 'manual', LOWER(name)`).all<BillRow>();
  const rows = await Promise.all((results ?? []).map((b) => billJson(c.env.DB, b)));
  return c.json({ bills: rows });
});

billsRouter.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; dueDay?: number; amount?: number | null; autopay?: boolean }>();
  const name = body.name?.trim();
  const dueDay = parseDay(body.dueDay);
  if (!name) return c.json({ error: 'Name is required' }, 400);
  if (!dueDay) return c.json({ error: 'Due day must be 1–31' }, 400);
  const amount = body.amount == null || (body.amount as unknown) === '' ? null : Number(body.amount);
  if (amount !== null && !Number.isFinite(amount)) return c.json({ error: 'Amount must be a number' }, 400);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO bills (id, source, name, enabled, due_day, autopay, amount, created_at, updated_at) VALUES (?, 'manual', ?, 1, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, dueDay, body.autopay ? 1 : 0, amount, now(), now())
    .run();
  const b = (await c.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first<BillRow>())!;
  await reconcileBill(c.env.DB, b);
  return c.json(await billJson(c.env.DB, (await c.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first<BillRow>())!), 201);
});

/** PATCH: enabled; dueDay / autopay (null on a statement bill = follow the
 * statements again); name / amount for manual bills. */
billsRouter.patch('/:id', async (c) => {
  const b = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(c.req.param('id')).first<BillRow>();
  if (!b) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json<{ enabled?: boolean; dueDay?: number | null; autopay?: boolean | null; name?: string; amount?: number | null }>();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.enabled !== undefined) sets.push('enabled = ?'), vals.push(body.enabled ? 1 : 0);
  if (body.dueDay !== undefined) {
    const d = parseDay(body.dueDay);
    if (d === undefined || (d === null && b.source === 'manual')) return c.json({ error: 'Due day must be 1–31' }, 400);
    sets.push('due_day = ?'), vals.push(d);
  }
  if (body.autopay !== undefined) {
    if (body.autopay === null && b.source === 'manual') return c.json({ error: 'Auto-Pay must be true or false' }, 400);
    sets.push('autopay = ?'), vals.push(body.autopay === null ? null : body.autopay ? 1 : 0);
  }
  if (b.source === 'manual') {
    if (body.name !== undefined) {
      if (!body.name.trim()) return c.json({ error: 'Name is required' }, 400);
      sets.push('name = ?'), vals.push(body.name.trim());
    }
    if (body.amount !== undefined) {
      const a = body.amount === null || (body.amount as unknown) === '' ? null : Number(body.amount);
      if (a !== null && !Number.isFinite(a)) return c.json({ error: 'Amount must be a number' }, 400);
      sets.push('amount = ?'), vals.push(a);
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now(), b.id);
    await c.env.DB.prepare(`UPDATE bills SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }
  const fresh = (await c.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(b.id).first<BillRow>())!;
  await reconcileBill(c.env.DB, fresh);
  return c.json(await billJson(c.env.DB, fresh));
});

billsRouter.delete('/:id', async (c) => {
  const b = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(c.req.param('id')).first<BillRow>();
  if (!b) return c.json({ error: 'Not found' }, 404);
  if (b.source !== 'manual') return c.json({ error: 'Bills from statements can be turned off, not deleted' }, 400);
  await removeBill(c.env.DB, b);
  return c.json({ ok: true });
});
