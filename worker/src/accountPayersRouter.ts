import { Hono } from 'hono';
import type { Env } from './types';
import { loadPayer, payerLabel, syncPaymentFacts } from './accountPayers';
import type { PayerRow } from './accountPayers';
import { derive, loadFolder } from './statements/engine';

/** Account payers — which card pays which account. Mounted at
 * /api/account-payers. Set from either side: a Wallet payment card's
 * "Pays For" section, or the Vault entry's Paid With fact. */
export const accountPayersRouter = new Hono<{ Bindings: Env }>();

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** The Statements folder behind an entry, if live — so flags and the
 * payment facts refresh right away instead of waiting for the nightly scan. */
async function refresh(env: Env, entryId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT id FROM statement_folders WHERE vault_entry_id = ? AND status = 'live' LIMIT 1`).bind(entryId).first<{ id: string }>();
  const folder = row ? await loadFolder(env, row.id) : null;
  if (folder) {
    try {
      await derive(env, folder);
      return;
    } catch (err) {
      console.error('account payer: derive failed', err);
    }
  }
  await syncPaymentFacts(env, entryId);
}

async function payerJson(env: Env, p: PayerRow | null) {
  if (!p) return null;
  return {
    entryId: p.entry_id,
    mode: p.mode,
    paymentCardId: p.payment_card_id,
    payerText: p.payer_text,
    dueDay: p.due_day,
    label: await payerLabel(env, p),
  };
}

// GET /?cardId=… — the accounts one card pays (Wallet "Pays For").
accountPayersRouter.get('/', async (c) => {
  const cardId = c.req.query('cardId');
  if (!cardId) return c.json({ error: 'cardId required' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT ap.entry_id, ap.mode, e.title,
            (SELECT sf.id FROM statement_folders sf WHERE sf.vault_entry_id = ap.entry_id AND sf.status = 'live' LIMIT 1) AS folder_id,
            (SELECT vf.value FROM vault_facts vf WHERE vf.entry_id = ap.entry_id AND vf.managed_key = 'pay:latest' LIMIT 1) AS latest_bill,
            (SELECT vf.value FROM vault_facts vf WHERE vf.entry_id = ap.entry_id AND vf.managed_key = 'pay:due' LIMIT 1) AS due
       FROM account_payers ap
       JOIN entities e ON e.id = ap.entry_id AND e.type = 'vault_entry'
      WHERE ap.payment_card_id = ?
      ORDER BY ap.mode ASC, e.title COLLATE NOCASE`
  )
    .bind(cardId)
    .all<{ entry_id: string; mode: string; title: string; folder_id: string | null; latest_bill: string | null; due: string | null }>();
  return c.json(
    (results ?? []).map((r) => ({ entryId: r.entry_id, title: r.title, mode: r.mode, folderId: r.folder_id, latestBill: r.latest_bill, due: r.due }))
  );
});

// GET /entry/:entryId — the payer for one account (or null).
accountPayersRouter.get('/entry/:entryId', async (c) => {
  return c.json(await payerJson(c.env, await loadPayer(c.env, c.req.param('entryId'))));
});

// PUT /entry/:entryId — set (create or replace) the payer.
accountPayersRouter.put('/entry/:entryId', async (c) => {
  const entryId = c.req.param('entryId');
  const body = await c.req.json<{ mode?: string; paymentCardId?: string | null; payerText?: string | null; dueDay?: number | null }>();
  const entry = await c.env.DB.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'vault_entry'`).bind(entryId).first();
  if (!entry) return c.json({ error: 'Vault entry not found' }, 404);
  const mode = body.mode === 'on_file' ? 'on_file' : 'autopay';
  const cardId = body.paymentCardId || null;
  const text = cardId ? null : body.payerText?.trim() || null;
  if (!cardId && !text) return c.json({ error: 'Pick a card or type what pays it' }, 400);
  if (cardId) {
    const card = await c.env.DB.prepare('SELECT id FROM payment_cards WHERE id = ?').bind(cardId).first();
    if (!card) return c.json({ error: 'Card not found' }, 404);
  }
  const day = body.dueDay ? Math.max(1, Math.min(31, Math.round(Number(body.dueDay)))) : null;
  const existing = await loadPayer(c.env, entryId);
  if (existing) {
    await c.env.DB.prepare('UPDATE account_payers SET mode = ?, payment_card_id = ?, payer_text = ?, due_day = ?, updated_at = ? WHERE id = ?')
      .bind(mode, cardId, text, day, now(), existing.id)
      .run();
  } else {
    await c.env.DB.prepare('INSERT INTO account_payers (id, entry_id, mode, payment_card_id, payer_text, due_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), entryId, mode, cardId, text, day, now(), now())
      .run();
  }
  // Setting the payment method explicitly brings its facts back even if
  // Mike had deleted/edited them earlier.
  await c.env.DB.prepare(`DELETE FROM vault_fact_releases WHERE entry_id = ? AND managed_key IN ('pay:paid_with', 'pay:autopay', 'pay:due')`).bind(entryId).run();
  await refresh(c.env, entryId);
  return c.json(await payerJson(c.env, await loadPayer(c.env, entryId)));
});

// DELETE /entry/:entryId — no card on file any more.
accountPayersRouter.delete('/entry/:entryId', async (c) => {
  const entryId = c.req.param('entryId');
  await c.env.DB.prepare('DELETE FROM account_payers WHERE entry_id = ?').bind(entryId).run();
  await refresh(c.env, entryId);
  return c.json({ ok: true });
});
