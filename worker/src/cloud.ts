import { Hono } from 'hono';
import type { Env } from './types';
import { encryptField, decryptField, EncryptionNotConfiguredError } from './cryptoField';
import { ALL_PROVIDERS, PROVIDER_LABELS, getAdapter, isConfigured } from './cloudProviders/registry';
import type { CloudProviderId } from './cloudProviders/types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Cloud — a Windows-Explorer-style view over Mike's real cloud storage
 * accounts (Google Drive/OneDrive/Dropbox/Box), each connected via OAuth.
 * Mounted at /api/cloud. Unlike Bookmarks, there's no local copy of the
 * file tree: every browse/search/download call hits the provider live,
 * using that account's stored (encrypted) tokens — see
 * worker/migrations/0061_cloud_storage.sql and cloudProviders/*.ts for the
 * adapter layer this router is built on. */
export const cloudRouter = new Hono<{ Bindings: Env }>();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes is generous for actually completing a consent screen
const QUOTA_STALE_MS = 60 * 60 * 1000; // quota rarely changes minute to minute — re-check at most hourly
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000; // refresh a bit before the provider actually expires it

const PROVIDER_ICON: Record<CloudProviderId, string> = {
  google_drive: '📁',
  onedrive: '☁️',
  dropbox: '📦',
  box: '🗃️',
};
const PROVIDER_COLOR: Record<CloudProviderId, string> = {
  google_drive: '#1a73e8',
  onedrive: '#0078d4',
  dropbox: '#0061fe',
  box: '#0061d5',
};

interface CloudAccountRow {
  id: string;
  provider: CloudProviderId;
  label: string;
  account_email: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string;
  scope: string | null;
  icon: string;
  color: string;
  position: number;
  status: 'connected' | 'error';
  last_error: string | null;
  quota_used_bytes: number | null;
  quota_total_bytes: number | null;
  quota_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

function accountJson(row: CloudAccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: PROVIDER_LABELS[row.provider],
    label: row.label,
    accountEmail: row.account_email,
    icon: row.icon,
    color: row.color,
    position: row.position,
    status: row.status,
    lastError: row.last_error,
    quota:
      row.quota_used_bytes === null
        ? null
        : { usedBytes: row.quota_used_bytes, totalBytes: row.quota_total_bytes, checkedAt: row.quota_checked_at },
  };
}

/** Returns a live, usable access token for this account — refreshing and
 * persisting a new one first if the stored token is at or near expiry.
 * Marks the account `status = 'error'` (surfaced in Settings) rather than
 * throwing silently, so a revoked/broken connection is visible instead of
 * just failing every browse call forever with no explanation. */
async function getValidAccessToken(env: Env, row: CloudAccountRow): Promise<string> {
  const expiresAt = new Date(row.token_expires_at).getTime();
  if (Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return decryptField(env, row.access_token_enc, 'CLOUD_ACCOUNT_ENC_KEY');
  }
  if (!row.refresh_token_enc) {
    await env.DB.prepare('UPDATE cloud_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind('error', 'Access expired and no refresh token was issued — disconnect and reconnect this account.', now(), row.id)
      .run();
    throw new Error('This account’s access expired and it has no refresh token — reconnect it in Settings.');
  }
  const adapter = getAdapter(env, row.provider);
  const refreshToken = await decryptField(env, row.refresh_token_enc, 'CLOUD_ACCOUNT_ENC_KEY');
  try {
    const tokens = await adapter.refreshAccessToken(refreshToken);
    const accessEnc = await encryptField(env, tokens.accessToken, 'CLOUD_ACCOUNT_ENC_KEY');
    // Some providers (Box, notably) rotate the refresh token on every use
    // and invalidate the old one — always persist whatever came back,
    // falling back to the existing encrypted value only when the provider
    // didn't re-issue one.
    const refreshEnc = tokens.refreshToken ? await encryptField(env, tokens.refreshToken, 'CLOUD_ACCOUNT_ENC_KEY') : row.refresh_token_enc;
    await env.DB.prepare(
      'UPDATE cloud_accounts SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?'
    )
      .bind(accessEnc, refreshEnc, tokens.expiresAt, 'connected', now(), row.id)
      .run();
    return tokens.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE cloud_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind('error', message, now(), row.id)
      .run();
    throw new Error(`Couldn’t refresh ${PROVIDER_LABELS[row.provider]} access for "${row.label}" — reconnect it in Settings.`);
  }
}

async function loadAccount(env: Env, id: string): Promise<CloudAccountRow | null> {
  return env.DB.prepare('SELECT * FROM cloud_accounts WHERE id = ?').bind(id).first<CloudAccountRow>();
}

// ---- Providers (Settings → Cloud Storage: which ones are set up) ----

cloudRouter.get('/providers', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT provider, COUNT(*) as n FROM cloud_accounts GROUP BY provider').all<{
    provider: CloudProviderId;
    n: number;
  }>();
  const counts = new Map((results ?? []).map((r) => [r.provider, r.n]));
  return c.json(
    ALL_PROVIDERS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      configured: isConfigured(c.env, id),
      connectedCount: counts.get(id) ?? 0,
    }))
  );
});

