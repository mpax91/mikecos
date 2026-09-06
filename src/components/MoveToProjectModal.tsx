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
  /** `previousLastTouched` is the target project's own last_touched at the
   * moment it was picked — the caller hangs onto it so that if the move is
   * immediately undone, the project's "last modified" badge can be restored
   * to exactly what it was, instead of showing a false "just modified". */
  onMove: (projectId: string, previousLastTouched: string | null) => void;
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
      onMove(project.id, project.last_touched);
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
            <button
              key={p.id}
              type="button"
              className="move-to-project__item"
              onClick={() => onMove(p.id, p.last_touched)}
            >
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
