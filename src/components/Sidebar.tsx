import { NavLink } from 'react-router-dom';
import { useTabs, tabIcon, type TabKind } from '../contexts/TabsContext';
import { OPEN_SEARCH_EVENT } from './SearchPalette';

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
      { path: '/links', label: 'Links', kind: 'links' },
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
