import { Hono } from 'hono';
import type { Env } from './types';
import { encryptField, decryptField, EncryptionNotConfiguredError } from './cryptoField';
import { ImapClient, parseHeaderBlock, type ParsedAddress } from './imapClient';
import { sendMail } from './smtpClient';
import { parseMimeMessageToParts, decodeSnippet } from './mimeParser';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Inbox — a live status board over Mike's real Gmail inboxes (IMAP), not a
 * built-in mail client. See imapClient.ts/smtpClient.ts for the protocol
 * layer and worker/migrations/0059_email_inbox.sql for the schema
 * rationale. Mounted at /api/email. Cron-driven sync lives in
 * syncAllAccounts, called from index.ts's `scheduled` export. */
export const emailRouter = new Hono<{ Bindings: Env }>();

interface EmailAccountRow {
  id: string;
  label: string;
  email: string;
  app_password_enc: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  icon: string;
  icon_image_key: string | null;
  color: string;
  position: number;
  active: number;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EmailMessageRow {
  id: string;
  account_id: string;
  gm_msgid: string;
  gm_thrid: string | null;
  uid: number;
  message_id_header: string | null;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  snippet: string | null;
  received_at: string;
  is_read: number;
  in_inbox: number;
  processed_at: string | null;
  converted_to_entity_id: string | null;
  first_seen_at: string;
  created_at: string;
  updated_at: string;
}

function accountJson(row: EmailAccountRow) {
  // app_password_enc deliberately never leaves the server — once set, the
  // Settings UI can only overwrite it, never read it back.
  const { app_password_enc: _enc, ...rest } = row;
  return { ...rest, iconImageUrl: row.icon_image_key ? `/api/files/${row.icon_image_key}` : null };
}

// ---- Accounts (Settings → Email Accounts) ----

emailRouter.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM email_accounts ORDER BY position ASC, created_at ASC').all<EmailAccountRow>();
  return c.json((results ?? []).map(accountJson));
});

