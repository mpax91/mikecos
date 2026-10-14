import { api } from '../api/client';

/** Turning task-reminder notifications on/off for THIS browser. The
 * service worker (vite-plugin-pwa + public/push-sw.js) receives them. */

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(b64url: string): Uint8Array {
  const pad = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

/** A friendly name for the device list ("Chrome on Windows", "Android"…). */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : 'Desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const app = window.matchMedia?.('(display-mode: standalone)').matches ? ' (App)' : '';
  return `${browser} on ${os}${app}`;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('The app’s service worker isn’t running here (it only runs on the live site, not in dev).');
  return navigator.serviceWorker.ready;
}

/** This browser's current subscription endpoint, if any. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export async function enablePushHere(): Promise<void> {
  if (!pushSupported()) throw new Error('This browser can’t receive notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for MikeOS in this browser’s site settings.' : 'Permission wasn’t granted.');
  const reg = await registration();
  const { publicKey } = await api.getPushKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different key can't be reused.
  if (sub) {
    const existing = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    const want = keyBytes(publicKey);
    if (!existing || existing.length !== want.length || existing.some((b, i) => b !== want[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  await api.pushSubscribe(sub.toJSON(), deviceLabel());
}

export async function disablePushHere(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe({ endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}
