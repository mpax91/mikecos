import { Hono } from 'hono';
import type { Env } from '../types';
import { cloudAccess } from '../cloud';
import { DEFAULT_IGNORED_FOLDERS, TEMPLATES, templateById, templateForFolder } from './templates';
import { derive, easternToday, loadFolder, scanFolder } from './engine';
import type { FolderRow } from './engine';
import { loadNy529Data, ny529Settings } from './ny529Derive';
import { summarizeNy529 } from './ny529Summary';
import { loadAdtData } from './adtDerive';
import { summarizeAdt } from './adtSummary';
import { loadTmobileData } from './tmobileDerive';
import { summarizeTmobile } from './tmobileSummary';
import { loadFiosData } from './fiosDerive';
import { summarizeFios } from './fiosSummary';
import { loadHanoverData, RENEWAL_LEAD_DAYS } from './hanoverDerive';
import { summarizeHanover } from './hanoverSummary';
import { loadAllyData } from './allyDerive';
import { accountLabel, summarizeAlly } from './allySummary';
import { loadAmexBankData } from './amexBankDerive';
import { summarizeAmexBank } from './amexBankSummary';
import { loadUsaaData } from './usaaDerive';
import { categoryOf, summarizeUsaa, USAA_CATEGORIES } from './usaaSummary';
import { loadAmazonData } from './amazonDerive';
import { loadAmexCardData } from './amexCardDerive';
import { loadBofaCardData } from './bofaCardDerive';
import { loadTargetCardData } from './targetCardDerive';
import { summarizeTargetCard, targetGaps } from './targetCardSummary';
import { listAttention } from './attention';
import { getCashPlacement } from './cashPlacement';
import { summarizeAmazon } from './amazonSummary';
import { summarizeAmexCard } from './amexCardSummary';
import { bofaGaps, summarizeBofaCard } from './bofaCardSummary';
import { cardRewardsSettings, combineRewards, rewardsFromAmazon, rewardsFromAmexCard, rewardsFromBofaCard, rewardsFromTargetCard, syncRedeemReminder } from './rewards';
import type { CardRewards, RedeemTaskState, RewardsCardLine } from './rewards';
import { loadPaypalData } from './paypalDerive';
import { summarizePaypal } from './paypalSummary';
import { cardPaypalView, loadPaypalMatches, paypalKey } from './paypalMatch';
import type { PaypalMatchResult } from './paypalMatch';

/** Statements API, mounted at /api/statements. */
export const statementsRouter = new Hono<{ Bindings: Env }>();

const now = () => new Date().toISOString();

interface FolderStats {
  total: number;
  parsed: number;
  lastPeriodEnd: string | null;
  openFlags: number;
}

async function folderStats(env: Env): Promise<Map<string, FolderStats>> {
  const [files, stmts, flags] = await env.DB.batch([
    env.DB.prepare(`SELECT folder_row_id, SUM(CASE WHEN status = 'skipped' THEN 0 ELSE 1 END) AS total, SUM(CASE WHEN status = 'parsed' THEN 1 ELSE 0 END) AS parsed FROM statement_files GROUP BY folder_row_id`),
    env.DB.prepare('SELECT folder_row_id, MAX(period_end) AS last FROM statements GROUP BY folder_row_id'),
    // Cash Placement suggestions are info notes, not issues — left out of the row's ⚠ count.
    env.DB.prepare("SELECT folder_row_id, COUNT(*) AS n FROM statement_flags WHERE resolved_at IS NULL AND dismissed_at IS NULL AND dedupe_key NOT LIKE 'cash\\_%' ESCAPE '\\' GROUP BY folder_row_id"),
  ]);
  const out = new Map<string, FolderStats>();
  const get = (id: string) => out.get(id) ?? (out.set(id, { total: 0, parsed: 0, lastPeriodEnd: null, openFlags: 0 }), out.get(id)!);
  for (const r of (files.results ?? []) as { folder_row_id: string; total: number; parsed: number }[]) Object.assign(get(r.folder_row_id), { total: r.total, parsed: r.parsed ?? 0 });
  for (const r of (stmts.results ?? []) as { folder_row_id: string; last: string }[]) get(r.folder_row_id).lastPeriodEnd = r.last;
  for (const r of (flags.results ?? []) as { folder_row_id: string; n: number }[]) get(r.folder_row_id).openFlags = r.n;
  return out;
}