// ---- Accounts ----

cloudRouter.get('/accounts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM cloud_accounts ORDER BY position ASC, created_at ASC').all<CloudAccountRow>();
  const rows = results ?? [];

  // Opportunistically refresh any quota that's gone stale, one account at
  // a time — this only ever touches accounts that are actually stale, so
  // a normal page load with fresh caches makes zero extra provider calls.
  for (const row of rows) {
    const stale = !row.quota_checked_at || Date.now() - new Date(row.quota_checked_at).getTime() > QUOTA_STALE_MS;
    if (!stale || row.status === 'error') continue;
    try {
      const accessToken = await getValidAccessToken(c.env, row);
      const adapter = getAdapter(c.env, row.provider);
      const quota = await adapter.getQuota(accessToken);
      row.quota_used_bytes = quota.usedBytes;
      row.quota_total_bytes = quota.totalBytes;
      row.quota_checked_at = now();
      await c.env.DB.prepare('UPDATE cloud_accounts SET quota_used_bytes = ?, quota_total_bytes = ?, quota_checked_at = ? WHERE id = ?')
        .bind(quota.usedBytes, quota.totalBytes, row.quota_checked_at, row.id)
        .run();
    } catch {
      // A quota refresh failing shouldn't block the whole account list from loading — it'll just show the last-known figure (or none).
    }
  }

  return c.json(rows.map(accountJson));
});

