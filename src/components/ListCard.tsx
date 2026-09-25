import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import type { ListItem } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs } from '../contexts/TabsContext';

/** A List's card on the Lists index — deliberately its own bigger, taller
 * tile rather than the flat single-row `.project-card` a Project uses, so a
 * list actually reads as a checklist at a glance (a few of its real item
 * titles, each with its own checkbox glyph) instead of just a title and a
 * count badge indistinguishable from a Project. */
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
  const preview = list.preview_items ?? [];
  const remaining = list.open_count - preview.length;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card list-card${isPinned ? ' is-pinned' : ''}${isArchived ? ' is-archived' : ''}`}
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
      <div className="list-card__header">
        <span className="entity-card__drag" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}>
          ⠿
        </span>
        <div className="list-card__title-group">
          <p className="list-card__title">
            {isPinned && <span title="Pinned">📌</span>}
            <span className="list-card__title-text">{list.title || 'Untitled List'}</span>
          </p>
          <span className="last-modified-badge" title={new Date(lastModifiedIso).toLocaleString()}>
            {formatRelativeTime(lastModifiedIso)}
          </span>
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

      {isArchived && <span className="list-card__archived-tag">Archived</span>}

      {preview.length === 0 ? (
        <div className="list-card__empty">Nothing on this list yet</div>
      ) : (
        <ul className="list-card__preview">
          {preview.map((title, i) => (
            <li key={i}>
              <span className="list-card__preview-check">☐</span>
              <span className="list-card__preview-text">{title}</span>
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 && <div className="list-card__more">+{remaining} more</div>}
    </div>
  );
}