function folderJson(row: FolderRow, stats?: FolderStats) {
  const t = templateById(row.template_id);
  let settings: unknown = null;
  if (row.template_id === 'ny529') settings = ny529Settings(row);
  else if (t?.account.kind === 'card') settings = cardRewardsSettings(row);
  return {
    id: row.id,
    accountId: row.cloud_account_id,
    folderId: row.folder_id,
    folderName: row.folder_name,
    folderUrl: row.folder_url,
    templateId: row.template_id,
    templateName: t?.name ?? null,
    nickname: t?.account.nickname ?? row.folder_name,
    status: row.status,
    owner: row.owner,
    vaultEntryId: row.vault_entry_id,
    settings,
    lastScanAt: row.last_scan_at,
    lastError: row.last_error,
    coverage: stats ? { total: stats.total, parsed: stats.parsed } : { total: 0, parsed: 0 },
    lastPeriodEnd: stats?.lastPeriodEnd ?? null,
    openFlags: stats?.openFlags ?? 0,
  };
}

statementsRouter.get('/templates', (c) => c.json(TEMPLATES.map((t) => ({ id: t.id, name: t.name, folderNames: t.folderNames, account: t.account }))));

// Every top-level Drive folder across connected Google Drive accounts, with
// its Statements status — the Settings → Statements list.
statementsRouter.get('/drive-folders', async (c) => {
  const { results: accounts } = await c.env.DB.prepare(`SELECT id, label, account_email FROM cloud_accounts WHERE provider = 'google_drive' ORDER BY position, created_at`).all<{
    id: string;
    label: string;
    account_email: string | null;
  }>();
  const { results: rows } = await c.env.DB.prepare('SELECT * FROM statement_folders').all<FolderRow>();
  const stats = await folderStats(c.env);
  const registered = new Map((rows ?? []).map((r) => [`${r.cloud_account_id}|${r.folder_id}`, r]));
  // Employer paystub folders belong to Finance → Career — ignored here by default.
  const careerFolders = new Set((((await c.env.DB.prepare('SELECT folder_id FROM career_folders').all<{ folder_id: string }>().catch(() => ({ results: [] }))).results ?? []) as { folder_id: string }[]).map((r) => r.folder_id));
  const out = [];
  for (const acct of accounts ?? []) {
    let folders: { id: string; name: string; webUrl: string | null }[] = [];
    let error: string | null = null;
    try {
      const { token, adapter } = await cloudAccess(c.env, acct.id);
      folders = (await adapter.listFolder(token, null)).filter((e) => e.type === 'folder');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    out.push({
      accountId: acct.id,
      accountLabel: acct.label,
      accountEmail: acct.account_email,
      error,
      folders: folders.map((f) => {
        const reg = registered.get(`${acct.id}|${f.id}`);
        const suggested = templateForFolder(f.name);
        return {
          folderId: f.id,
          folderName: f.name,
          folderUrl: f.webUrl,
          registered: reg ? folderJson(reg, stats.get(reg.id)) : null,
          suggestedTemplateId: suggested?.id ?? null,
          defaultIgnored: DEFAULT_IGNORED_FOLDERS.includes(f.name) || careerFolders.has(f.id),
          // Read nightly by Finance → Career's paystub scan (not by Statements).
          career: careerFolders.has(f.id),
        };
      }),
    });
  }
  return c.json(out);
});

statementsRouter.get('/folders', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM statement_folders ORDER BY folder_name').all<FolderRow>();
  const stats = await folderStats(c.env);
  return c.json((results ?? []).map((r) => folderJson(r, stats.get(r.id))));
});

