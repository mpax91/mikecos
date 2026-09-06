import { NavLink } from 'react-router-dom';
import { useTabs } from '../contexts/TabsContext';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

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
        <nav className="sidebar__nav">
          <NavLink
            to="/projects"
            onClick={(e) => handleClick(e, '/projects')}
            onContextMenu={(e) => handleContextMenu(e, '/projects', 'Projects')}
            className={({ isActive }) => `sidebar__nav-item title-case${isActive ? ' is-active' : ''}`}
          >
            Projects
          </NavLink>
          <NavLink
            to="/notes"
            onClick={(e) => handleClick(e, '/notes')}
            onContextMenu={(e) => handleContextMenu(e, '/notes', 'Notes')}
            className={({ isActive }) => `sidebar__nav-item title-case${isActive ? ' is-active' : ''}`}
          >
            Notes
          </NavLink>
        </nav>
      </aside>
    </>
  );
}
