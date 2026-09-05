import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { ProjectListItem } from '../api/types';
import { KebabMenu } from './KebabMenu';

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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isPinned = project.pinned === 1;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card project-card${isPinned ? ' is-pinned' : ''}`}
      onClick={() => navigate(`/projects/${project.id}`)}
    >
      <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
        ⠿
      </span>
      {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p className="project-card__title">{project.title}</p>
        <div className="project-card__stats">
          <span>Pins: {project.pinned_count}</span>
          <span>Folders: {project.folder_count}</span>
          <span>Notes: {project.note_count}</span>
          <span>Tasks: {project.open_task_count}</span>
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
