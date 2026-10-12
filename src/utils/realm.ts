/** The app-wide All / Personal / Work switch (top bar). Kept in a module
 * variable (read by api/client.ts on every request) plus localStorage, with
 * a window event so React state follows. Default: All. */
export type Realm = 'personal' | 'work';
export type RealmFilter = 'all' | Realm;

export const REALM_CHANGED_EVENT = 'mikeos:realm-changed';
const STORAGE_KEY = 'mikeos.realm';

function load(): RealmFilter {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'work' || v === 'personal' ? v : 'all';
  } catch {
    return 'all';
  }
}

let current: RealmFilter = load();

export function getRealm(): RealmFilter {
  return current;
}

export function setRealm(next: RealmFilter): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode — the switch still works for this session */
  }
  document.documentElement.dataset.realm = next;
  window.dispatchEvent(new CustomEvent(REALM_CHANGED_EVENT, { detail: next }));
}

if (typeof document !== 'undefined') document.documentElement.dataset.realm = current;

export const REALM_LABEL: Record<RealmFilter, string> = { all: 'All', personal: 'Personal', work: 'Work' };