emailRouter.post('/accounts', async (c) => {
  const body = await c.req.json<{
    label: string;
    email: string;
    appPassword: string;
    icon?: string;
    iconImageKey?: string | null;
    color?: string;
    imapHost?: string;
    imapPort?: number;
    smtpHost?: string;
    smtpPort?: number;
  }>();
  if (!body.label?.trim() || !body.email?.trim() || !body.appPassword?.trim()) {
    return c.json({ error: 'label, email, and appPassword are required' }, 400);
  }
  let enc: string;
  try {
    enc = await encryptField(c.env, body.appPassword.trim(), 'EMAIL_ACCOUNT_ENC_KEY');
  } catch (err) {
    if (err instanceof EncryptionNotConfiguredError) return c.json({ error: err.message }, 500);
    throw err;
  }

  const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as m FROM email_accounts').first<{ m: number }>();
  const id = uid();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO email_accounts (id, label, email, app_password_enc, imap_host, imap_port, smtp_host, smtp_port, icon, icon_image_key, color, position, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(
      id,
      body.label.trim(),
      body.email.trim(),
      enc,
      body.imapHost?.trim() || 'imap.gmail.com',
      body.imapPort ?? 993,
      body.smtpHost?.trim() || 'smtp.gmail.com',
      body.smtpPort ?? 465,
      body.icon?.trim() || '📧',
      body.iconImageKey || null,
      body.color?.trim() || '#2F4A3C',
      (maxPos?.m ?? -1) + 1,
      ts,
      ts
    )
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(id).first<EmailAccountRow>();
  return c.json(accountJson(row!), 201);
});

emailRouter.patch('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    label?: string;
    email?: string;
    appPassword?: string;
    icon?: string;
    iconImageKey?: string | null;
    color?: string;
    active?: boolean;
    imapHost?: string;
    imapPort?: number;
    smtpHost?: string;
    smtpPort?: number;
    position?: number;
  }>();
  const existing = await c.env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(id).first<EmailAccountRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };
  if (body.label !== undefined) set('label', body.label.trim());
  if (body.email !== undefined) set('email', body.email.trim());
  if (body.icon !== undefined) set('icon', body.icon.trim());
  // Swapping to a new image (or clearing it) orphans the old R2 object —
  // clean it up the same way payment_cards.cover_art_key does, rather than
  // leaking storage every time Mike changes an account's icon.
  if (body.iconImageKey !== undefined && existing.icon_image_key && existing.icon_image_key !== body.iconImageKey) {
    await c.env.FILES.delete(existing.icon_image_key).catch(() => {});
  }
  if (body.iconImageKey !== undefined) set('icon_image_key', body.iconImageKey || null);
  if (body.color !== undefined) set('color', body.color.trim());
  if (body.active !== undefined) set('active', body.active ? 1 : 0);
  if (body.imapHost !== undefined) set('imap_host', body.imapHost.trim());
  if (body.imapPort !== undefined) set('imap_port', body.imapPort);
  if (body.smtpHost !== undefined) set('smtp_host', body.smtpHost.trim());
  if (body.smtpPort !== undefined) set('smtp_port', body.smtpPort);
  if (body.position !== undefined) set('position', body.position);
  if (body.appPassword?.trim()) {
    try {
      set('app_password_enc', await encryptField(c.env, body.appPassword.trim(), 'EMAIL_ACCOUNT_ENC_KEY'));
    } catch (err) {
      if (err instanceof EncryptionNotConfiguredError) return c.json({ error: err.message }, 500);
      throw err;
    }
  }
  if (fields.length === 0) return c.json(accountJson(existing));

  set('updated_at', now());
  await c.env.DB.prepare(`UPDATE email_accounts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(id).first<EmailAccountRow>();
  return c.json(accountJson(row!));
});

emailRouter.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT icon_image_key FROM email_accounts WHERE id = ?').bind(id).first<{ icon_image_key: string | null }>();
  if (existing?.icon_image_key) await c.env.FILES.delete(existing.icon_image_key).catch(() => {});
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM email_pending_actions WHERE account_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM email_messages WHERE account_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM email_accounts WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// Connects and logs in only — for a "Test Connection" button in Settings,
// so a typo'd app password surfaces immediately instead of silently
// failing on the next cron tick.
emailRouter.post('/accounts/:id/test', async (c) => {
  const id = c.req.param('id');
  const account = await c.env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(id).first<EmailAccountRow>();
  if (!account) return c.json({ error: 'not found' }, 404);
  try {
    const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');
    const client = new ImapClient();
    await client.connect(account.imap_host, account.imap_port);
    await client.login(account.email, pass);
    await client.selectInbox();
    await client.logout();
    await c.env.DB.prepare('UPDATE email_accounts SET last_error = NULL, updated_at = ? WHERE id = ?').bind(now(), id).run();
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare('UPDATE email_accounts SET last_error = ?, updated_at = ? WHERE id = ?').bind(message, now(), id).run();
    return c.json({ ok: false, error: message }, 200);
  }
});

// Diagnostic only, read-only (no writes to email_messages or the real
// mailbox) — connects live and reports exactly what Gmail's IMAP is
// saying about the messages currently in this account's needs-processing
// queue: their real X-GM-LABELS and FLAGS, straight from the server,
// rather than what MikeOS last synced. Built to chase down why messages
// that are snoozed in Gmail (with a future return date) were showing up
// as "Needs Processing" the same day they were snoozed — this surfaces
// whether Gmail's IMAP is genuinely still reporting \Inbox for them (a
// real Gmail/IMAP quirk MikeOS would need a different data source to work
// around) or whether the label list looks like it should have excluded
// them (pointing at a bug in this hand-written IMAP client instead,
// which had never run against a live account before this one — see
// imapClient.ts's header comment).
emailRouter.get('/accounts/:id/debug-inbox', async (c) => {
  const id = c.req.param('id');
  const account = await c.env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(id).first<EmailAccountRow>();
  if (!account) return c.json({ error: 'not found' }, 404);

  const needsProcessing = (
    await c.env.DB.prepare(
      `SELECT gm_msgid, uid, subject, received_at FROM email_messages WHERE account_id = ? AND in_inbox = 1 AND is_read = 1 AND processed_at IS NULL ORDER BY received_at ASC`
    )
      .bind(id)
      .all<{ gm_msgid: string; uid: number; subject: string; received_at: string }>()
  ).results ?? [];

  try {
    const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');
    const client = new ImapClient();
    await client.connect(account.imap_host, account.imap_port);
    await client.login(account.email, pass);

    const mailboxNames = await client.listMailboxes();
    // Gmail's IMAP has been confirmed (by hand, against a real account) to
    // still report a currently-snoozed message as present in a plain
    // "SELECT INBOX; UID SEARCH ALL" — there is no per-message flag/label
    // over IMAP that distinguishes it from ordinary inbox mail. The one
    // remaining possibility this checks: a separate virtual mailbox Gmail
    // might expose for snoozed mail (by analogy with "[Gmail]/All Mail",
    // "[Gmail]/Sent Mail", etc.) that a message currently sitting in
    // Snoozed would also show up under — if one exists, cross-referencing
    // its contents against "needs processing" is a real, IMAP-only fix;
    // if not, filtering snoozed mail here needs Gmail's own API instead.
    const snoozedMailboxName = mailboxNames.find((n) => /snooz/i.test(n)) ?? null;
    const gmMsgIdsInSnoozedMailbox = snoozedMailboxName ? new Set(await client.selectAndListGmMsgIds(snoozedMailboxName)) : null;

    await client.selectInbox();
    const uidsInInbox = await client.searchAllUids();
    // Only the UIDs MikeOS currently has parked in "needs processing" —
    // not the whole mailbox — so this stays fast and small regardless of
    // how big the real inbox is.
    const targetUids = needsProcessing.map((m) => m.uid).filter((u) => uidsInInbox.includes(u));
    const debugRows = await client.fetchLabelsDebug(targetUids.join(','));
    await client.logout();

    const byUid = new Map(debugRows.map((r) => [r.uid, r]));
    const messages = needsProcessing.map((m) => ({
      subject: m.subject,
      receivedAt: m.received_at,
      uid: m.uid,
      stillInImapSearchAllResults: uidsInInbox.includes(m.uid),
      liveFlags: byUid.get(m.uid)?.flags ?? null,
      liveGmLabels: byUid.get(m.uid)?.gmLabels ?? null,
      alsoInSnoozedMailbox: gmMsgIdsInSnoozedMailbox ? gmMsgIdsInSnoozedMailbox.has(m.gm_msgid) : null,
    }));

    return c.json({
      accountEmail: account.email,
      mailboxNames,
      snoozedMailboxName,
      totalUidsInImapInboxSearch: uidsInInbox.length,
      needsProcessingCount: needsProcessing.length,
      messages,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// Manual "Sync now" — the same sync a cron tick runs, callable on demand
// from Settings or the Inbox feed's own refresh button.
emailRouter.post('/sync', async (c) => {
  const results = await syncAllAccounts(c.env);
  return c.json({ results });
});

// ---- Feed (Today → Inbox) ----
//
// One flat list — everything still sitting in the mailbox's Inbox
// (in_inbox = 1, meaning: not archived, not deleted, not converted to a
// task/note). Used to be split into "New" vs "Needs Processing" (a GTD-
// style read/unread-but-undealt-with distinction), but for these
// secondary, rarely-checked mailboxes that distinction wasn't useful —
// Mike's actual want is simpler: don't let something sit in there
// unnoticed. So the list is unified and `isRead` just controls how a row
// looks (unread = bold), not which bucket it's in.

emailRouter.get('/inbox', async (c) => {
  const accountId = c.req.query('account_id');
  const accounts = (
    await c.env.DB.prepare('SELECT * FROM email_accounts WHERE active = 1 ORDER BY position ASC, created_at ASC').all<EmailAccountRow>()
  ).results ?? [];

  const scoped = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  const ids = scoped.map((a) => a.id);
  if (ids.length === 0) return c.json({ accounts: [], items: [] });

  const placeholders = ids.map(() => '?').join(',');
  const items = (
    await c.env.DB.prepare(
      `SELECT * FROM email_messages WHERE account_id IN (${placeholders}) AND in_inbox = 1 ORDER BY received_at DESC`
    )
      .bind(...ids)
      .all<EmailMessageRow>()
  ).results ?? [];

  // Counts for every active account (not just the scoped one) so the tab
  // strip can show a badge on each account regardless of which is selected.
  const counts = await Promise.all(
    accounts.map(async (a) => {
      const row = await c.env.DB.prepare(
        `SELECT
           SUM(CASE WHEN in_inbox = 1 AND is_read = 0 THEN 1 ELSE 0 END) as unread_count,
           SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) as total_count
         FROM email_messages WHERE account_id = ?`
      )
        .bind(a.id)
        .first<{ unread_count: number; total_count: number }>();
      return { ...accountJson(a), unreadCount: row?.unread_count ?? 0, totalCount: row?.total_count ?? 0 };
    })
  );

  return c.json({ accounts: counts, items });
});

async function getMessageWithAccount(env: Env, id: string) {
  const message = await env.DB.prepare('SELECT * FROM email_messages WHERE id = ?').bind(id).first<EmailMessageRow>();
  if (!message) return null;
  const account = await env.DB.prepare('SELECT * FROM email_accounts WHERE id = ?').bind(message.account_id).first<EmailAccountRow>();
  if (!account) return null;
  return { message, account };
}

// Archiving is instant in MikeOS (this update) and queued for the real
// mailbox (applied on the next sync tick, which is already connecting to
// every account anyway — see applyPendingActions). "Archived" and
// "processed" are the same action from Mike's side.
emailRouter.post('/messages/:id/archive', async (c) => {
  const id = c.req.param('id');
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const ts = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_messages SET in_inbox = 0, processed_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, id),
    c.env.DB.prepare('INSERT INTO email_pending_actions (id, account_id, message_id, action, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      uid(),
      found.message.account_id,
      id,
      'archive',
      ts
    ),
  ]);
  return c.json({ ok: true });
});

// Peek — fetches the full raw message live (bodies aren't cached in D1,
// see migration's header comment) and decodes it two ways (see
// mimeParser.ts): `body`, clean plain text for contexts that just need
// something readable (the compact Today widget, reply-quoting later);
// `bodyHtml`, the sender's actual HTML part (lightly stripped of
// anything actively unsafe, not fully sanitized — see
// stripActivelyUnsafe's own comment for why that's enough here), for
// rendering a message the way an actual email client would instead of a
// plain-text conversion that drops formatting and turns inline images
// into "[image: Google]"-style alt text. Also marks \Seen on the real
// mailbox in the same connection, plus flips is_read locally. A live IMAP
// round trip per peek (roughly a second, dominated by the TLS handshake),
// which is fine for an on-demand single-message action.
emailRouter.post('/messages/:id/peek', async (c) => {
  const id = c.req.param('id');
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const { message, account } = found;

  let body = '';
  let bodyHtml: string | null = null;
  try {
    const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');
    const client = new ImapClient();
    await client.connect(account.imap_host, account.imap_port);
    await client.login(account.email, pass);
    await client.selectInbox();
    const raw = await client.fetchRawMessage(message.uid);
    const parsed = parseMimeMessageToParts(raw);
    body = parsed.text;
    bodyHtml = parsed.html;
    if (!message.is_read) await client.setSeen(message.uid, true);
    await client.logout();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  await c.env.DB.prepare('UPDATE email_messages SET is_read = 1, updated_at = ? WHERE id = ?').bind(now(), id).run();
  return c.json({ ...message, is_read: 1, body, bodyHtml });
});

// Real delete — distinct from Archive (which just files it out of Inbox
// into All Mail). Same instant-locally/queued-for-real-mailbox split as
// archive: in_inbox flips to 0 right away so it disappears from the feed,
// and the actual Gmail Trash move happens on the next sync tick via
// applyPendingActions + ImapClient.trash.
emailRouter.post('/messages/:id/delete', async (c) => {
  const id = c.req.param('id');
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const ts = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE email_messages SET in_inbox = 0, processed_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, id),
    c.env.DB.prepare('INSERT INTO email_pending_actions (id, account_id, message_id, action, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      uid(),
      found.message.account_id,
      id,
      'trash',
      ts
    ),
  ]);
  return c.json({ ok: true });
});

// Undo for Archive/Delete — the Inbox undo toast's server side. In the
// common case (the toast is clicked within its few-second window) the real
// mailbox change hasn't happened yet — applyPendingActions only runs on the
// next cron tick, up to ~2 minutes later — so cancelling the still-queued
// pending_actions row and flipping in_inbox back to 1 is the whole story,
// no IMAP round trip needed. Only when the toast loses that race (a slow
// click, or the cron happened to fire in between) does this fall back to
// actually reversing the change on the real mailbox.
emailRouter.post('/messages/:id/undo', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ kind: 'archive' | 'trash' }>();
  if (body.kind !== 'archive' && body.kind !== 'trash') return c.json({ error: 'kind must be "archive" or "trash"' }, 400);
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const { message, account } = found;

  const pending = await c.env.DB.prepare(
    `SELECT id FROM email_pending_actions WHERE message_id = ? AND action = ? AND applied_at IS NULL ORDER BY created_at DESC LIMIT 1`
  )
    .bind(id, body.kind)
    .first<{ id: string }>();

  try {
    if (pending) {
      await c.env.DB.prepare('DELETE FROM email_pending_actions WHERE id = ?').bind(pending.id).run();
    } else {
      const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');
      const client = new ImapClient();
      await client.connect(account.imap_host, account.imap_port);
      await client.login(account.email, pass);
      await client.selectInbox();
      if (body.kind === 'archive') await client.restoreToInbox(message.uid);
      else await client.untrash(message.uid);
      await client.logout();
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  await c.env.DB.prepare('UPDATE email_messages SET in_inbox = 1, processed_at = NULL, updated_at = ? WHERE id = ?').bind(now(), id).run();
  return c.json({ ok: true });
});

// Undo for Take Action / Save as Note / Jot — since converting no longer
// touches the email's Inbox status at all (see /messages/:id/convert),
// undoing one is just deleting the entity it created and clearing the
// email's back-reference to it. Recursive in the same way DELETE
// /api/entities/:id is, though a freshly-converted entity never has
// children yet in practice.
emailRouter.post('/messages/:id/unconvert', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ entityId: string }>();
  if (!body.entityId) return c.json({ error: 'entityId is required' }, 400);
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(body.entityId),
    c.env.DB.prepare('UPDATE email_messages SET converted_to_entity_id = NULL, updated_at = ? WHERE id = ? AND converted_to_entity_id = ?').bind(
      now(),
      id,
      body.entityId
    ),
  ]);
  return c.json({ ok: true });
});

// Turns an email into a real MikeOS entity — the replacement for Gmail's
// snooze (see the design discussion this was built from): instead of
// hiding the email and reshowing it later, it becomes a real task ("Take
// Action", scheduled via dueDate), a Note, or a Jot (a title-optional quick
// capture — see /api/jots).
//
// Mike's own call: this does NOT touch the email's Inbox status. Earlier
// versions archived the source message the instant it was converted, which
// meant the email vanished from Inbox at the same moment as the thing
// "processing" it was created — there was nowhere left to see that a task
// had come from an email, and no way to tell MikeOS "actually, hold off."
// The email now stays right where it is; `converted_to_entity_id` just
// remembers which entity it became, so a task's own completion (see
// index.ts's PATCH /api/entities/:id) can archive it automatically once
// Mike actually deals with the task — that's the real "processed" moment.
// Notes/Jots have no equivalent completion signal, so those stay in Inbox
// until Mike archives them himself, same as any other message.
emailRouter.post('/messages/:id/convert', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ as: 'task' | 'note' | 'jot'; parentId?: string | null; dueDate?: string | null }>();
  if (body.as !== 'task' && body.as !== 'note' && body.as !== 'jot') return c.json({ error: 'as must be "task", "note", or "jot"' }, 400);
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const { message } = found;

  const entityId = uid();
  const ts = now();
  const title = message.subject || 'Untitled';
  const byline = message.from_name || message.from_email ? `From: ${message.from_name ?? ''} <${message.from_email ?? ''}>` : '';
  const bodyText = [byline, '', message.snippet ?? ''].filter(Boolean).join('\n');

  if (body.as === 'task') {
    const isTopLevel = !body.parentId;
    const maxPos = await c.env.DB.prepare(
      isTopLevel
        ? `SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = 'task'`
        : 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
    )
      .bind(...(isTopLevel ? [] : [body.parentId]))
      .first<{ m: number }>();
    await c.env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, due_date, last_touched, created_at, updated_at)
       VALUES (?, 'task', ?, NULL, ?, ?, 'open', ?, ?, ?, ?, ?)`
    )
      .bind(entityId, title, body.parentId ?? null, isTopLevel ? 1 : 0, (maxPos?.m ?? -1) + 1, body.dueDate ?? null, ts, ts, ts)
      .run();
  } else if (body.as === 'jot') {
    // Same shape as POST /api/jots — a title-optional type='note' row with
    // is_jot=1, always top-level (Jots aren't nested under a project).
    // Given a title here (the email's subject) rather than leaving it
    // blank like a typical Keep-style jot, since "which email was this"
    // is worth keeping visible.
    const contentJson = JSON.stringify({
      type: 'doc',
      content: bodyText.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
    });
    await c.env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text, is_jot)
       VALUES (?, 'note', ?, ?, NULL, 1, NULL, 0, ?, ?, ?, ?, 1)`
    )
      .bind(entityId, title, contentJson, ts, ts, ts, bodyText)
      .run();
  } else {
    const isTopLevel = !body.parentId;
    const maxPos = await c.env.DB.prepare(
      isTopLevel ? 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id IS NULL AND type = \'note\'' : 'SELECT COALESCE(MAX(position), -1) as m FROM entities WHERE parent_id = ?'
    )
      .bind(...(isTopLevel ? [] : [body.parentId]))
      .first<{ m: number }>();
    const contentJson = JSON.stringify({
      type: 'doc',
      content: bodyText.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
    });
    await c.env.DB.prepare(
      `INSERT INTO entities (id, type, title, content, parent_id, is_top_level, status, position, last_touched, created_at, updated_at, search_text)
       VALUES (?, 'note', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    )
      .bind(entityId, title, contentJson, body.parentId ?? null, isTopLevel ? 1 : 0, (maxPos?.m ?? -1) + 1, ts, ts, ts, bodyText)
      .run();
  }

  await c.env.DB.prepare('UPDATE email_messages SET converted_to_entity_id = ?, updated_at = ? WHERE id = ?').bind(entityId, ts, id).run();

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(entityId).first();
  return c.json({ entity, entityId });
});

