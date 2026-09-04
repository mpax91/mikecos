import { NavLink } from 'react-router-dom';

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar__wordmark">MikeOS</div>
      <input className="sidebar__search" placeholder="Search" disabled title="Search — coming later" />
      <nav className="sidebar__nav">
        <NavLink
          to="/projects"
          className={({ isActive }) => `sidebar__nav-item title-case${isActive ? ' is-active' : ''}`}
        >
          Projects
        </NavLink>
      </nav>
    </aside>
  );
}
