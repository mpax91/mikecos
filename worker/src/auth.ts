import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Context } from 'hono';
import type { AuthCredentialRow, AuthCredentialSummary, Env } from './types';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const COOKIE_NAME = 'mikeos_session';
const SESSION_DAYS = 7;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 15;

// ---- byte/base64 helpers (Workers has global atob/btoa but not Buffer) ----

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function randomTokenBase64Url(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- PIN hashing (PBKDF2 via WebCrypto — no external hashing lib needed) ----

async function hashPin(pin: string, saltBytes?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  // 100,000 is the ceiling Cloudflare Workers' WebCrypto implementation
  // enforces for PBKDF2 — anything higher throws at deriveBits() time
  // rather than silently clamping, which is what "PBKDF2 failed:
  // iteration counts above 100000 are not supported" was.
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}
async function verifyPin(pin: string, hash: string, salt: string): Promise<boolean> {
  const { hash: computed } = await hashPin(pin, base64ToBytes(salt));
  return timingSafeEqual(computed, hash);
}

// ---- Backup code (single-use recovery) ----

const BACKUP_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids ambiguity if written down
function generateBackupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += BACKUP_CHARSET[b % BACKUP_CHARSET.length];
  return s.match(/.{1,4}/g)!.join('-');
}

// ---- Origin/RP-ID resolution ----
//
// WebAuthn's rpID and the CORS/cookie origin must be the *frontend's*
// domain (where navigator.credentials.create/get actually runs), not the
// Worker's own domain — so both are derived from the request's Origin
// header, checked against the ALLOWED_ORIGINS allowlist, rather than
// hardcoded. This also means local dev (http://localhost:5173) and
// production (https://mikeos.pages.dev) both work without separate config.
export function resolveOrigin(c: Context<{ Bindings: Env }>): string | null {
  const origin = c.req.header('origin');
  if (!origin) return null;
  const allowed = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function rpIdFor(origin: string): string {
  return new URL(origin).hostname;
}

function isLocalOrigin(origin: string): boolean {
  return /^http:\/\/localhost(:\d+)?$/.test(origin);
}

function setSessionCookie(c: Context<{ Bindings: Env }>, origin: string, token: string) {
  const local = isLocalOrigin(origin);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: !local,
    sameSite: local ? 'Lax' : 'None',
    path: '/',
    maxAge: 60 * 60 * 24 * SESSION_DAYS,
  });
}

// ---- DB access ----

function db(c: Context<{ Bindings: Env }>) {
  return c.env.DB;
}

async function credentialCount(c: Context<{ Bindings: Env }>): Promise<number> {
  const row = await db(c).prepare('SELECT COUNT(*) as n FROM auth_credentials').first<{ n: number }>();
  return row?.n ?? 0;
}

function toSummary(row: AuthCredentialRow): AuthCredentialSummary {
  return { id: row.id, type: row.type, device_label: row.device_label, created_at: row.created_at, last_used_at: row.last_used_at };
}

async function createSession(c: Context<{ Bindings: Env }>, credentialId: string | null): Promise<string> {
  const token = randomTokenBase64Url();
  const tokenHash = await sha256Hex(token);
  const ts = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db(c)
    .prepare('INSERT INTO auth_sessions (id, session_token_hash, credential_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(uid(), tokenHash, credentialId, ts, ts, expires)
    .run();
  return token;
}

interface SessionRow {
  id: string;
  session_token_hash: string;
  credential_id: string | null;
  expires_at: string;
}

async function getValidSession(c: Context<{ Bindings: Env }>): Promise<SessionRow | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await db(c).prepare('SELECT * FROM auth_sessions WHERE session_token_hash = ?').bind(hash).first<SessionRow>();
  if (!row) return null;
  if (row.expires_at <= now()) return null;
  return row;
}

/** Sliding 7-day window: touch the session on every authenticated request so
 * "use it at least once a week" never expires mid-week, but an idle week
 * does. Cheap enough to do unconditionally for a single-user app. */
async function touchSession(c: Context<{ Bindings: Env }>, session: SessionRow) {
  const ts = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db(c).prepare('UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').bind(ts, expires, session.id).run();
}

