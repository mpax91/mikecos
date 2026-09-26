import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTabs, tabIcon, type TabKind } from '../contexts/TabsContext';
import { OPEN_SEARCH_EVENT } from './SearchPalette';
import { api } from '../api/client';

// Polled independently of whatever's currently open (the sidebar is
// mounted the whole time regardless of which page is showing) so the
// unread count in the nav stays current even when Inbox itself isn't the
// active tab. 2 minutes matches the worker's own IMAP sync cadence —
// polling faster than the underlying data actually changes just wastes a
// round trip.
const UNREAD_POLL_MS = 120_000;

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

interface NavItemDef {
  path: string;
  label: string;
  kind: TabKind;
}

interface NavSectionDef {
  label: string;
  items: NavItemDef[];
}

// Grouped by how each item actually gets used day to day, not alphabetically
// or by when it was added — see the sidebar-reorganization discussion this
// replaced the old single flat "Workspace" list with:
//   Now       — checked constantly regardless of what you're working on
//   Capture   — quick, low-friction writing (Lists included: often as fast
//               to jot as a note)
//   Plan      — structured, ongoing work
//   Reference — lookup data, not something you "do"
//   Insights  — summaries/analysis of everything else, including Journal
//               (you revisit entries more than you actively write in it)
const SIDEBAR_SECTIONS: NavSectionDef[] = [
  {
    label: 'Now',
    items: [
      { path: '/today', label: 'Today', kind: 'today' },
      { path: '/inbox', label: 'Inbox', kind: 'inbox' },
      { path: '/news', label: 'News', kind: 'news' },
      { path: '/bets', label: 'Bets', kind: 'bets' },
    ],
  },
  {
    label: 'Capture',
    items: [
      { path: '/jots', label: 'Jots', kind: 'jots-list' },
      { path: '/notes', label: 'Notes', kind: 'notes-list' },
      { path: '/lists', label: 'Lists', kind: 'lists-list' },
      { path: '/habits', label: 'Habits', kind: 'habits' },
    ],
  },
  {
    label: 'Plan',
    items: [
      { path: '/projects', label: 'Projects', kind: 'projects-list' },
      { path: '/boards', label: 'Boards', kind: 'boards-list' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { path: '/vault', label: 'Vault', kind: 'vault-list' },
      { path: '/wallet', label: 'Wallet', kind: 'wallet-list' },
      { path: '/plex', label: 'Plex', kind: 'plex-list' },
      { path: '/links', label: 'Links', kind: 'links' },
      { path: '/cloud', label: 'Cloud', kind: 'cloud' },
      { path: '/contacts', label: 'Contacts', kind: 'contacts-list' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { path: '/dashboard', label: 'Dashboard', kind: 'dashboard' },
      { path: '/stats', label: 'Stats', kind: 'stats' },
      { path: '/journal', label: 'Journal', kind: 'journal' },
    ],
  },
];

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const { openTab, showContextMenu } = useTabs();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function load() {
      api
        .getInboxFeed()
        .then((feed) => {
          if (cancelled) return;
          setUnreadCount(feed.accounts.reduce((sum, a) => sum + a.newCount, 0));
        })
        .catch(() => {
          // Best-effort — a transient failure just leaves the last-known
          // count showing rather than breaking the whole sidebar.
        });
    }
    load();
    const interval = setInterval(load, UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Plain click navigates the current tab (default NavLink behavior, left
  // untouched below). Cmd/ctrl-click — and right-click's "Open in New Tab" —
  // open the section in a new background tab instead, Chrome-style: the new
  // tab appears but focus stays put.
  function handleClick(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      openTab(path, { background: true });
      return;
    }
    onClose?.();
  }

  function handleContextMenu(e: React.MouseEvent, path: string, label: string) {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: `Open "${label}" in New Tab`, onClick: () => openTab(path, { background: true }) },
    ]);
  }

  function renderItem({ path, label, kind }: NavItemDef) {
    const badge = kind === 'inbox' && unreadCount > 0 ? unreadCount : null;
    return (
      <NavLink
        key={path}
        to={path}
        onClick={(e) => handleClick(e, path)}
        onContextMenu={(e) => handleContextMenu(e, path, label)}
        className={({ isActive }) => `sidebar__nav-item title-case${isActive ? ' is-active' : ''}`}
      >
        <span className="sidebar__nav-icon">{tabIcon(kind)}</span>
        {label}
        {badge !== null && <span className="sidebar__nav-badge">{badge}</span>}
      </NavLink>
    );
  }

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? ' is-open' : ''}`}>
        <div className="sidebar__top">
          <div className="sidebar__wordmark">MikeOS</div>
          <button className="sidebar__close" onClick={onClose} aria-label="Close menu" title="Close menu">
            ✕
          </button>
        </div>
        <button
          type="button"
          className="sidebar__search"
          onClick={() => {
            onClose?.();
            window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
          }}
          title="Search (⌘K)"
        >
          🔍 Search
        </button>

        <div className="sidebar__sections">
          {SIDEBAR_SECTIONS.map((section, i) => (
            <div className={`sidebar__section${i > 0 ? ' sidebar__section--divider' : ''}`} key={section.label}>
              <div className="sidebar__section-label">{section.label}</div>
              <nav className="sidebar__nav">{section.items.map(renderItem)}</nav>
            </div>
          ))}
        </div>

        <div className="sidebar__spacer" />

        <div className="sidebar__section sidebar__section--bottom">
          <nav className="sidebar__nav">{renderItem({ path: '/settings', label: 'Settings', kind: 'settings' })}</nav>
        </div>
      </aside>
    </>
  );
}