// Register a Drive folder: go Live with a template, or mark it Ignored.
statementsRouter.post('/folders', async (c) => {
  const body = await c.req.json<{ accountId: string; folderId: string; folderName: string; folderUrl?: string | null; status: 'live' | 'ignored' | 'needs_template'; templateId?: string | null }>();
  if (!body.accountId || !body.folderId || !body.folderName) return c.json({ error: 'accountId, folderId and folderName are required' }, 400);
  const template = body.status === 'live' ? templateById(body.templateId) : null;
  if (body.status === 'live' && !template) return c.json({ error: 'No template for this folder yet' }, 400);
  const id = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO statement_folders (id, cloud_account_id, folder_id, folder_name, folder_url, template_id, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_account_id, folder_id) DO UPDATE SET folder_name = excluded.folder_name, folder_url = excluded.folder_url,
       template_id = COALESCE(excluded.template_id, statement_folders.template_id), status = excluded.status,
       owner = CASE WHEN excluded.template_id IS NOT NULL THEN excluded.owner ELSE statement_folders.owner END, updated_at = excluded.updated_at`
  )
    .bind(id, body.accountId, body.folderId, body.folderName, body.folderUrl ?? null, template?.id ?? null, body.status, template?.account.owner ?? 'household', ts, ts)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM statement_folders WHERE cloud_account_id = ? AND folder_id = ?').bind(body.accountId, body.folderId).first<FolderRow>();
  return c.json(folderJson(row!), 201);
});

statementsRouter.patch('/folders/:id', async (c) => {
  const row = await loadFolder(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ status?: FolderRow['status']; owner?: FolderRow['owner']; settings?: Record<string, unknown> }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.status) {
    if (body.status === 'live' && !row.template_id) return c.json({ error: 'No template for this folder yet' }, 400);
    sets.push('status = ?');
    binds.push(body.status);
  }
  if (body.owner === 'household' || body.owner === 'chase') {
    sets.push('owner = ?');
    binds.push(body.owner);
  }
  if (body.settings) {
    let cur: Record<string, unknown> = {};
    try {
      cur = row.settings_json ? JSON.parse(row.settings_json) : {};
    } catch {
      cur = {};
    }
    sets.push('settings_json = ?');
    binds.push(JSON.stringify({ ...cur, ...body.settings }));
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    binds.push(now(), row.id);
    await c.env.DB.prepare(`UPDATE statement_folders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  const updated = (await loadFolder(c.env, row.id))!;
  // Settings changes (limit, confirmation) re-derive right away so the
  // reminder and Vault note reflect them without waiting for tonight.
  if (body.settings && updated.status === 'live') await derive(c.env, updated);
  // Card taken off live → its redeem reminder goes too.
  else if (body.status && templateById(updated.template_id)?.account.kind === 'card') await syncRedeemReminder(c.env, updated.id, easternToday());
  return c.json(folderJson(updated));
});

