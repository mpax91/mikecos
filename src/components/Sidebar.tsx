import { NavLink } from 'react-router-dom';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
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
            onClick={onClose}
            className={({ isActive }) => `sidebar__nav-item title-case${isActive ? ' is-active' : ''}`}
          >
            Projects
          </NavLink>
        </nav>
      </aside>
    </>
  );
}
