import type { Env } from './types';

/** Field-level encryption, shared by every feature that stores a real
 * secret in D1 — Payment Cards' number/CVV (PAYMENT_CARD_ENC_KEY), Email
 * Accounts' IMAP/SMTP app passwords (EMAIL_ACCOUNT_ENC_KEY), and Cloud
 * Storage's OAuth access/refresh tokens (CLOUD_ACCOUNT_ENC_KEY). AES-256-GCM
 * via the platform's own Web Crypto (no dependency needed), keyed by a
 * Cloudflare Worker secret that lives only in Cloudflare's secret store,
 * never in D1 and never in this repo. Deliberately NOT derived from the
 * app's PIN/WebAuthn unlock: these secrets need to stay readable across
 * every device/session the same way the rest of the data does, and tying
 * them to the login secret would mean losing every stored value the moment
 * that PIN changes. Each feature gets its own key (rather than sharing one)
 * so rotating or losing one doesn't touch the other. */

const cachedKeys = new Map<string, { raw: string; key: CryptoKey }>();

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

type EncKeyName = 'PAYMENT_CARD_ENC_KEY' | 'EMAIL_ACCOUNT_ENC_KEY' | 'CLOUD_ACCOUNT_ENC_KEY';

async function getKey(env: Env, envVarName: EncKeyName): Promise<CryptoKey> {
  const raw = env[envVarName];
  if (!raw) throw new EncryptionNotConfiguredError(envVarName);
  const cached = cachedKeys.get(envVarName);
  if (cached && cached.raw === raw) return cached.key;
  const keyBytes = b64ToBytes(raw);
  if (keyBytes.length !== 32) {
    throw new Error(`${envVarName} must decode (base64) to exactly 32 bytes — generate one with \`openssl rand -base64 32\``);
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  cachedKeys.set(envVarName, { raw, key });
  return key;
}

export class EncryptionNotConfiguredError extends Error {
  constructor(envVarName: string) {
    super(`${envVarName} is not set — this field can't be stored until this Worker secret is configured.`);
    this.name = 'EncryptionNotConfiguredError';
  }
}

/** Encrypts one field's plaintext. Stored as `ivBase64.cipherBase64` — a
 * fresh random 12-byte IV every call (IVs don't need to be secret, only
 * unique per encryption under the same key, which crypto.getRandomValues
 * guarantees for all practical purposes here). */
export async function encryptField(env: Env, plaintext: string, envVarName: EncKeyName = 'PAYMENT_CARD_ENC_KEY'): Promise<string> {
  const key = await getKey(env, envVarName);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

export async function decryptField(env: Env, stored: string, envVarName: EncKeyName = 'PAYMENT_CARD_ENC_KEY'): Promise<string> {
  const [ivB64, ctB64] = stored.split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed encrypted field');
  const key = await getKey(env, envVarName);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return new TextDecoder().decode(pt);
}
