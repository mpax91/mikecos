import { NavLink } from 'react-router-dom';
import { useTabs, tabIcon, type TabKind } from '../contexts/TabsContext';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

interface NavItemDef {
  path: string;
  label: string;
  kind: TabKind;
}

const WORKSPACE_ITEMS: NavItemDef[] = [
  { path: '/today', label: 'Today', kind: 'today' },
  { path: '/projects', label: 'Projects', kind: 'projects-list' },
  { path: '/notes', label: 'Notes', kind: 'notes-list' },
  { path: '/jots', label: 'Jots', kind: 'jots-list' },
  { path: '/boards', label: 'Boards', kind: 'boards-list' },
  { path: '/stats', label: 'Stats', kind: 'stats' },
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
        <input className="sidebar__search" placeholder="Search" disabled title="Search — coming later" />

        <div className="sidebar__section">
          <div className="sidebar__section-label">Workspace</div>
          <nav className="sidebar__nav">{WORKSPACE_ITEMS.map(renderItem)}</nav>
        </div>

        <div className="sidebar__spacer" />

        <div className="sidebar__section sidebar__section--bottom">
          <nav className="sidebar__nav">{renderItem({ path: '/settings', label: 'Settings', kind: 'settings' })}</nav>
        </div>
      </aside>
    </>
  );
}
