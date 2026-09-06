import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { ProjectListItem } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs } from '../contexts/TabsContext';

export function ProjectCard({
  project,
  onDelete,
  onTogglePin,
  onRename,
}: {
  project: ProjectListItem;
  onDelete: (p: ProjectListItem) => void;
  onTogglePin: (p: ProjectListItem) => void;
  onRename: (p: ProjectListItem) => void;
}) {
  const navigate = useNavigate();
  const { openTab, showContextMenu } = useTabs();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isPinned = project.pinned === 1;
  // last_touched bumps whenever anything inside the project actually changes
  // (title/content edits anywhere in its tree, children created/deleted) —
  // distinct from updated_at, which also moves on pure reordering/pinning.
  const lastModifiedIso = project.last_touched ?? project.updated_at;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card project-card${isPinned ? ' is-pinned' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          openTab(`/projects/${project.id}`, { background: true, title: project.title || 'Untitled Project', kind: 'project' });
          return;
        }
        navigate(`/projects/${project.id}`);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: 'Open in New Tab',
            onClick: () =>
              openTab(`/projects/${project.id}`, {
                background: true,
                title: project.title || 'Untitled Project',
                kind: 'project',
              }),
          },
        ]);
      }}
    >
      <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
        ⠿
      </span>
      {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p className="project-card__title">
          <span className="project-card__title-text">{project.title}</span>
          <span className="last-modified-badge" title={new Date(lastModifiedIso).toLocaleString()}>
            {formatRelativeTime(lastModifiedIso)}
          </span>
        </p>
        <div className="project-card__stats">
          {project.pinned_count > 0 && (
            <span title={`${project.pinned_count} pinned`}>📌 {project.pinned_count}</span>
          )}
          {project.folder_count > 0 && (
            <span title={`${project.folder_count} folder${project.folder_count === 1 ? '' : 's'}`}>
              📁 {project.folder_count}
            </span>
          )}
          {project.note_count > 0 && (
            <span title={`${project.note_count} note${project.note_count === 1 ? '' : 's'}`}>
              📝 {project.note_count}
            </span>
          )}
          {project.media_count > 0 && (
            <span title={`${project.media_count} media item${project.media_count === 1 ? '' : 's'}`}>
              📎 {project.media_count}
            </span>
          )}
          {project.open_task_count > 0 && (
            <span title={`${project.open_task_count} open task${project.open_task_count === 1 ? '' : 's'}`}>
              ☑ {project.open_task_count}
            </span>
          )}
          {project.open_subtask_count > 0 && (
            <span title={`${project.open_subtask_count} open subtask${project.open_subtask_count === 1 ? '' : 's'}`}>
              ↳ {project.open_subtask_count}
            </span>
          )}
        </div>
      </div>
      <KebabMenu
        items={[
          { label: 'Rename', onClick: () => onRename(project) },
          { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(project) },
          { label: 'Delete', onClick: () => onDelete(project), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}