cloudRouter.delete('/accounts/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM cloud_accounts WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

cloudRouter.get('/accounts/:id/browse', async (c) => {
  const row = await loadAccount(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'Account not found' }, 404);
  try {
    const accessToken = await getValidAccessToken(c.env, row);
    const adapter = getAdapter(c.env, row.provider);
    const folderId = c.req.query('folderId') || null;
    const entries = await adapter.listFolder(accessToken, folderId);
    return c.json({ entries });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

cloudRouter.get('/accounts/:id/download', async (c) => {
  const row = await loadAccount(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'Account not found' }, 404);
  const fileId = c.req.query('fileId');
  const name = c.req.query('name') || 'download';
  if (!fileId) return c.json({ error: 'fileId is required' }, 400);
  try {
    const accessToken = await getValidAccessToken(c.env, row);
    const adapter = getAdapter(c.env, row.provider);
    const providerRes = await adapter.downloadFile(accessToken, fileId);
    // Stream the provider's own response body straight through — the
    // Worker never buffers the file, so this scales to whatever size the
    // provider itself is willing to serve.
    return new Response(providerRes.body, {
      headers: {
        'Content-Type': providerRes.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---- Cross-account search ----

cloudRouter.get('/search', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [] });
  const { results: rows } = await c.env.DB.prepare("SELECT * FROM cloud_accounts WHERE status = 'connected'").all<CloudAccountRow>();

  const perAccount = await Promise.all(
    (rows ?? []).map(async (row) => {
      try {
        const accessToken = await getValidAccessToken(c.env, row);
        const adapter = getAdapter(c.env, row.provider);
        const hits = await adapter.search(accessToken, q);
        return hits.map((hit) => ({ ...hit, accountId: row.id, accountLabel: row.label, provider: row.provider }));
      } catch {
        return []; // one broken account shouldn't fail the whole cross-account search
      }
    })
  );

  return c.json({ results: perAccount.flat() });
});

// ---- OAuth: connect / callback ----

cloudRouter.get('/:provider/oauth/start', async (c) => {
  const provider = c.req.param('provider') as CloudProviderId;
  if (!ALL_PROVIDERS.includes(provider)) return c.json({ error: 'Unknown provider' }, 400);
  if (!isConfigured(c.env, provider)) {
    return c.json({ error: `${PROVIDER_LABELS[provider]} isn’t set up yet — it needs an OAuth app registered first (see Settings → Cloud Storage).` }, 400);
  }
  const label = c.req.query('label')?.trim();
  if (!label) return c.json({ error: 'A label is required (e.g. "Personal" or "Work")' }, 400);
  const returnOrigin = c.req.query('returnOrigin') || c.env.ALLOWED_ORIGINS.split(',')[0];

  // Sweep expired states while we're here rather than running a separate cron for it.
  await c.env.DB.prepare('DELETE FROM cloud_oauth_states WHERE created_at < ?').bind(new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString()).run();

  const state = uid();
  await c.env.DB.prepare('INSERT INTO cloud_oauth_states (state, provider, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, provider, `${label}\u0000${returnOrigin}`, now())
    .run();

  const redirectUri = `${new URL(c.req.url).origin}/api/cloud/oauth/callback`;
  const adapter = getAdapter(c.env, provider);
  return c.redirect(adapter.getAuthUrl(state, redirectUri));
});

cloudRouter.get('/oauth/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const providerError = c.req.query('error');
  const stateRow = state ? await c.env.DB.prepare('SELECT * FROM cloud_oauth_states WHERE state = ?').bind(state).first<{ provider: CloudProviderId; label: string; created_at: string }>() : null;
  if (stateRow) await c.env.DB.prepare('DELETE FROM cloud_oauth_states WHERE state = ?').bind(state).run();

  const [label, returnOrigin] = (stateRow?.label ?? '\u0000').split('\u0000');
  const backTo = (query: string) => c.redirect(`${returnOrigin || c.env.ALLOWED_ORIGINS.split(',')[0]}/settings?cat=cloud&${query}`);

  if (!stateRow) return backTo('cloudError=' + encodeURIComponent('That connection attempt expired — try again.'));
  if (providerError) return backTo('cloudError=' + encodeURIComponent(`${PROVIDER_LABELS[stateRow.provider]} declined the connection.`));
  if (!code) return backTo('cloudError=' + encodeURIComponent('No authorization code came back — try again.'));

  try {
    const redirectUri = `${new URL(c.req.url).origin}/api/cloud/oauth/callback`;
    const adapter = getAdapter(c.env, stateRow.provider);
    const tokens = await adapter.exchangeCode(code, redirectUri);
    const accessEnc = await encryptField(c.env, tokens.accessToken, 'CLOUD_ACCOUNT_ENC_KEY');
    const refreshEnc = tokens.refreshToken ? await encryptField(c.env, tokens.refreshToken, 'CLOUD_ACCOUNT_ENC_KEY') : null;
    const maxPos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) as m FROM cloud_accounts').first<{ m: number }>();
    const id = uid();
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO cloud_accounts (id, provider, label, account_email, access_token_enc, refresh_token_enc, token_expires_at, scope, icon, color, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)`
    )
      .bind(
        id,
        stateRow.provider,
        label,
        tokens.accountEmail,
        accessEnc,
        refreshEnc,
        tokens.expiresAt,
        tokens.scope ?? null,
        PROVIDER_ICON[stateRow.provider],
        PROVIDER_COLOR[stateRow.provider],
        (maxPos?.m ?? -1) + 1,
        ts,
        ts
      )
      .run();
    return backTo('cloudConnected=1');
  } catch (err) {
    const message = err instanceof EncryptionNotConfiguredError ? err.message : err instanceof Error ? err.message : String(err);
    return backTo('cloudError=' + encodeURIComponent(message));
  }
});
