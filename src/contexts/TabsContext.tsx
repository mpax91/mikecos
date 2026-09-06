import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';

export type TabKind = 'projects-list' | 'notes-list' | 'project' | 'folder' | 'note';

export interface Tab {
  id: string;
  path: string;
  title: string;
  kind: TabKind;
  pinned: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string;
}

const STORAGE_KEY = 'mikeos.tabs.v1';

function inferTabMeta(path: string): { kind: TabKind; title: string } {
  if (path === '/projects') return { kind: 'projects-list', title: 'Projects' };
  if (path === '/notes') return { kind: 'notes-list', title: 'Notes' };
  if (path.startsWith('/projects/')) return { kind: 'project', title: 'Project' };
  if (path.startsWith('/notes/')) return { kind: 'note', title: 'Note' };
  return { kind: 'projects-list', title: 'Projects' };
}

function makeTab(path: string): Tab {
  const meta = inferTabMeta(path);
  return {
    id: crypto.randomUUID(),
    path,
    title: meta.title,
    kind: meta.kind,
    pinned: false,
  };
}

function defaultState(): TabsState {
  const tab = makeTab('/projects');
  return { tabs: [tab], activeTabId: tab.id };
}

function loadState(): TabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return defaultState();
    const activeExists = parsed.tabs.some((t) => t.id === parsed.activeTabId);
    return {
      tabs: parsed.tabs,
      activeTabId: activeExists ? (parsed.activeTabId as string) : parsed.tabs[0].id,
    };
  } catch {
    return defaultState();
  }
}

interface TabsContextValue {
  tabs: Tab[];
  activeTabId: string;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  openTab: (path: string, opts?: { background?: boolean }) => void;
  pinTab: (id: string) => void;
  unpinTab: (id: string) => void;
  reportActiveTabMeta: (title: string, kind?: TabKind) => void;
  showContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
}

const TabsCtx = createContext<TabsContextValue | null>(null);

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error('useTabs must be used within a TabsProvider');
  return ctx;
}

/** Mounted inside <BrowserRouter> (needs useNavigate/useLocation) but
 * outside/above <App> so every page can reach it. Owns the browser-style
 * tab strip: which items are open, which is active, and persists both
 * (debounced) to localStorage so tabs survive an app restart. */