/** True once at least one credential exists anywhere — i.e. "first-run
 * setup is over." Registration endpoints are wide open (no session
 * required) only while this is false; after that, adding another device
 * requires an existing valid session, so the app is never left in a state
 * where an unauthenticated caller can add themselves a login. */
async function isBootstrapped(c: Context<{ Bindings: Env }>): Promise<boolean> {
  return (await credentialCount(c)) > 0;
}

async function requireAuthedOrBootstrap(c: Context<{ Bindings: Env }>): Promise<boolean> {
  if (!(await isBootstrapped(c))) return true;
  const session = await getValidSession(c);
  return session != null;
}

// ---- Exported middleware, mounted in index.ts ahead of every other /api route ----

export async function authGate(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (c.req.path.startsWith('/api/auth/')) return next();
  const session = await getValidSession(c);
  if (!session) {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
    return c.json({ error: 'unauthorized' }, 401);
  }
  await touchSession(c, session);
  return next();
}

// ---- Router ----

export const authRouter = new Hono<{ Bindings: Env }>();

authRouter.get('/status', async (c) => {
  const creds = await db(c).prepare('SELECT type FROM auth_credentials').all<{ type: 'webauthn' | 'pin' }>();
  const types = new Set((creds.results ?? []).map((r) => r.type));
  const session = await getValidSession(c);
  return c.json({
    has_credentials: types.size > 0,
    has_webauthn: types.has('webauthn'),
    has_pin: types.has('pin'),
    authenticated: session != null,
  });
});

authRouter.post('/webauthn/register/options', async (c) => {
  if (!(await requireAuthedOrBootstrap(c))) return c.json({ error: 'unauthorized' }, 401);
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const existing = await db(c)
    .prepare("SELECT webauthn_credential_id as id, webauthn_transports as transports FROM auth_credentials WHERE type = 'webauthn'")
    .all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: 'MikeOS',
    rpID: rpIdFor(origin),
    userName: 'mike',
    userDisplayName: 'Mike',
    // Fixed, non-PII, stable identifier — MikeOS is single-user so there's
    // no real "account" to distinguish this from, just a constant handle.
    userID: new TextEncoder().encode('mikeos-single-user'),
    attestationType: 'none',
    excludeCredentials: (existing.results ?? []).map((r) => ({ id: r.id, transports: r.transports ? JSON.parse(r.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required', authenticatorAttachment: 'platform' },
  });
  await db(c).prepare('INSERT INTO auth_challenges (id, challenge, purpose, created_at) VALUES (?, ?, ?, ?)').bind(options.challenge, options.challenge, 'register', now()).run();
  return c.json({ options });
});

authRouter.post('/webauthn/register/verify', async (c) => {
  if (!(await requireAuthedOrBootstrap(c))) return c.json({ error: 'unauthorized' }, 401);
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const body = await c.req.json<{ device_label?: string; challenge?: string; response: unknown }>();
  const label = (body.device_label ?? '').trim();
  if (!label) return c.json({ error: 'device_label is required' }, 400);

  const challengeRow = body.challenge
    ? await db(c).prepare("SELECT challenge FROM auth_challenges WHERE purpose = 'register' AND challenge = ?").bind(body.challenge).first<{ challenge: string }>()
    : null;
  if (!challengeRow) return c.json({ error: 'no pending registration — request options again' }, 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFor(origin),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'verification failed' }, 400);
  }
  await db(c).prepare("DELETE FROM auth_challenges WHERE purpose = 'register' AND challenge = ?").bind(challengeRow.challenge).run();
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: 'could not verify device' }, 400);

  const wasBootstrap = !(await isBootstrapped(c));
  const { credential } = verification.registrationInfo;
  const id = uid();
  await db(c)
    .prepare(
      'INSERT INTO auth_credentials (id, type, device_label, webauthn_credential_id, webauthn_public_key, webauthn_counter, webauthn_transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, 'webauthn', label, credential.id, bytesToBase64(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), now())
    .run();

  const token = await createSession(c, id);
  setSessionCookie(c, origin, token);

  let backupCode: string | null = null;
  if (wasBootstrap) backupCode = await issueBackupCode(c);
  return c.json({ ok: true, backup_code: backupCode });
});

