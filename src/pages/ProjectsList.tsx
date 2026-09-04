import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ProjectListItem } from '../api/types';
import { Modal } from '../components/Modal';
import { ProjectCard } from '../components/ProjectCard';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { SortableGrid } from '../components/SortableGrid';

export function ProjectsList() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ProjectListItem | null>(null);
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null);
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

  async function handleReorder(ordered: ProjectListItem[]) {
    setProjects(ordered);
    await api.reorder(
      null,
      ordered.map((o) => o.id)
    );
  }

  async function handleTogglePin(p: ProjectListItem) {
    const next = p.pinned === 1 ? 0 : 1;
    setProjects((prev) => (prev ? prev.map((x) => (x.id === p.id ? { ...x, pinned: next } : x)) : prev));
    await api.setPinned(p.id, next === 1);
    load();
  }

  async function handleRename(p: ProjectListItem, newTitle: string) {
    setProjects((prev) => (prev ? prev.map((x) => (x.id === p.id ? { ...x, title: newTitle } : x)) : prev));
    await api.updateEntity(p.id, { title: newTitle });
  }

  async function handleDelete(p: ProjectListItem) {
    setProjects((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
    await api.deleteEntity(p.id);
    setDeleting(null);
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
          + New Project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">No projects yet — create your first one.</div>
      ) : (
        <SortableGrid
          items={projects}
          onReorder={handleReorder}
          className="project-card-list"
          renderItem={(p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onDelete={setDeleting}
              onTogglePin={handleTogglePin}
              onRename={setRenaming}
            />
          )}
        />
      )}

      {creating && (
        <Modal title="New Project" onClose={() => setCreating(false)}>
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

      {renaming && (
        <RenameModal
          initialValue={renaming.title}
          label="Project name"
          onSave={(v) => handleRename(renaming, v)}
          onClose={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete project?"
          body={`"${deleting.title}" and everything inside it (${deleting.child_count} item${
            deleting.child_count === 1 ? '' : 's'
          }) will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
