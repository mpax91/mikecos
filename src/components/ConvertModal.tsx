import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../api/client';
import type { ProjectListItem } from '../api/types';

/** Project picker for turning a Jot into a Task or a Note. Similar in spirit
 * to MoveToProjectModal, but distinct: a Task conversion has no "standalone"
 * option (MikeOS has no top-level task concept), while a Note conversion
 * leads with one, since a standalone Note is the common case for a jot that
 * doesn't obviously belong to any project. */
export function ConvertModal({
  to,
  onConvert,
  onClose,
}: {
  to: 'note' | 'task';
  onConvert: (parentId: string | null) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listProjects().then(setProjects);
  }, []);

  async function createAndConvert() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const project = await api.createProject(title, '');
      onConvert(project.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={to === 'task' ? 'Turn into Task' : 'Turn into Note'} onClose={onClose}>
      <div className="move-to-project__list">
        {to === 'note' && (
          <button type="button" className="move-to-project__item" onClick={() => onConvert(null)}>
            No project — keep it standalone
          </button>
        )}
        {projects === null ? (
          <div className="empty-state empty-state--section">Loading…</div>
        ) : projects.length === 0 && to === 'task' ? (
          <div className="empty-state empty-state--section">No projects yet — create one below.</div>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className="move-to-project__item"
              onClick={() => onConvert(p.id)}
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
        onKeyDown={(e) => e.key === 'Enter' && createAndConvert()}
      />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={createAndConvert} disabled={!newTitle.trim() || creating}>
          Create &amp; Convert
        </button>
      </div>
    </Modal>
  );
}
