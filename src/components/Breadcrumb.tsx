import { Link } from 'react-router-dom';
import type { Entity } from '../api/types';

export function Breadcrumb({ trail, current }: { trail: Entity[]; current: Entity }) {
  return (
    <div className="breadcrumb">
      {trail.map((entity) => (
        <span key={entity.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link to={`/projects/${entity.id}`}>{entity.title}</Link>
          <span className="breadcrumb__sep">/</span>
        </span>
      ))}
      <span className="breadcrumb__current">{current.title}</span>
    </div>
  );
}
