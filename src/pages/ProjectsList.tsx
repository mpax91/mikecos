import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ProjectListItem } from '../api/types';
import { Modal } from '../components/Modal';
import { ProjectCard } from '../components/ProjectCard';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { SortableGrid } from '../components/SortableGrid';
import { Section } from '../components/Section';
import { Toast } from '../components/Toast';
import { useReportTabMeta } from '../contexts/TabsContext';

export function ProjectsList() {
  useReportTabMeta('Projects', 'projects-list');
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ProjectListItem | null>(null);
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null);
  // Archived projects live in their own collapsed section at the bottom —
  // fetched separately since /api/projects leaves them out by default (so
  // Move-to / Convert pickers never offer one). See migrations/0086.
  const [archived, setArchived] = useState<ProjectListItem[]>([]);
  const [toast, setToast] = useState<{ message: string; actionLabel?: string; onAction?: () => void } | null>(null);
  const navigate = useNavigate();

  function load() {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
    api.listProjects(true).then(setArchived).catch(() => setArchived([]));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    if (!title.trim()) return;
    const project = await api.createProject(title.trim(), '');
    setCreating(false);
    setTitle('');
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

  async function setArchivedState(p: ProjectListItem, archive: boolean) {
    // Optimistic move between the two groups; load() then refreshes both
    // with the server's real order and archived_at.
    if (archive) {
      setProjects((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
      setArchived((prev) => [{ ...p, status: 'archived', archived_at: new Date().toISOString() }, ...prev]);
    } else {
      setArchived((prev) => prev.filter((x) => x.id !== p.id));
      setProjects((prev) => (prev ? [...prev, { ...p, status: 'active', archived_at: null }] : prev));
    }
    await api.updateEntity(p.id, { status: archive ? 'archived' : 'active' });
    load();
  }

  function handleToggleArchive(p: ProjectListItem) {
    if (p.status === 'archived') {
      setArchivedState(p, false);
      setToast({ message: `Restored "${p.title || 'Untitled Project'}"` });
    } else {
      setArchivedState(p, true);
      setToast({
        message: `Archived "${p.title || 'Untitled Project'}"`,
        actionLabel: 'Undo',
        onAction: () => setArchivedState(p, false),
      });
    }
  }

  async function handleRename(p: ProjectListItem, newTitle: string) {
    setProjects((prev) => (prev ? prev.map((x) => (x.id === p.id ? { ...x, title: newTitle } : x)) : prev));
    setArchived((prev) => prev.map((x) => (x.id === p.id ? { ...x, title: newTitle } : x)));
    await api.updateEntity(p.id, { title: newTitle });
  }

  async function handleDelete(p: ProjectListItem) {
    setProjects((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
    setArchived((prev) => prev.filter((x) => x.id !== p.id));
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
        <div className="empty-state">{archived.length > 0 ? 'No active projects.' : 'No projects yet — create your first one.'}</div>
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
              onToggleArchive={handleToggleArchive}
            />
          )}
        />
      )}

      {archived.length > 0 && (
        <Section title="Archived" count={archived.length} defaultExpanded={false}>
          <div className="project-card-list">
            {archived.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onDelete={setDeleting}
                onTogglePin={handleTogglePin}
                onRename={setRenaming}
                onToggleArchive={handleToggleArchive}
              />
            ))}
          </div>
        </Section>
      )}

      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}

      {creating && (
        <Modal title="New Project" onClose={() => setCreating(false)}>
          <input
            autoFocus
            placeholder="Project Name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
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
          label="Project Name"
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