authRouter.post('/webauthn/login/options', async (c) => {
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const existing = await db(c)
    .prepare("SELECT webauthn_credential_id as id, webauthn_transports as transports FROM auth_credentials WHERE type = 'webauthn'")
    .all<{ id: string; transports: string | null }>();
  const allowCredentials = (existing.results ?? []).map((r) => ({ id: r.id, transports: r.transports ? JSON.parse(r.transports) : undefined }));
  if (allowCredentials.length === 0) return c.json({ error: 'no biometric device registered' }, 400);
  const options = await generateAuthenticationOptions({ rpID: rpIdFor(origin), allowCredentials, userVerification: 'required' });
  await db(c).prepare('INSERT INTO auth_challenges (id, challenge, purpose, created_at) VALUES (?, ?, ?, ?)').bind(options.challenge, options.challenge, 'login', now()).run();
  return c.json({ options });
});

authRouter.post('/webauthn/login/verify', async (c) => {
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const body = await c.req.json<{ challenge?: string; response: { id: string } }>();
  const credRow = await db(c).prepare('SELECT * FROM auth_credentials WHERE webauthn_credential_id = ?').bind(body.response.id).first<AuthCredentialRow>();
  if (!credRow) return c.json({ error: 'unrecognized device' }, 400);

  const challengeRow = body.challenge
    ? await db(c).prepare("SELECT challenge FROM auth_challenges WHERE purpose = 'login' AND challenge = ?").bind(body.challenge).first<{ challenge: string }>()
    : null;
  if (!challengeRow) return c.json({ error: 'no pending login — request options again' }, 400);

  const credential: WebAuthnCredential = {
    id: credRow.webauthn_credential_id!,
    publicKey: base64ToBytes(credRow.webauthn_public_key!),
    counter: credRow.webauthn_counter ?? 0,
    transports: credRow.webauthn_transports ? JSON.parse(credRow.webauthn_transports) : undefined,
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdFor(origin),
      credential,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'verification failed' }, 400);
  }
  await db(c).prepare("DELETE FROM auth_challenges WHERE purpose = 'login' AND challenge = ?").bind(challengeRow.challenge).run();
  if (!verification.verified) return c.json({ error: 'could not verify' }, 400);

  await db(c)
    .prepare('UPDATE auth_credentials SET webauthn_counter = ?, last_used_at = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, now(), credRow.id)
    .run();

  const token = await createSession(c, credRow.id);
  setSessionCookie(c, origin, token);
  return c.json({ ok: true });
});

