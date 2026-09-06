import { Link, useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';

export function Breadcrumb({ trail, current }: { trail: Entity[]; current: Entity }) {
  const navigate = useNavigate();
  // A fixed "go to parent" destination computed from the actual hierarchy,
  // not browser history — history-based back (navigate(-1)) can land
  // somewhere unrelated once tabs are involved (switching tabs, restoring
  // them on reload, etc. all push their own history entries), whereas this
  // is always exactly one level up regardless of how you arrived here.
  const parentPath = trail.length > 0 ? `/projects/${trail[trail.length - 1].id}` : '/projects';

  return (
    <div className="breadcrumb">
      <button
        type="button"
        className="breadcrumb__back"
        onClick={() => navigate(parentPath)}
        title="Back"
        aria-label="Back"
      >
        ‹
      </button>
      <Link to="/projects" className="breadcrumb__link">
        Projects
      </Link>
      <span className="breadcrumb__sep">›</span>
      {trail.map((entity) => (
        <span key={entity.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link to={`/projects/${entity.id}`} className="breadcrumb__link">
            {entity.title}
          </Link>
          <span className="breadcrumb__sep">›</span>
        </span>
      ))}
      <span className="breadcrumb__current">{current.title}</span>
    </div>
  );
}
