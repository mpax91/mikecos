import { Link, useNavigate } from 'react-router-dom';
import type { Entity } from '../api/types';

export function Breadcrumb({ trail, current }: { trail: Entity[]; current: Entity }) {
  const navigate = useNavigate();

  return (
    <div className="breadcrumb">
      <button
        type="button"
        className="breadcrumb__back"
        onClick={() => navigate(-1)}
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