export function TabsProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<TabsState>(loadState);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const persistTimer = useRef<number | null>(null);

  const persist = useCallback((next: TabsState, immediate = false) => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    const write = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort — storage may be full or unavailable
      }
    };
    if (immediate) write();
    else persistTimer.current = window.setTimeout(write, 400);
  }, []);

  // The single source of truth for "which tab am I in" is react-router's own
  // location — every regular navigate() (a NavLink click, a page calling
  // navigate() after creating something, browser back/forward) ends up here,
  // and the active tab's path/kind/title just follow along. This is what
  // makes "click a sidebar link" implicitly navigate the *current* tab
  // without any special-casing at each call site.
  useEffect(() => {
    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === prev.activeTabId);
      if (idx === -1 || prev.tabs[idx].path === location.pathname) return prev;
      const meta = inferTabMeta(location.pathname);
      const tabs = prev.tabs.slice();
      tabs[idx] = { ...tabs[idx], path: location.pathname, kind: meta.kind, title: meta.title };
      const next = { ...prev, tabs };
      persist(next);
      return next;
    });
  }, [location.pathname, persist]);

  const switchTab = useCallback(
    (id: string) => {
      if (state.activeTabId === id) return;
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      const next = { ...state, activeTabId: id };
      setState(next);
      persist(next, true);
      navigate(tab.path);
    },
    [state, navigate, persist]
  );

  const openTab = useCallback(
    (path: string, opts?: { background?: boolean }) => {
      const tab = makeTab(path);
      // A new tab always lands at the very end — to the right of every other
      // tab, browser-style — never in front of or between existing ones.
      // Pinned tabs still end up first overall since pinTab/unpinTab keep
      // them sorted to the front of the array independently of this.
      const tabs = [...state.tabs, tab];
      const next: TabsState = { tabs, activeTabId: opts?.background ? state.activeTabId : tab.id };
      setState(next);
      persist(next, true);
      if (!opts?.background) navigate(path);
    },
    [state, navigate, persist]
  );

  const closeTab = useCallback(
    (id: string) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const tabs = state.tabs.filter((t) => t.id !== id);
      // Closing the last remaining tab shouldn't leave zero tabs open —
      // reset back to a single fresh Projects tab instead.
      if (tabs.length === 0) {
        const fresh = defaultState();
        setState(fresh);
        persist(fresh, true);
        navigate(fresh.tabs[0].path);
        return;
      }
      let activeTabId = state.activeTabId;
      let navTo: string | null = null;
      if (activeTabId === id) {
        const neighbor = tabs[idx] ?? tabs[idx - 1];
        activeTabId = neighbor.id;
        navTo = neighbor.path;
      }
      const next = { tabs, activeTabId };
      setState(next);
      persist(next, true);
      if (navTo) navigate(navTo);
    },
    [state, navigate, persist]
  );

  const pinTab = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab || tab.pinned) return;
      const rest = state.tabs.filter((t) => t.id !== id);
      const lastPinnedIdx = rest.reduce((acc, t, i) => (t.pinned ? i : acc), -1);
      const tabs = rest.slice();
      tabs.splice(lastPinnedIdx + 1, 0, { ...tab, pinned: true });
      const next = { ...state, tabs };
      setState(next);
      persist(next, true);
    },
    [state, persist]
  );

  const unpinTab = useCallback(
    (id: string) => {
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, pinned: false } : t));
      const next = { ...state, tabs };
      setState(next);
      persist(next, true);
    },
    [state, persist]
  );

  // Called by pages (via useReportTabMeta) once real data loads, so a tab
  // shows "Job Search" instead of the generic "Project" placeholder. Uses
  // the functional setState form since it fires on every keystroke while a
  // title is being typed.
  const reportActiveTabMeta = useCallback(
    (title: string, kind?: TabKind) => {
      setState((prev) => {
        const idx = prev.tabs.findIndex((t) => t.id === prev.activeTabId);
        if (idx === -1) return prev;
        const current = prev.tabs[idx];
        if (current.title === title && (!kind || current.kind === kind)) return prev;
        const tabs = prev.tabs.slice();
        tabs[idx] = { ...current, title, kind: kind ?? current.kind };
        const next = { ...prev, tabs };
        persist(next); // debounced — avoids hammering localStorage while typing
        return next;
      });
    },
    [persist]
  );

  const showContextMenu = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setContextMenu({ x, y, items });
  }, []);

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      switchTab,
      closeTab,
      openTab,
      pinTab,
      unpinTab,
      reportActiveTabMeta,
      showContextMenu,
    }),
    [state, switchTab, closeTab, openTab, pinTab, unpinTab, reportActiveTabMeta, showContextMenu]
  );

  return (
    <TabsCtx.Provider value={value}>
      {children}
      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
    </TabsCtx.Provider>
  );
}

/** Pages call this once loaded data gives them a real title (and, rarely, a
 * more specific kind — e.g. a folder vs. its parent project) so the active
 * tab's label/icon stay in sync instead of being stuck on the generic
 * "Project"/"Note" placeholder inferred from the URL alone. */
export function useReportTabMeta(title: string | undefined, kind?: TabKind) {
  const { reportActiveTabMeta } = useTabs();
  useEffect(() => {
    if (title !== undefined) reportActiveTabMeta(title, kind);
  }, [title, kind, reportActiveTabMeta]);
}

export function tabIcon(kind: TabKind): string {
  return kind === 'notes-list' || kind === 'note' ? '📝' : '📁';
}