// A deliberately minimal reply — plain text, threaded via In-Reply-To/
// References so it lands in the same Gmail thread. Not a full compose
// client (see the design conversation this came out of): no attachments,
// no BCC, and "reply all" only widens To/Cc to the original message's own
// recipients — it never lets Mike add someone new.
emailRouter.post('/messages/:id/reply', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ body: string; archive?: boolean; mode?: 'sender' | 'all' }>();
  if (!body.body?.trim()) return c.json({ error: 'body is required' }, 400);
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const { message, account } = found;
  if (!message.from_email) return c.json({ error: "This message has no parseable sender address to reply to" }, 400);

  try {
    const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');

    // Reply-all needs the original message's To/Cc, which the regular sync
    // never stores (fetchMessages only pulls From/Subject/Date/Message-ID —
    // see imapClient.ts) — so this opens a live IMAP connection just to read
    // those two headers off the real mailbox, same "one extra round trip for
    // an on-demand action" trade Inbox already makes for peek/forward.
    let toRecipients: ParsedAddress[] = [];
    let ccRecipients: ParsedAddress[] = [];
    if (body.mode === 'all') {
      const client = new ImapClient();
      await client.connect(account.imap_host, account.imap_port);
      await client.login(account.email, pass);
      await client.selectInbox();
      const addr = await client.fetchAddressHeaders(message.uid);
      await client.logout();
      toRecipients = addr.to;
      ccRecipients = addr.cc;
    }

    const selfEmail = account.email.trim().toLowerCase();
    const seen = new Set<string>();
    const toEmails: string[] = [];
    const ccEmails: string[] = [];
    const addTo = (email: string | null | undefined) => {
      if (!email) return;
      const key = email.trim().toLowerCase();
      if (!key || key === selfEmail || seen.has(key)) return;
      seen.add(key);
      toEmails.push(email.trim());
    };
    const addCc = (email: string | null | undefined) => {
      if (!email) return;
      const key = email.trim().toLowerCase();
      if (!key || key === selfEmail || seen.has(key)) return;
      seen.add(key);
      ccEmails.push(email.trim());
    };

    addTo(message.from_email);
    if (body.mode === 'all') {
      for (const a of toRecipients) addTo(a.email);
      for (const a of ccRecipients) addCc(a.email);
    }
    if (toEmails.length === 0) return c.json({ error: 'No recipients to reply to' }, 400);

    await sendMail({
      host: account.smtp_host,
      port: account.smtp_port,
      user: account.email,
      pass,
      fromEmail: account.email,
      toEmails,
      ccEmails: ccEmails.length > 0 ? ccEmails : undefined,
      subject: message.subject.toLowerCase().startsWith('re:') ? message.subject : `Re: ${message.subject}`,
      bodyText: body.body,
      inReplyTo: message.message_id_header,
      references: message.message_id_header,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  if (body.archive) {
    const ts = now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE email_messages SET in_inbox = 0, processed_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, id),
      c.env.DB.prepare('INSERT INTO email_pending_actions (id, account_id, message_id, action, created_at) VALUES (?, ?, ?, ?, ?)').bind(
        uid(),
        found.message.account_id,
        id,
        'archive',
        ts
      ),
    ]);
  }
  return c.json({ ok: true });
});

