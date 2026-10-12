import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getRealm, setRealm, REALM_CHANGED_EVENT, type RealmFilter } from '../utils/realm';

interface RealmCtx {
  realm: RealmFilter;
  setRealm: (r: RealmFilter) => void;
}

const Ctx = createContext<RealmCtx>({ realm: 'all', setRealm });

export function RealmProvider({ children }: { children: ReactNode }) {
  const [realm, setState] = useState<RealmFilter>(getRealm());
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<RealmFilter>).detail);
    window.addEventListener(REALM_CHANGED_EVENT, on);
    return () => window.removeEventListener(REALM_CHANGED_EVENT, on);
  }, []);
  return <Ctx.Provider value={{ realm, setRealm }}>{children}</Ctx.Provider>;
}

export function useRealm(): RealmCtx {
  return useContext(Ctx);
}
