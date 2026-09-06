import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../api/client';
import type { ProjectListItem } from '../api/types';

/** Picker for "Move to Project": pick an existing project, or type a new
 * project name to create it and move into it in one step. Used from the
 * standalone Notes section's header icon. */
export function MoveToProjectModal({
  onMove,
  onClose,
}: {
  onMove: (projectId: string) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listProjects().then(setProjects);
  }, []);

  async function createAndMove() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const project = await api.createProject(title, '');
      onMove(project.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title="Move to Project" onClose={onClose}>
      <div className="move-to-project__list">
        {projects === null ? (
          <div className="empty-state empty-state--section">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="empty-state empty-state--section">No projects yet — create one below.</div>
        ) : (
          projects.map((p) => (
            <button key={p.id} type="button" className="move-to-project__item" onClick={() => onMove(p.id)}>
              {p.title}
            </button>
          ))
        )}
      </div>
      <div className="move-to-project__divider">or create a new project</div>
      <input
        placeholder="New Project Name"
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && createAndMove()}
      />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={createAndMove} disabled={!newTitle.trim() || creating}>
          Create &amp; Move
        </button>
      </div>
    </Modal>
  );
}