// Forward — no address book of its own (Gmail's forward autocompletes from
// its own Contacts; MikeOS's Inbox has no equivalent), so the frontend
// feeds this a raw email address, typed free-hand or picked from Mike's
// existing MikeOS Contacts. Re-fetches the original message over IMAP
// (same as peek) to quote its real body under a standard
// "---------- Forwarded message ----------" header block, rather than
// forwarding just the truncated list-view snippet.
emailRouter.post('/messages/:id/forward', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ to: string; note?: string }>();
  const to = body.to?.trim();
  if (!to) return c.json({ error: 'to is required' }, 400);
  const found = await getMessageWithAccount(c.env, id);
  if (!found) return c.json({ error: 'not found' }, 404);
  const { message, account } = found;

  try {
    const pass = await decryptField(c.env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');

    const client = new ImapClient();
    await client.connect(account.imap_host, account.imap_port);
    await client.login(account.email, pass);
    await client.selectInbox();
    const raw = await client.fetchRawMessage(message.uid);
    const { text: originalText } = parseMimeMessageToParts(raw);
    await client.logout();

    const from = message.from_name ? `${message.from_name} <${message.from_email ?? ''}>` : message.from_email ?? 'Unknown sender';
    const forwardBlock = [
      '---------- Forwarded message ----------',
      `From: ${from}`,
      `Date: ${new Date(message.received_at).toLocaleString('en-US')}`,
      `Subject: ${message.subject}`,
      `To: ${account.email}`,
      '',
      originalText,
    ].join('\n');
    const bodyText = body.note?.trim() ? `${body.note.trim()}\n\n${forwardBlock}` : forwardBlock;
    const subjectLower = message.subject.toLowerCase();
    const subject = subjectLower.startsWith('fwd:') || subjectLower.startsWith('fw:') ? message.subject : `Fwd: ${message.subject}`;

    await sendMail({
      host: account.smtp_host,
      port: account.smtp_port,
      user: account.email,
      pass,
      fromEmail: account.email,
      toEmails: [to],
      subject,
      bodyText,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  return c.json({ ok: true });
});

// ---- Sync engine (cron + manual "Sync now") ----

async function applyPendingActions(env: Env, client: ImapClient, accountId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT pa.id as action_id, pa.action, pa.message_id, m.uid
     FROM email_pending_actions pa JOIN email_messages m ON m.id = pa.message_id
     WHERE pa.account_id = ? AND pa.applied_at IS NULL`
  )
    .bind(accountId)
    .all<{ action_id: string; action: string; message_id: string; uid: number }>();

  for (const row of results ?? []) {
    try {
      if (row.action === 'archive') await client.archive(row.uid);
      else if (row.action === 'trash') await client.trash(row.uid);
      else if (row.action === 'mark_read') await client.setSeen(row.uid, true);
      else if (row.action === 'mark_unread') await client.setSeen(row.uid, false);
      await env.DB.prepare('UPDATE email_pending_actions SET applied_at = ? WHERE id = ?').bind(now(), row.action_id).run();
    } catch (err) {
      // Left unapplied — retried on the next sync tick. One bad action
      // (e.g. a since-deleted message) shouldn't block the rest of the
      // queue or this account's inbox sync below.
      console.error('email pending action failed', accountId, row.action, err);
    }
  }
}

async function syncAccountInbox(env: Env, client: ImapClient, account: EmailAccountRow): Promise<void> {
  const uids = await client.searchAllUids();
  const uidSet = uids.join(',');
  const fetched = await client.fetchMessages(uidSet);
  const ts = now();

  const seenGmIds = new Set<string>();
  for (const f of fetched) {
    if (!f.gmMsgId) continue; // shouldn't happen against Gmail, but skip rather than crash the whole sync
    seenGmIds.add(f.gmMsgId);
    const headers = parseHeaderBlock(f.headerBlock);
    const isSeen = f.flags.includes('\\Seen') ? 1 : 0;
    const existing = await env.DB.prepare('SELECT * FROM email_messages WHERE account_id = ? AND gm_msgid = ?')
      .bind(account.id, f.gmMsgId)
      .first<EmailMessageRow>();

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO email_messages (id, account_id, gm_msgid, gm_thrid, uid, message_id_header, subject, from_name, from_email, snippet, received_at, is_read, in_inbox, first_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
        .bind(
          uid(),
          account.id,
          f.gmMsgId,
          f.gmThrId,
          f.uid,
          headers.messageId,
          headers.subject || '(no subject)',
          headers.fromName,
          headers.fromEmail,
          decodeSnippet(f.snippet, f.snippetMime),
          headers.dateIso ?? ts,
          isSeen,
          ts,
          ts,
          ts
        )
        .run();
    } else {
      // A message reappearing after being out of the inbox (unsnoozed, or
      // manually re-added to Inbox) surfaces as new again — reset
      // first_seen_at/processed_at so it lands back in "New" rather than
      // silently staying archived-looking. A message that was already
      // in_inbox just gets its live fields refreshed.
      const reappeared = existing.in_inbox === 0;
      await env.DB.prepare(
        `UPDATE email_messages SET uid = ?, is_read = ?, in_inbox = 1, first_seen_at = ?, processed_at = ?, updated_at = ? WHERE id = ?`
      )
        .bind(f.uid, isSeen, reappeared ? ts : existing.first_seen_at, reappeared ? null : existing.processed_at, ts, existing.id)
        .run();
    }
  }

  // Anything MikeOS still had marked in_inbox=1 for this account that
  // didn't show up in this poll's fetch has left the real INBOX — archived,
  // snoozed, or moved by a filter. Mirror that as processed/archived here
  // too, same as the design this was built from.
  const stillInInbox = (
    await env.DB.prepare('SELECT id, gm_msgid FROM email_messages WHERE account_id = ? AND in_inbox = 1').bind(account.id).all<{ id: string; gm_msgid: string }>()
  ).results ?? [];
  const droppedIds = stillInInbox.filter((r) => !seenGmIds.has(r.gm_msgid)).map((r) => r.id);
  if (droppedIds.length > 0) {
    const placeholders = droppedIds.map(() => '?').join(',');
    await env.DB.prepare(`UPDATE email_messages SET in_inbox = 0, processed_at = COALESCE(processed_at, ?), updated_at = ? WHERE id IN (${placeholders})`)
      .bind(ts, ts, ...droppedIds)
      .run();
  }
}


async function syncOneAccount(env: Env, account: EmailAccountRow): Promise<{ id: string; ok: boolean; error?: string }> {
  let client: ImapClient | null = null;
  try {
    const pass = await decryptField(env, account.app_password_enc, 'EMAIL_ACCOUNT_ENC_KEY');
    client = new ImapClient();
    await client.connect(account.imap_host, account.imap_port);
    await client.login(account.email, pass);
    await client.selectInbox();
    await applyPendingActions(env, client, account.id);
    // Re-select — a STORE against Gmail can shift what's visible in the
    // currently-selected mailbox's cached state; a fresh SELECT keeps the
    // subsequent SEARCH/FETCH honest rather than relying on IMAP's
    // untagged-update notifications, which this client doesn't track.
    await client.selectInbox();
    await syncAccountInbox(env, client, account);
    await client.logout();
    await env.DB.prepare('UPDATE email_accounts SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .bind(now(), now(), account.id)
      .run();
    return { id: account.id, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE email_accounts SET last_error = ?, updated_at = ? WHERE id = ?').bind(message, now(), account.id).run();
    return { id: account.id, ok: false, error: message };
  }
}

export async function syncAllAccounts(env: Env): Promise<{ id: string; ok: boolean; error?: string }[]> {
  const { results } = await env.DB.prepare('SELECT * FROM email_accounts WHERE active = 1').all<EmailAccountRow>();
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const account of results ?? []) {
    // Sequential, not Promise.all — each account holds a live TCP socket
    // for the duration of its sync, and there's no benefit to juggling
    // several at once for what's realistically 4-5 personal mailboxes.
    out.push(await syncOneAccount(env, account));
  }
  return out;
}
