import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CanvasBoardListItem } from '../api/types';
import { Modal } from '../components/Modal';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';

function BoardCard({
  board,
  onOpen,
  onRename,
  onDelete,
  onTogglePin,
}: {
  board: CanvasBoardListItem;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const { openTab, showContextMenu } = useTabs();
  const isPinned = board.pinned === 1;
  return (
    <div
      className={`card project-card${isPinned ? ' is-pinned' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          openTab(`/boards/${board.id}`, { background: true, title: board.title || 'Untitled Board', kind: 'board' });
          return;
        }
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open in New Tab', onClick: () => openTab(`/boards/${board.id}`, { background: true, title: board.title || 'Untitled Board', kind: 'board' }) },
        ]);
      }}
    >
      {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p className="project-card__title">
          <span className="project-card__title-text">{board.title || 'Untitled Board'}</span>
          <span className="last-modified-badge" title={new Date(board.updated_at).toLocaleString()}>
            {formatRelativeTime(board.updated_at)}
          </span>
        </p>
        <div className="project-card__stats">
          {board.item_count > 0 && (
            <span title={`${board.item_count} item${board.item_count === 1 ? '' : 's'}`}>🗂️ {board.item_count}</span>
          )}
        </div>
      </div>
      <KebabMenu
        items={[
          { label: 'Rename', onClick: onRename },
          { label: isPinned ? 'Unpin' : 'Pin to top', onClick: onTogglePin },
          { label: 'Delete', onClick: onDelete, danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}

/** Boards list — the entry point for the infinite-canvas pinboard feature.
 * Deliberately kept as plain a "grid of cards" as Projects/Notes: the
 * interesting part of this feature is what happens once you're inside a
 * board (CanvasBoardPage), not this list. No drag-to-reorder here (unlike
 * Projects) — boards are few enough, and sorted pinned-first then by
 * recent activity (see GET /api/boards), that manual ordering isn't worth
 * the complexity yet. Pin-to-top itself, though, is the same feature
 * Projects has (same KebabMenu item, same `.entity-card__pin` badge). */
export function BoardsListPage() {
  useReportTabMeta('Boards', 'boards-list');
  const navigate = useNavigate();
  const [boards, setBoards] = useState<CanvasBoardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [renaming, setRenaming] = useState<CanvasBoardListItem | null>(null);
  const [deleting, setDeleting] = useState<CanvasBoardListItem | null>(null);

  function load() {
    api.listBoards().then(setBoards).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    const board = await api.createBoard(title.trim() || undefined);
    setCreating(false);
    setTitle('');
    navigate(`/boards/${board.id}`);
  }

  async function handleRename(board: CanvasBoardListItem, newTitle: string) {
    setBoards((prev) => (prev ? prev.map((b) => (b.id === board.id ? { ...b, title: newTitle } : b)) : prev));
    await api.renameBoard(board.id, newTitle);
  }

  async function handleTogglePin(board: CanvasBoardListItem) {
    const next = board.pinned === 1 ? 0 : 1;
    setBoards((prev) => (prev ? prev.map((b) => (b.id === board.id ? { ...b, pinned: next } : b)) : prev));
    await api.setBoardPinned(board.id, next === 1);
    load();
  }

  async function handleDelete(board: CanvasBoardListItem) {
    setBoards((prev) => (prev ? prev.filter((b) => b.id !== board.id) : prev));
    await api.deleteBoard(board.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load boards: {error}</div>;
  if (!boards) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Boards
        </h1>
        <button className="btn" onClick={() => setCreating(true)}>
          + New Board
        </button>
      </div>

      {boards.length === 0 ? (
        <div className="empty-state">
          No boards yet — an infinite canvas for spatial planning: drag in photos and screenshots, drop in text and
          sticky notes, arrange everything freely. Create your first one to get started.
        </div>
      ) : (
        <div className="project-card-list">
          {boards.map((b) => (
            <BoardCard
              key={b.id}
              board={b}
              onOpen={() => navigate(`/boards/${b.id}`)}
              onRename={() => setRenaming(b)}
              onDelete={() => setDeleting(b)}
              onTogglePin={() => handleTogglePin(b)}
            />
          ))}
        </div>
      )}

      {creating && (
        <Modal title="New Board" onClose={() => setCreating(false)}>
          <input
            autoFocus
            placeholder="Board Name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleCreate}>
              Create
            </button>
          </div>
        </Modal>
      )}

      {renaming && (
        <RenameModal
          initialValue={renaming.title}
          label="Board Name"
          onSave={(v) => handleRename(renaming, v)}
          onClose={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete board?"
          body={`"${deleting.title || 'Untitled Board'}" and everything on it (${deleting.item_count} item${
            deleting.item_count === 1 ? '' : 's'
          }) will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