authRouter.post('/pin/setup', async (c) => {
  if (!(await requireAuthedOrBootstrap(c))) return c.json({ error: 'unauthorized' }, 401);
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const body = await c.req.json<{ pin?: string }>();
  const pin = (body.pin ?? '').trim();
  if (!/^\d{4,6}$/.test(pin)) return c.json({ error: 'PIN must be 4-6 digits' }, 400);

  const wasBootstrap = !(await isBootstrapped(c));
  const { hash, salt } = await hashPin(pin);
  const existing = await db(c).prepare("SELECT id FROM auth_credentials WHERE type = 'pin'").first<{ id: string }>();
  let id: string;
  if (existing) {
    id = existing.id;
    await db(c).prepare('UPDATE auth_credentials SET pin_hash = ?, pin_salt = ? WHERE id = ?').bind(hash, salt, id).run();
    // Changing the PIN invalidates any sessions that started from the old
    // one, but not sessions from other devices (webauthn) — only revoke
    // sessions tied to this specific credential.
    await db(c).prepare('DELETE FROM auth_sessions WHERE credential_id = ?').bind(id).run();
  } else {
    id = uid();
    await db(c)
      .prepare('INSERT INTO auth_credentials (id, type, device_label, pin_hash, pin_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, 'pin', 'Desktop PIN', hash, salt, now())
      .run();
  }

  const token = await createSession(c, id);
  setSessionCookie(c, origin, token);

  let backupCode: string | null = null;
  if (wasBootstrap) backupCode = await issueBackupCode(c);
  return c.json({ ok: true, backup_code: backupCode });
});

authRouter.post('/pin/login', async (c) => {
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const body = await c.req.json<{ pin?: string }>();
  const pin = (body.pin ?? '').trim();

  const row = await db(c).prepare("SELECT * FROM auth_credentials WHERE type = 'pin'").first<AuthCredentialRow>();
  if (!row || !row.pin_hash || !row.pin_salt) return c.json({ error: 'no PIN set up' }, 400);

  if (row.pin_locked_until && row.pin_locked_until > now()) {
    return c.json({ error: 'too many attempts — try again later' }, 429);
  }

  const ok = /^\d{4,6}$/.test(pin) && (await verifyPin(pin, row.pin_hash, row.pin_salt));
  if (!ok) {
    const fails = (row.pin_fail_count ?? 0) + 1;
    if (fails >= PIN_MAX_FAILS) {
      const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000).toISOString();
      await db(c).prepare('UPDATE auth_credentials SET pin_fail_count = 0, pin_locked_until = ? WHERE id = ?').bind(until, row.id).run();
      return c.json({ error: 'too many attempts — locked for 15 minutes' }, 429);
    }
    await db(c).prepare('UPDATE auth_credentials SET pin_fail_count = ? WHERE id = ?').bind(fails, row.id).run();
    return c.json({ error: 'incorrect PIN' }, 401);
  }

  await db(c).prepare('UPDATE auth_credentials SET pin_fail_count = 0, pin_locked_until = NULL, last_used_at = ? WHERE id = ?').bind(now(), row.id).run();
  const token = await createSession(c, row.id);
  setSessionCookie(c, origin, token);
  return c.json({ ok: true });
});

async function issueBackupCode(c: Context<{ Bindings: Env }>): Promise<string> {
  await db(c).prepare('UPDATE auth_backup_codes SET used_at = ? WHERE used_at IS NULL').bind(now()).run();
  const code = generateBackupCode();
  const hash = await sha256Hex(code);
  await db(c).prepare('INSERT INTO auth_backup_codes (id, code_hash, created_at) VALUES (?, ?, ?)').bind(uid(), hash, now()).run();
  return code;
}

authRouter.post('/backup-code/redeem', async (c) => {
  const origin = resolveOrigin(c);
  if (!origin) return c.json({ error: 'origin not allowed' }, 403);
  const body = await c.req.json<{ code?: string }>();
  const code = (body.code ?? '').trim().toUpperCase();
  if (!code) return c.json({ error: 'code is required' }, 400);
  const hash = await sha256Hex(code);
  const row = await db(c).prepare('SELECT id FROM auth_backup_codes WHERE code_hash = ? AND used_at IS NULL').bind(hash).first<{ id: string }>();
  if (!row) return c.json({ error: 'invalid or already-used code' }, 401);

  await db(c).prepare('UPDATE auth_backup_codes SET used_at = ? WHERE id = ?').bind(now(), row.id).run();
  const newCode = await issueBackupCode(c);
  // Recovery session isn't tied to any one credential — from here Mike
  // should head to Settings > Security to reset the PIN and/or register a
  // replacement device.
  const token = await createSession(c, null);
  setSessionCookie(c, origin, token);
  return c.json({ ok: true, backup_code: newCode });
});

authRouter.post('/backup-code/regenerate', async (c) => {
  const session = await getValidSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const code = await issueBackupCode(c);
  return c.json({ backup_code: code });
});

authRouter.get('/credentials', async (c) => {
  const session = await getValidSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const rows = await db(c).prepare('SELECT * FROM auth_credentials ORDER BY created_at ASC').all<AuthCredentialRow>();
  return c.json((rows.results ?? []).map(toSummary));
});

authRouter.delete('/credentials/:id', async (c) => {
  const session = await getValidSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const total = await credentialCount(c);
  if (total <= 1) return c.json({ error: "can't remove the last remaining login method" }, 400);
  await db(c).prepare('DELETE FROM auth_credentials WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

authRouter.post('/logout', async (c) => {
  const session = await getValidSession(c);
  if (session) await db(c).prepare('DELETE FROM auth_sessions WHERE id = ?').bind(session.id).run();
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});
