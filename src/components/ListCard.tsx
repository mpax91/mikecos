import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { ListItem } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs } from '../contexts/TabsContext';

export function ListCard({
  list,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onRename,
}: {
  list: ListItem;
  onDelete: (l: ListItem) => void;
  onTogglePin: (l: ListItem) => void;
  onToggleArchive: (l: ListItem) => void;
  onRename: (l: ListItem) => void;
}) {
  const navigate = useNavigate();
  const { openTab, showContextMenu } = useTabs();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isPinned = list.pinned === 1;
  const isArchived = list.status === 'archived';
  const lastModifiedIso = list.last_touched ?? list.updated_at;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card project-card${isPinned ? ' is-pinned' : ''}${isArchived ? ' is-archived' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          openTab(`/lists/${list.id}`, { background: true, title: list.title || 'Untitled List', kind: 'list' });
          return;
        }
        navigate(`/lists/${list.id}`);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: 'Open in New Tab',
            onClick: () => openTab(`/lists/${list.id}`, { background: true, title: list.title || 'Untitled List', kind: 'list' }),
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
          <span className="project-card__title-text">{list.title || 'Untitled List'}</span>
          <span className="last-modified-badge" title={new Date(lastModifiedIso).toLocaleString()}>
            {formatRelativeTime(lastModifiedIso)}
          </span>
        </p>
        <div className="project-card__stats">
          {isArchived && <span>Archived</span>}
          {list.open_count > 0 && (
            <span title={`${list.open_count} open item${list.open_count === 1 ? '' : 's'}`}>☐ {list.open_count}</span>
          )}
          {list.done_count > 0 && (
            <span title={`${list.done_count} checked off`}>☑ {list.done_count}</span>
          )}
          {list.open_count === 0 && list.done_count === 0 && <span>Empty</span>}
        </div>
      </div>
      <KebabMenu
        items={[
          { label: 'Rename', onClick: () => onRename(list) },
          { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(list) },
          { label: isArchived ? 'Unarchive' : 'Archive', onClick: () => onToggleArchive(list) },
          { label: 'Delete', onClick: () => onDelete(list), danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}
