import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ProjectListItem } from '../api/types';
import { Badge } from '../components/Badge';
import { Modal } from '../components/Modal';

export function ProjectsList() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  function load() {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    if (!title.trim()) return;
    const project = await api.createProject(title.trim(), description.trim());
    setCreating(false);
    setTitle('');
    setDescription('');
    navigate(`/projects/${project.id}`);
  }

  if (error) return <div className="empty-state">Couldn't load projects: {error}</div>;
  if (!projects) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Projects
        </h1>
        <button className="btn" onClick={() => setCreating(true)}>
          + New project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">No projects yet — create your first one.</div>
      ) : (
        projects.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => navigate(`/projects/${p.id}`)}>
            <div style={{ minWidth: 0 }}>
              <p className="project-card__title">{p.title}</p>
              <p className="project-card__desc">{p.content || 'No description'}</p>
            </div>
            <div className="project-card__meta">
              <Badge>{p.child_count}</Badge>
            </div>
          </div>
        ))
      )}

      {creating && (
        <Modal title="New project" onClose={() => setCreating(false)}>
          <input
            autoFocus
            placeholder="Project name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleCreate} disabled={!title.trim()}>
              Create
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