statementsRouter.post('/folders/:id/scan', async (c) => {
  const row = await loadFolder(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  try {
    const result = await scanFolder(c.env, row);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// Finance overview — every live account with its headline numbers.
statementsRouter.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM statement_folders WHERE status = 'live' ORDER BY folder_name`).all<FolderRow>();
  const stats = await folderStats(c.env);
  const out = [];
  for (const row of results ?? []) {
    let headline:
      | { kind: 'balance'; value: number; asOf: string | null; principal?: number; earnings?: number; parts?: { label: string; value: number }[] }
      | { kind: 'bill'; value: number; asOf: string | null; monthly: number | null; status: string }
      | { kind: 'card'; value: number; asOf: string | null; status: string; dueDate: string | null; minimum: number | null; pointsValue: number | null }
      | { kind: 'app'; value: number; asOf: string | null; spent12: number; received12: number; lastActivity: string | null }
      | null = null;
    if (row.template_id === 'ny529') {
      const { stmts, txns } = await loadNy529Data(c.env, row.id);
      const s = summarizeNy529(stmts, txns, ny529Settings(row), easternToday());
      headline = { kind: 'balance', value: s.value, asOf: s.asOf, principal: s.principal, earnings: s.earnings };
    } else if (row.template_id === 'adt') {
      const { stmts, txns } = await loadAdtData(c.env, row.id);
      const s = summarizeAdt(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'bill', value: s.latest.totalDue, asOf: s.asOf, monthly: s.monthlyWithTax ?? s.monthlyRate, status: s.status };
    } else if (row.template_id === 'paypal') {
      const { stmts } = await loadPaypalData(c.env, row.id);
      const s = summarizePaypal(stmts, easternToday());
      if (s.asOf) headline = { kind: 'app', value: s.balance, asOf: s.asOf, spent12: s.last12.spent, received12: s.last12.received, lastActivity: s.lastActivity };
    } else if (row.template_id === 'tmobile') {
      const { stmts, txns } = await loadTmobileData(c.env, row.id);
      const s = summarizeTmobile(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'bill', value: s.latest.totalDue, asOf: s.asOf, monthly: s.usualMonthly ?? s.monthly, status: s.status };
    } else if (row.template_id === 'fios') {
      const { stmts, txns } = await loadFiosData(c.env, row.id);
      const s = summarizeFios(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'bill', value: s.latest.totalDue, asOf: s.asOf, monthly: s.monthly, status: s.status };
    } else if (row.template_id === 'hanover') {
      const { stmts } = await loadHanoverData(c.env, row.id);
      const s = summarizeHanover(stmts, easternToday());
      // Value = the next Auto-Pay withdrawal; monthly = the same (auto + umbrella; the home is paid through escrow).
      if (s.policies.length) headline = { kind: 'bill', value: s.next?.total ?? 0, asOf: s.asOf, monthly: s.next?.total ?? s.last?.total ?? null, status: s.next ? 'autopay' : 'paid' };
    } else if (row.template_id === 'ally') {
      const { stmts, txns } = await loadAllyData(c.env, row.id);
      const s = summarizeAlly(stmts, txns, easternToday());
      if (s.asOf) headline = { kind: 'balance', value: s.total, asOf: s.asOf, parts: s.accounts.filter((a) => a.open).map((a) => ({ label: accountLabel(a.kind, a.last4), value: a.balance })) };
    } else if (row.template_id === 'usaa') {
      const { stmts, txns } = await loadUsaaData(c.env, row.id);
      const s = summarizeUsaa(stmts, txns, easternToday());
      if (s.asOf) headline = { kind: 'balance', value: s.balance, asOf: s.asOf };
    } else if (row.template_id === 'amexBank') {
      const { stmts, txns } = await loadAmexBankData(c.env, row.id);
      const s = summarizeAmexBank(stmts, txns, easternToday());
      if (s.asOf) headline = { kind: 'balance', value: s.balance, asOf: s.asOf };
    } else if (row.template_id === 'amazon') {
      const { stmts, txns } = await loadAmazonData(c.env, row.id);
      const s = summarizeAmazon(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'card', value: s.balance, asOf: s.asOf, status: s.status, dueDate: s.latest.dueDate, minimum: s.latest.minimumPayment, pointsValue: s.pointsValue };
    } else if (row.template_id === 'amexCard') {
      const { stmts, txns } = await loadAmexCardData(c.env, row.id);
      const s = summarizeAmexCard(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'card', value: s.balance, asOf: s.asOf, status: s.status, dueDate: s.latest.dueDate, minimum: s.latest.minimumPayment, pointsValue: s.rewardDollars };
    } else if (row.template_id === 'bofaCard') {
      const { stmts, txns } = await loadBofaCardData(c.env, row.id);
      const s = summarizeBofaCard(stmts, txns, easternToday());
      if (s.latest) headline = { kind: 'card', value: s.balance, asOf: s.asOf, status: s.status, dueDate: s.nextDue ? s.latest.dueDate : null, minimum: s.nextDue ? s.latest.minimumPayment : null, pointsValue: s.cashBackAvailable };
    } else if (row.template_id === 'targetCard') {
      const { stmts, txns } = await loadTargetCardData(c.env, row.id);
      const s = summarizeTargetCard(stmts, txns, easternToday());
      // No rewards balance (the 5% is off at checkout) — pointsValue stays null.
      if (s.latest) headline = { kind: 'card', value: s.balance, asOf: s.asOf, status: s.status, dueDate: s.nextDue ? s.latest.dueDate : null, minimum: s.nextDue ? s.latest.minimumPayment : null, pointsValue: null };
    }
    out.push({ ...folderJson(row, stats.get(row.id)), headline });
  }
  return c.json(out);
});

/** Rewards for one live card folder, straight from its statements. */
async function cardRewardsFor(env: Env, row: FolderRow): Promise<CardRewards | null> {
  const today = easternToday();
  if (row.template_id === 'amazon') {
    const { stmts, txns } = await loadAmazonData(env, row.id);
    return stmts.length ? rewardsFromAmazon(summarizeAmazon(stmts, txns, today), today) : null;
  }
  if (row.template_id === 'amexCard') {
    const { stmts, txns } = await loadAmexCardData(env, row.id);
    return stmts.length ? rewardsFromAmexCard(summarizeAmexCard(stmts, txns, today), today) : null;
  }
  if (row.template_id === 'bofaCard') {
    const { stmts, txns } = await loadBofaCardData(env, row.id);
    return stmts.length ? rewardsFromBofaCard(summarizeBofaCard(stmts, txns, today), today) : null;
  }
  if (row.template_id === 'targetCard') {
    const { stmts, txns } = await loadTargetCardData(env, row.id);
    return stmts.length ? rewardsFromTargetCard(summarizeTargetCard(stmts, txns, today), today) : null;
  }
  return null;
}

/** The redeem reminder's open task (if any) + the threshold, for a dashboard. */
async function redeemInfo(env: Env, row: FolderRow) {
  let state: RedeemTaskState | undefined;
  try {
    state = row.meta_json ? JSON.parse(row.meta_json).redeemTask : undefined;
  } catch {
    state = undefined;
  }
  const task = state?.taskId
    ? await env.DB.prepare('SELECT id, title, due_date, status FROM entities WHERE id = ?').bind(state.taskId).first<{ id: string; title: string; due_date: string | null; status: string | null }>()
    : null;
  return {
    redeemAt: cardRewardsSettings(row).redeemAt,
    redeemTask: task && task.status !== 'done' ? { id: task.id, title: task.title, due: task.due_date } : null,
    redeemQuietUntil: !task && state?.quietUntil !== undefined ? state.quietUntil : null,
  };
}

// Rewards across every live credit card (Finance), for one owner.
statementsRouter.get('/rewards', async (c) => {
  const owner = c.req.query('owner') === 'chase' ? 'chase' : 'household';
  const { results } = await c.env.DB.prepare(`SELECT * FROM statement_folders WHERE status = 'live' AND owner = ? ORDER BY folder_name`).bind(owner).all<FolderRow>();
  const cards: RewardsCardLine[] = [];
  for (const row of results ?? []) {
    const t = templateById(row.template_id);
    if (t?.account.kind !== 'card') continue;
    const rewards = await cardRewardsFor(c.env, row);
    if (rewards) cards.push({ folderId: row.id, name: t.account.nickname, owner: row.owner, rewards, redeemAt: cardRewardsSettings(row).redeemAt });
  }
  return c.json(combineRewards(cards));
});

statementsRouter.get('/folders/:id/dashboard', async (c) => {
  const row = await loadFolder(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.template_id === 'adt') return c.json(await adtDashboard(c.env, row));
  if (row.template_id === 'tmobile') return c.json(await tmobileDashboard(c.env, row));
  if (row.template_id === 'fios') return c.json(await fiosDashboard(c.env, row));
  if (row.template_id === 'hanover') return c.json(await hanoverDashboard(c.env, row));
  if (row.template_id === 'paypal') return c.json(await paypalDashboard(c.env, row));
  if (row.template_id === 'ally') return c.json(await allyDashboard(c.env, row));
  if (row.template_id === 'amazon') return c.json(await amazonDashboard(c.env, row));
  if (row.template_id === 'amexBank') return c.json(await amexBankDashboard(c.env, row));
  if (row.template_id === 'usaa') return c.json(await usaaDashboard(c.env, row));
  if (row.template_id === 'amexCard') return c.json(await amexCardDashboard(c.env, row));
  if (row.template_id === 'bofaCard') return c.json(await bofaCardDashboard(c.env, row));
  if (row.template_id === 'targetCard') return c.json(await targetCardDashboard(c.env, row));
  if (row.template_id !== 'ny529') return c.json({ error: 'No dashboard for this template yet' }, 400);
  const stats = await folderStats(c.env);
  const { stmts, txns, files } = await loadNy529Data(c.env, row.id);
  const summary = summarizeNy529(stmts, txns, ny529Settings(row), easternToday());
  const { results: flags } = await c.env.DB.prepare(
    'SELECT id, severity, message, created_at FROM statement_flags WHERE folder_row_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL ORDER BY severity DESC, created_at DESC'
  )
    .bind(row.id)
    .all();
  const latest = stmts[stmts.length - 1];
  let topupTask: { id: string; title: string; due: string | null; status: string | null } | null = null;
  try {
    const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
    if (meta.topupTask?.taskId) {
      const t = await c.env.DB.prepare('SELECT id, title, due_date, status FROM entities WHERE id = ?').bind(meta.topupTask.taskId).first<{ id: string; title: string; due_date: string | null; status: string | null }>();
      if (t) topupTask = { id: t.id, title: t.title, due: t.due_date, status: t.status };
    }
  } catch {
    // no reminder bookkeeping yet
  }
  return c.json({
    kind: 'ny529',
    folder: folderJson(row, stats.get(row.id)),
    account: latest
      ? { owner: latest.values.owner, beneficiary: latest.values.beneficiary, accountLast: latest.values.accountLast, accountType: latest.values.accountType }
      : null,
    template: templateById(row.template_id)?.account ?? null,
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodStart: s.periodStart, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactions: txns,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: flags ?? [],
    topupTask,
  });
});

// Cash Placement — rule-based suggestions for the Finance card.
statementsRouter.get('/cash-placement', async (c) => c.json(await getCashPlacement(c.env)));

// Accounts Need Attention — the Finance sidebar badge and strip.
statementsRouter.get('/attention', async (c) => {
  const items = await listAttention(c.env, easternToday());
  return c.json({ count: items.length, items });
});

statementsRouter.post('/flags/:id/dismiss', async (c) => {
  await c.env.DB.prepare('UPDATE statement_flags SET dismissed_at = ? WHERE id = ?').bind(now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

async function openFlags(env: Env, folderId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, severity, message, created_at FROM statement_flags WHERE folder_row_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL ORDER BY severity DESC, created_at DESC'
  )
    .bind(folderId)
    .all();
  return results ?? [];
}

/** ADT (monthly bill) dashboard payload. */
async function adtDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadAdtData(env, row.id);
  const summary = summarizeAdt(stmts, txns, easternToday());
  let payTask: { id: string; title: string; due: string | null; status: string | null } | null = null;
  try {
    const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
    if (meta.payTask?.taskId) {
      const t = await env.DB.prepare('SELECT id, title, due_date, status FROM entities WHERE id = ?').bind(meta.payTask.taskId).first<{ id: string; title: string; due_date: string | null; status: string | null }>();
      if (t) payTask = { id: t.id, title: t.title, due: t.due_date, status: t.status };
    }
  } catch {
    // no reminder bookkeeping yet
  }
  const last = stmts[stmts.length - 1];
  return {
    kind: 'adt' as const,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { accountLast: last.values.accountLast } : null,
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactions: txns,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
    payTask,
  };
}

/** Verizon Fios (monthly home internet bill) dashboard payload. */
async function fiosDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadFiosData(env, row.id);
  const summary = summarizeFios(stmts, txns, easternToday());
  const last = stmts[stmts.length - 1];
  return {
    kind: 'fios' as const,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { account: last.values.account } : null,
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactions: txns,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Hanover Insurance (auto + home + umbrella) dashboard payload. */
async function hanoverDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, files } = await loadHanoverData(env, row.id);
  const summary = summarizeHanover(stmts, easternToday());
  let renewalTask: { termEnd: string; entityId: string } | null = null;
  try {
    renewalTask = row.meta_json ? JSON.parse(row.meta_json).renewalTask ?? null : null;
  } catch {
    renewalTask = null;
  }
  return {
    kind: 'hanover' as const,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    summary,
    renewal: { leadDays: RENEWAL_LEAD_DAYS, taskId: renewalTask?.termEnd === summary.termEnd ? renewalTask?.entityId ?? null : null },
    statements: stmts.map((s) => ({ id: s.id, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Home → Internet: the live home-internet bill (Verizon Fios) in one line —
 * plan, speed, monthly, price guarantee — or null when none is live. */
statementsRouter.get('/internet-bill', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM statement_folders WHERE status = 'live' AND template_id = 'fios' ORDER BY updated_at DESC LIMIT 1`).first<FolderRow>();
  if (!row) return c.json(null);
  const { stmts, txns } = await loadFiosData(c.env, row.id);
  const s = summarizeFios(stmts, txns, easternToday());
  if (!s.latest) return c.json(null);
  return c.json({
    folderId: row.id,
    name: templateById(row.template_id)?.account.nickname ?? row.folder_name,
    plan: s.plan,
    speedMbps: s.speedMbps,
    monthly: s.monthly,
    asOf: s.asOf,
    autopay: s.latest.autopay,
    priceGuaranteeUntil: s.priceGuaranteeUntil,
    addOns: s.addOns,
  });
});

/** T-Mobile (monthly wireless bill) dashboard payload. */
async function tmobileDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadTmobileData(env, row.id);
  const summary = summarizeTmobile(stmts, txns, easternToday());
  const last = stmts[stmts.length - 1];
  return {
    kind: 'tmobile' as const,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { account: last.values.account } : null,
    summary,
    // Per-line data by bill for the usage chart.
    usage: stmts.map((s) => ({ date: s.periodEnd, total: s.values.dataGb, lines: s.values.lines.map((l) => ({ number: l.number, gb: l.dataGb })) })),
    statements: stmts.map((s) => ({ id: s.id, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactions: txns,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Ally Bank (checking + savings) dashboard payload. Transactions are
 * capped to the last 24 months — the full history stays in D1. */
async function allyDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadAllyData(env, row.id);
  const summary = summarizeAlly(stmts, txns, easternToday());
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const placement = await getCashPlacement(env);
  return {
    kind: 'ally' as const,
    cashPlacement: {
      bank: placement.banks.find((b) => b.folderId === row.id) ?? null,
      suggestions: placement.suggestions.filter((x) => x.folderId === row.id || x.toFolderId === row.id),
      rules: placement.rules,
    },
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    summary,
    statements: stmts.map((s) => ({
      id: s.id,
      periodEnd: s.periodEnd,
      fileId: s.fileId,
      checks: s.checks,
      accounts: s.values.accounts.map((a) => ({ last4: a.last4, beginning: a.beginning, ending: a.ending, deposits: a.deposits, withdrawals: a.withdrawals, interest: a.interest, apy: a.apy })),
    })),
    transactions: txns.filter((t) => t.date > since),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** USAA checking dashboard payload. Every statement's flows (by category)
 * go out so ranges work back to 2007; individual transactions are capped to
 * the last 24 statements (~1,000 rows) — the full history stays in D1. */
async function usaaDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadUsaaData(env, row.id);
  const summary = summarizeUsaa(stmts, txns, easternToday());
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const placement = await getCashPlacement(env);
  return {
    kind: 'usaa' as const,
    cashPlacement: {
      bank: placement.banks.find((b) => b.folderId === row.id) ?? null,
      suggestions: placement.suggestions.filter((x) => x.folderId === row.id || x.toFolderId === row.id),
      rules: placement.rules,
    },
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    summary,
    categories: USAA_CATEGORIES,
    // Full check details for the last 24 statements (and any failure);
    // older ones carry counts only — the payload stays small.
    statements: stmts.map((s) => ({
      id: s.id,
      periodStart: s.values.periodStart,
      periodEnd: s.periodEnd,
      fileId: s.fileId,
      checks: s.periodEnd > since ? s.checks : s.checks.filter((x) => !x.ok),
      checkCount: s.checks.length,
      checkOk: s.checks.filter((x) => x.ok).length,
      era: s.values.era,
      beginning: s.values.beginning,
      credits: s.values.credits,
      debits: s.values.debits,
      interest: s.values.interest,
      ending: s.values.ending,
      avgDailyBalance: s.values.avgDailyBalance,
      lowBalance: s.values.lowBalance,
      lowDate: s.values.lowDate,
      apy: s.values.apy,
    })),
    transactions: txns.filter((t) => t.date > since).map((t) => ({ ...t, category: categoryOf(t) })),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** American Express High Yield Savings dashboard payload. Transactions
 * are capped to the last 24 statements — the full history stays in D1. */
async function amexBankDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadAmexBankData(env, row.id);
  const summary = summarizeAmexBank(stmts, txns, easternToday());
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const placement = await getCashPlacement(env);
  return {
    kind: 'amexBank' as const,
    cashPlacement: {
      bank: placement.banks.find((b) => b.folderId === row.id) ?? null,
      suggestions: placement.suggestions.filter((x) => x.folderId === row.id || x.toFolderId === row.id),
      rules: placement.rules,
    },
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    summary,
    statements: stmts.map((s) => ({
      id: s.id,
      periodStart: s.values.periodStart,
      periodEnd: s.periodEnd,
      fileId: s.fileId,
      checks: s.checks,
      beginning: s.values.beginning,
      credits: s.values.credits,
      debits: s.values.debits,
      interest: s.values.interest,
      ending: s.values.ending,
      apy: s.values.apy ?? s.values.apyEarned,
    })),
    transactions: txns.filter((t) => t.date > since),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Amazon Prime Visa (credit card) dashboard payload. Activity rows are
 * capped to the last 24 statements — the full history stays in D1. */
async function amazonDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadAmazonData(env, row.id);
  const summary = summarizeAmazon(stmts, txns, easternToday());
  let payTask: { id: string; title: string; due: string | null; status: string | null } | null = null;
  try {
    const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
    if (meta.payTask?.taskId) {
      const t = await env.DB.prepare('SELECT id, title, due_date, status FROM entities WHERE id = ?').bind(meta.payTask.taskId).first<{ id: string; title: string; due_date: string | null; status: string | null }>();
      if (t) payTask = { id: t.id, title: t.title, due: t.due_date, status: t.status };
    }
  } catch {
    // no reminder bookkeeping yet
  }
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const last = stmts[stmts.length - 1];
  return {
    kind: 'amazon' as const,
    ...(await cardPaypal(env, row.id, txns.filter((t) => t.date > since))),
    rewards: summary.latest ? rewardsFromAmazon(summary, easternToday()) : null,
    ...(await redeemInfo(env, row)),
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { accountLast: last.values.accountLast } : null,
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodStart: s.periodStart, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
    payTask,
  };
}

/** Amex Blue Cash Everyday (credit card) dashboard payload. Activity rows
 * are capped to the last 24 statements — the full history stays in D1. */
async function amexCardDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadAmexCardData(env, row.id);
  const summary = summarizeAmexCard(stmts, txns, easternToday());
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const last = stmts[stmts.length - 1];
  return {
    kind: 'amexCard' as const,
    ...(await cardPaypal(env, row.id, txns.filter((t) => t.date > since))),
    rewards: summary.latest ? rewardsFromAmexCard(summary, easternToday()) : null,
    ...(await redeemInfo(env, row)),
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { accountLast: last.values.accountLast, accountEnding: last.values.accountEnding } : null,
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodStart: s.periodStart, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Bank of America Customized Cash Rewards (credit card) dashboard payload.
 * Activity rows are capped to the last 24 statements. */
async function bofaCardDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadBofaCardData(env, row.id);
  const summary = summarizeBofaCard(stmts, txns, easternToday());
  const since = stmts.length > 24 ? stmts[stmts.length - 25].periodEnd : '';
  const last = stmts[stmts.length - 1];
  return {
    kind: 'bofaCard' as const,
    ...(await cardPaypal(env, row.id, txns.filter((t) => t.date > since))),
    rewards: summary.latest ? rewardsFromBofaCard(summary, easternToday()) : null,
    ...(await redeemInfo(env, row)),
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { accountLast: last.values.accountLast } : null,
    gaps: bofaGaps(stmts, files),
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodStart: s.periodStart, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    transactionsSince: since || null,
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** Target RedCard / Circle Card dashboard payload — few statements, so
 * every transaction comes along. */
async function targetCardDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, txns, files } = await loadTargetCardData(env, row.id);
  const summary = summarizeTargetCard(stmts, txns, easternToday());
  const last = stmts[stmts.length - 1];
  return {
    kind: 'targetCard' as const,
    transactions: txns.map(({ statementId, date, description, kind, amount }) => ({ statementId, date, description, kind, amount })),
    rewards: summary.latest ? rewardsFromTargetCard(summary, easternToday()) : null,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    account: last ? { accountLast: last.values.accountLast } : null,
    gaps: targetGaps(stmts, files),
    summary,
    statements: stmts.map((s) => ({ id: s.id, periodStart: s.periodStart, periodEnd: s.periodEnd, fileId: s.fileId, checks: s.checks })),
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}

/** PayPal on a card dashboard: the real store behind each "PAYPAL *…" line
 * (matched from the PayPal statements) + stores paid through PayPal. */
async function cardPaypal(env: Env, folderId: string, txns: { date: string; description: string; kind: string; amount: number }[]) {
  const res = await loadPaypalMatches(env);
  const view = cardPaypalView(res, folderId);
  return {
    transactions: txns.map(({ date, description, kind, amount }) => {
      const via = view.byKey[paypalKey({ date, amount, description })];
      return via ? { date, description, kind, amount, paypal: via } : { date, description, kind, amount };
    }),
    paypal: view.hasPaypal ? { matched: view.matched, unmatched: view.unmatched, unmatchedTotal: view.unmatchedTotal, merchants: view.merchants.slice(0, 15) } : null,
  };
}

/** PayPal (payment app) dashboard payload. */
async function paypalDashboard(env: Env, row: FolderRow) {
  const stats = await folderStats(env);
  const { stmts, files } = await loadPaypalData(env, row.id);
  const summary = summarizePaypal(stmts, easternToday());
  const match: PaypalMatchResult = await loadPaypalMatches(env);
  // Which card actually paid each card-funded PayPal row (by PayPal ID).
  const paidBy: Record<string, { card: string; folderId: string; description: string; date: string }> = {};
  for (const m of match.matches) {
    if (!m.charge.paypalId || m.charge.amount <= 0) continue;
    paidBy[m.charge.paypalId] = { card: match.cardNames.get(m.card.folderId) ?? 'Card', folderId: m.card.folderId, description: m.card.description, date: m.card.date };
  }
  const byCard = new Map<string, { card: string; folderId: string; total: number; count: number }>();
  for (const m of match.matches.filter((x) => x.charge.amount > 0)) {
    const name = match.cardNames.get(m.card.folderId) ?? 'Card';
    const cur = byCard.get(m.card.folderId) ?? { card: name, folderId: m.card.folderId, total: 0, count: 0 };
    cur.total = Math.round((cur.total + m.charge.amount) * 100) / 100;
    cur.count++;
    byCard.set(m.card.folderId, cur);
  }
  return {
    kind: 'paypal' as const,
    folder: folderJson(row, stats.get(row.id)),
    template: templateById(row.template_id)?.account ?? null,
    summary,
    cards: {
      paidBy,
      byCard: [...byCard.values()].sort((a, b) => b.total - a.total),
      unmatchedPaypal: match.unmatchedPaypal.filter((c) => c.amount > 0).length,
      cardsLive: match.cardNames.size,
    },
    statements: stmts.map((s) => ({
      id: s.id,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      fileId: s.fileId,
      checks: s.checks,
      spent: s.values.spent,
      received: s.values.received,
      withdrawn: s.values.withdrawn,
      fees: s.values.fees,
      ending: s.values.ending,
      count: s.values.rows.filter((r) => r.cls !== 'funding').length,
    })),
    files: files.map((f) => ({ fileId: f.file_id, name: f.file_name, url: f.web_url, status: f.status, error: f.error })),
    flags: await openFlags(env, row.id),
  };
}
