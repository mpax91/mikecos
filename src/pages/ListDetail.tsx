import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity, EntityDetail } from '../api/types';
import { TaskRow } from '../components/TaskRow';
import { NewListItemRow } from '../components/NewListItemRow';
import { TaskDetailModal } from '../components/TaskDetailModal';
import { EditableText } from '../components/EditableText';
import { ConfirmModal } from '../components/ConfirmModal';
import { Toast } from '../components/Toast';
import { KebabMenu } from '../components/KebabMenu';
import { useReportTabMeta } from '../contexts/TabsContext';

/** A List's detail view — a flat checklist. Deliberately much simpler than
 * ProjectDetail: no folders/notes/media/pinned sections, just items — but
 * every item is a full task entity underneath (see
 * migrations/0029_lists.sql), so it gets the same detail panel (description,
 * due date, subtasks, attachments) as a project task for free. */
export function ListDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [deletingList, setDeletingList] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [taskStack, setTaskStack] = useState<string[]>([]);

  const load = useCallback(() => {
    if (!id) return;
    api.getEntity(id).then(setDetail).catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    load();
  }, [load]);

  useReportTabMeta(detail ? detail.entity.title || 'Untitled List' : undefined, 'list');

  async function createItem(title: string) {
    if (!id) return;
    await api.createEntity({ type: 'task', parent_id: id, title });
    load();
  }

  async function createItems(titles: string[]) {
    if (!id) return;
    await api.createListItems(id, titles);
    load();
  }

  function mapChildrenWithSubtasks(list: Entity[], targetId: string, patch: Partial<Entity>): Entity[] {
    return list.map((c) => {
      if (c.id === targetId) return { ...c, ...patch };
      if (c.subtasks?.length) {
        return { ...c, subtasks: c.subtasks.map((s) => (s.id === targetId ? { ...s, ...patch } : s)) };
      }
      return c;
    });
  }

  function removeChildEverywhere(list: Entity[], targetId: string): Entity[] {
    return list
      .filter((c) => c.id !== targetId)
      .map((c) => (c.subtasks?.length ? { ...c, subtasks: c.subtasks.filter((s) => s.id !== targetId) } : c));
  }

  async function toggleItem(entity: Entity) {
    const nextStatus = entity.status === 'done' ? 'open' : 'done';
    setDetail((prev) => (prev ? { ...prev, children: mapChildrenWithSubtasks(prev.children, entity.id, { status: nextStatus }) } : prev));
    await api.updateEntity(entity.id, { status: nextStatus });
  }

  async function togglePin(entity: Entity) {
    const next = entity.pinned === 1 ? 0 : 1;
    setDetail((prev) => (prev ? { ...prev, children: mapChildrenWithSubtasks(prev.children, entity.id, { pinned: next }) } : prev));
    await api.setPinned(entity.id, next === 1);
  }

  async function deleteItem(entity: Entity) {
    setDetail((prev) => (prev ? { ...prev, children: removeChildEverywhere(prev.children, entity.id) } : prev));
    await api.deleteEntity(entity.id);
    setDeleting(null);
  }

  function openItem(entity: Entity) {
    setTaskStack([entity.id]);
  }

  function openSubtask(taskId: string) {
    setTaskStack((prev) => [...prev, taskId]);
  }

  function backTask() {
    setTaskStack((prev) => prev.slice(0, -1));
  }

  function closeTaskModal() {
    setTaskStack([]);
  }

  async function persistReorder(orderedIds: string[]) {
    if (!id) return;
    await api.reorder(id, orderedIds);
    load();
  }

  function promote(entity: Entity) {
    if (!detail) return;
    const group = detail.children.filter((c) => c.type === 'task');
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx <= 0) return;
    const ordered = [...group];
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    persistReorder(ordered.map((o) => o.id));
  }

  function demote(entity: Entity) {
    if (!detail) return;
    const group = detail.children.filter((c) => c.type === 'task');
    const idx = group.findIndex((e) => e.id === entity.id);
    if (idx === -1 || idx >= group.length - 1) return;
    const ordered = [...group];
    [ordered[idx + 1], ordered[idx]] = [ordered[idx], ordered[idx + 1]];
    persistReorder(ordered.map((o) => o.id));
  }

  async function handleReset() {
    if (!id) return;
    setDetail((prev) => (prev ? { ...prev, children: prev.children.map((c) => (c.type === 'task' ? { ...c, status: 'open' } : c)) } : prev));
    await api.resetList(id);
    setToast('All items unchecked.');
  }

  async function handleClearCompleted() {
    if (!id) return;
    setConfirmingClear(false);
    const res = await api.clearCompletedListItems(id);
    load();
    setToast(`Cleared ${res.deletedCount} completed item${res.deletedCount === 1 ? '' : 's'}.`);
  }

  async function handleToggleArchive() {
    if (!detail || !id) return;
    const next = detail.entity.status === 'archived' ? 'active' : 'archived';
    setDetail((prev) => (prev ? { ...prev, entity: { ...prev.entity, status: next } } : prev));
    await api.updateEntity(id, { status: next });
    setToast(next === 'archived' ? 'List archived.' : 'List unarchived.');
  }

  async function handleDeleteList() {
    if (!id) return;
    await api.deleteEntity(id);
    navigate('/lists');
  }

  function handleCopyAsText() {
    if (!detail) return;
    const open = detail.children.filter((c) => c.type === 'task' && c.status !== 'done');
    const text = [detail.entity.title || 'Untitled List', '', ...open.map((c) => `- ${c.title || 'Untitled'}`)].join('\n');
    navigator.clipboard.writeText(text).then(() => setToast('List copied to clipboard.'));
  }

  if (error) return <div className="empty-state">Couldn't load list: {error}</div>;
  if (!detail) return <div className="empty-state">Loading…</div>;

  const { entity, children } = detail;
  const items = children.filter((c) => c.type === 'task');
  const openItems = items.filter((t) => t.status !== 'done');
  const doneItems = items.filter((t) => t.status === 'done');
  const isArchived = entity.status === 'archived';

  return (
    <div>
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/lists')} title="Back" aria-label="Back">
          ‹
        </button>
        <button
          type="button"
          className="breadcrumb__link"
          style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
          onClick={() => navigate('/lists')}
        >
          Lists
        </button>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">{entity.title || 'Untitled List'}</span>
      </div>

      <div className="project-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <EditableText
            value={entity.title}
            placeholder="Untitled List"
            onSave={(v) => id && api.updateEntity(id, { title: v })}
            className="project-header__title-input"
            displayClassName="project-header__title"
          />
        </div>
        {isArchived && (
          <span className="settings-page__calendar-badge is-off" style={{ flexShrink: 0 }}>
            Archived
          </span>
        )}
      </div>

      <div className="toolbar-row" style={{ marginBottom: 8 }}>
        <span className="empty-state" style={{ padding: 0, margin: 0 }}>
          {openItems.length} open{doneItems.length > 0 ? ` · ${doneItems.length} checked off` : ''}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn--ghost" onClick={handleCopyAsText} disabled={openItems.length === 0}>
            Copy as Text
          </button>
          <KebabMenu
            items={[
              { label: 'Reset (uncheck all)', onClick: handleReset, disabled: doneItems.length === 0 },
              { label: 'Clear completed', onClick: () => setConfirmingClear(true), disabled: doneItems.length === 0 },
              { label: isArchived ? 'Unarchive' : 'Archive', onClick: handleToggleArchive, separatorBefore: true },
              { label: 'Delete List', onClick: () => setDeletingList(true), danger: true },
            ]}
          />
        </div>
      </div>

      <div className="task-list">
        {openItems.length === 0 && doneItems.length === 0 && (
          <div className="empty-state empty-state--section">Nothing here yet — add your first item below.</div>
        )}
        {openItems.map((c) => (
          <TaskRow
            key={c.id}
            entity={c}
            onToggle={toggleItem}
            onDelete={setDeleting}
            onTogglePin={togglePin}
            onOpen={openItem}
            onPromote={promote}
            onDemote={demote}
          />
        ))}
        <NewListItemRow onCreate={createItem} onCreateMany={createItems} />
        {doneItems.length > 0 && (
          <>
            <div className="task-divider">Completed</div>
            {doneItems.map((c) => (
              <TaskRow key={c.id} entity={c} onToggle={toggleItem} onDelete={setDeleting} onTogglePin={togglePin} onOpen={openItem} />
            ))}
          </>
        )}
      </div>

      {deleting && (
        <ConfirmModal
          title="Delete item?"
          body={`"${deleting.title || 'Untitled'}" will be permanently deleted.`}
          onConfirm={() => deleteItem(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {confirmingClear && (
        <ConfirmModal
          title="Clear completed items?"
          body={`${doneItems.length} checked-off item${doneItems.length === 1 ? '' : 's'} will be permanently deleted. Open items are untouched.`}
          confirmLabel="Clear"
          onConfirm={handleClearCompleted}
          onCancel={() => setConfirmingClear(false)}
        />
      )}

      {deletingList && (
        <ConfirmModal
          title="Delete list?"
          body={`"${entity.title || 'Untitled List'}" and everything in it will be permanently deleted.`}
          onConfirm={handleDeleteList}
          onCancel={() => setDeletingList(false)}
        />
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      {taskStack.length > 0 && (
        <TaskDetailModal
          key={taskStack[taskStack.length - 1]}
          taskId={taskStack[taskStack.length - 1]}
          onBack={taskStack.length > 1 ? backTask : undefined}
          onClose={closeTaskModal}
          onOpenSubtask={openSubtask}
          onMutated={load}
          onRequestDelete={(entityToDelete) => {
            closeTaskModal();
            setDeleting(entityToDelete);
          }}
        />
      )}
    </div>
  );
}
