import type { Env } from './types';

/** Field-level encryption for Payment Cards' number/CVV — the "upgrade"
 * Mike approved when he agreed to store real card numbers in MikeOS. AES-
 * 256-GCM via the platform's own Web Crypto (no dependency needed), keyed
 * by PAYMENT_CARD_ENC_KEY — a Cloudflare Worker secret that lives only in
 * Cloudflare's secret store, never in D1 and never in this repo. This is
 * deliberately NOT derived from the app's PIN/WebAuthn unlock: a payment
 * card needs to stay readable across every device/session the same way
 * every other Wallet card already is, and tying it to the login secret
 * would mean losing every stored number the moment that PIN changes. */

let cachedKey: { raw: string; key: CryptoKey } | null = null;

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function getKey(env: Env): Promise<CryptoKey> {
  const raw = env.PAYMENT_CARD_ENC_KEY;
  if (!raw) throw new EncryptionNotConfiguredError();
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  const keyBytes = b64ToBytes(raw);
  if (keyBytes.length !== 32) {
    throw new Error('PAYMENT_CARD_ENC_KEY must decode (base64) to exactly 32 bytes — generate one with `openssl rand -base64 32`');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  cachedKey = { raw, key };
  return key;
}

export class EncryptionNotConfiguredError extends Error {
  constructor() {
    super('PAYMENT_CARD_ENC_KEY is not set — Payment Cards cannot store a number or CVV until this Worker secret is configured.');
    this.name = 'EncryptionNotConfiguredError';
  }
}

/** Encrypts one field's plaintext. Stored as `ivBase64.cipherBase64` — a
 * fresh random 12-byte IV every call (IVs don't need to be secret, only
 * unique per encryption under the same key, which crypto.getRandomValues
 * guarantees for all practical purposes here). */
export async function encryptField(env: Env, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

export async function decryptField(env: Env, stored: string): Promise<string> {
  const [ivB64, ctB64] = stored.split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed encrypted field');
  const key = await getKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return new TextDecoder().decode(pt);
}
