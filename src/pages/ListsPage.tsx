import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ListItem } from '../api/types';
import { Modal } from '../components/Modal';
import { ListCard } from '../components/ListCard';
import { RenameModal } from '../components/RenameModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { SortableGrid } from '../components/SortableGrid';
import { Section } from '../components/Section';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Lists — flat, named checklists ("To Buy", "To Download", a one-off "To
 * Shop" for a grocery run), distinct from Projects: no sub-folders, no
 * project dashboard, just items. See migrations/0029_lists.sql for how a
 * List reuses the Project entity shape under the hood. */
export function ListsPage() {
  useReportTabMeta('Lists', 'lists-list');
  const [lists, setLists] = useState<ListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ListItem | null>(null);
  const [deleting, setDeleting] = useState<ListItem | null>(null);
  const navigate = useNavigate();

  function load() {
    api.listLists().then(setLists).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    if (!title.trim()) return;
    const list = await api.createList(title.trim());
    setCreating(false);
    setTitle('');
    navigate(`/lists/${list.id}`);
  }

  async function handleReorder(ordered: ListItem[]) {
    setLists((prev) => {
      if (!prev) return prev;
      // Only the active group was reordered — splice it back in among any
      // archived lists so a drag doesn't silently drop them from state.
      const archivedIds = new Set(prev.filter((l) => l.status === 'archived').map((l) => l.id));
      return [...ordered, ...prev.filter((l) => archivedIds.has(l.id))];
    });
    await api.reorder(
      null,
      ordered.map((o) => o.id)
    );
  }

  async function handleTogglePin(l: ListItem) {
    const next = l.pinned === 1 ? 0 : 1;
    setLists((prev) => (prev ? prev.map((x) => (x.id === l.id ? { ...x, pinned: next } : x)) : prev));
    await api.setPinned(l.id, next === 1);
    load();
  }

  async function handleToggleArchive(l: ListItem) {
    const next = l.status === 'archived' ? 'active' : 'archived';
    setLists((prev) => (prev ? prev.map((x) => (x.id === l.id ? { ...x, status: next } : x)) : prev));
    await api.updateEntity(l.id, { status: next });
  }

  async function handleRename(l: ListItem, newTitle: string) {
    setLists((prev) => (prev ? prev.map((x) => (x.id === l.id ? { ...x, title: newTitle } : x)) : prev));
    await api.updateEntity(l.id, { title: newTitle });
  }

  async function handleDelete(l: ListItem) {
    setLists((prev) => (prev ? prev.filter((x) => x.id !== l.id) : prev));
    await api.deleteEntity(l.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load lists: {error}</div>;
  if (!lists) return <div className="empty-state">Loading…</div>;

  const active = lists.filter((l) => l.status !== 'archived');
  const archived = lists.filter((l) => l.status === 'archived');

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Lists
        </h1>
        <button className="btn" onClick={() => setCreating(true)}>
          + New List
        </button>
      </div>

      {active.length === 0 ? (
        <div className="empty-state">
          No lists yet — create one for anything you check off repeatedly ("To Buy", "To Download") or just once
          ("To Shop").
        </div>
      ) : (
        <SortableGrid
          items={active}
          onReorder={handleReorder}
          className="list-card-grid"
          renderItem={(l) => (
            <ListCard
              key={l.id}
              list={l}
              onDelete={setDeleting}
              onTogglePin={handleTogglePin}
              onToggleArchive={handleToggleArchive}
              onRename={setRenaming}
            />
          )}
        />
      )}

      {archived.length > 0 && (
        <Section title="Archived" count={archived.length} defaultExpanded={false}>
          <div className="list-card-grid">
            {archived.map((l) => (
              <ListCard
                key={l.id}
                list={l}
                onDelete={setDeleting}
                onTogglePin={handleTogglePin}
                onToggleArchive={handleToggleArchive}
                onRename={setRenaming}
              />
            ))}
          </div>
        </Section>
      )}

      {creating && (
        <Modal title="New List" onClose={() => setCreating(false)}>
          <input
            autoFocus
            placeholder='List Name (e.g. "To Buy")'
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
          label="List Name"
          onSave={(v) => handleRename(renaming, v)}
          onClose={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete list?"
          body={`"${deleting.title || 'Untitled List'}" and everything in it will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
