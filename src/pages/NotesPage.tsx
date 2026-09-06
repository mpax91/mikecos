import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Entity } from '../api/types';
import { NoteEditor } from '../components/NoteEditor';
import { KebabMenu } from '../components/KebabMenu';
import { ConfirmModal } from '../components/ConfirmModal';
import { MoveToProjectModal } from '../components/MoveToProjectModal';
import { Toast } from '../components/Toast';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { extractSnippet } from '../lib/snippet';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Standalone Notes section — an Apple-Notes-style split view: a sidebar
 * list of every top-level note (not attached to any project), sorted pinned-
 * first then by last-modified, and a detail pane for the note that's open.
 * On phone widths this collapses to a full-width list, then a full-width
 * detail with a back control, instead of the side-by-side split. */
export function NotesPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { openTab, showContextMenu } = useTabs();
  const [notes, setNotes] = useState<Entity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const [moving, setMoving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const focusTitleForId = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.listNotes().then(setNotes).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Desktop opens straight into the most recently modified note (Apple
  // Notes' own default) when nothing is selected yet; mobile always starts
  // on the list instead, per the list-then-detail pattern.
  useEffect(() => {
    if (!isMobile && !id && notes && notes.length > 0) {
      navigate(`/notes/${notes[0].id}`, { replace: true });
    }
  }, [isMobile, id, notes, navigate]);

  const selected = notes?.find((n) => n.id === id) ?? null;

  // Keep the active tab's label/icon in sync: "Notes" for the list, or the
  // open note's own title (live, as it's typed) when one is selected.
  useReportTabMeta(selected ? noteTitle || 'Untitled Note' : 'Notes', selected ? 'note' : 'notes-list');

  useEffect(() => {
    setNoteTitle(selected?.title ?? '');
    // Re-sync only when the *selected note itself* changes (navigating between
    // notes) — not on every `notes` list refresh, which would otherwise stomp
    // in-progress typing every time load() resolves after a debounced save.
    if (selected && focusTitleForId.current === selected.id) {
      focusTitleForId.current = null;
      // Wait a tick for the (possibly just-mounted) input to be in the DOM.
      requestAnimationFrame(() => titleInputRef.current?.select());
    }
  }, [selected?.id]);

  async function createNote() {
    const note = await api.createNote();
    setNotes((prev) => (prev ? [note, ...prev] : [note]));
    focusTitleForId.current = note.id;
    navigate(`/notes/${note.id}`);
  }

  function handleTitleChange(value: string) {
    if (!selected) return;
    setNoteTitle(value);
    setNotes((prev) => (prev ? prev.map((n) => (n.id === selected.id ? { ...n, title: value } : n)) : prev));
    api.updateEntity(selected.id, { title: value });
  }

  function handleContentSave(json: string) {
    if (!selected) return;
    api.updateEntity(selected.id, { content: json }).then(load);
  }

  async function togglePin(note: Entity) {
    const next = note.pinned === 1 ? 0 : 1;
    setNotes((prev) => (prev ? prev.map((n) => (n.id === note.id ? { ...n, pinned: next } : n)) : prev));
    await api.setPinned(note.id, next === 1);
    load();
  }

  async function deleteNote(note: Entity) {
    setNotes((prev) => (prev ? prev.filter((n) => n.id !== note.id) : prev));
    await api.deleteEntity(note.id);
    setDeleting(null);
    navigate('/notes');
  }

  async function moveToProject(projectId: string, previousLastTouched: string | null) {
    if (!selected) return;
    const movedId = selected.id;
    const movedTitle = selected.title || 'Untitled Note';
    setMoving(false);
    setNotes((prev) => (prev ? prev.filter((n) => n.id !== movedId) : prev));
    navigate('/notes');
    await api.moveEntity(movedId, projectId);
    setToast({
      message: `"${movedTitle}" moved to project.`,
      actionLabel: 'Undo',
      onAction: async () => {
        await api.moveEntity(movedId, null);
        // Restore the project's own "last modified" stamp to what it was
        // before this move — otherwise a move-then-immediate-undo still
        // leaves the project looking freshly touched.
        await api.updateEntity(projectId, { last_touched: previousLastTouched });
        load();
        navigate(`/notes/${movedId}`);
      },
    });
  }

  if (error) return <div className="empty-state">Couldn't load notes: {error}</div>;
  if (!notes) return <div className="empty-state">Loading…</div>;

  const showList = !isMobile || !selected;
  const showDetail = !isMobile || !!selected;

  return (
    <div>
      {showList && (
        <div className="toolbar-row">
          <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
            Notes
          </h1>
          <button className="btn" onClick={createNote}>
            + New Note
          </button>
        </div>
      )}
      <div className={`notes-page${isMobile ? ' notes-page--mobile' : ''}`}>
        {showList && (
          <div className="notes-page__sidebar">
            {notes.length === 0 ? (
              <div className="empty-state empty-state--section">No notes yet — create your first one.</div>
            ) : (
              <div className="notes-page__list">
                {notes.map((n) => (
                  <div
                    key={n.id}
                    className={`notes-page__row${n.id === id ? ' is-active' : ''}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) {
                        openTab(`/notes/${n.id}`, { background: true, title: n.title || 'Untitled Note', kind: 'note' });
                        return;
                      }
                      navigate(`/notes/${n.id}`);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      showContextMenu(e.clientX, e.clientY, [
                        {
                          label: 'Open in New Tab',
                          onClick: () =>
                            openTab(`/notes/${n.id}`, { background: true, title: n.title || 'Untitled Note', kind: 'note' }),
                        },
                      ]);
                    }}
                  >
                    {n.pinned === 1 && (
                      <span className="notes-page__row-pin" title="Pinned">
                        📌
                      </span>
                    )}
                    <div className="notes-page__row-body">
                      <div className="notes-page__row-title-row">
                        <span className="notes-page__row-title">{n.title || 'Untitled Note'}</span>
                        <span className="last-modified-badge" title={new Date(n.last_touched ?? n.updated_at).toLocaleString()}>
                          {formatRelativeTime(n.last_touched ?? n.updated_at)}
                        </span>
                      </div>
                      {n.content && <div className="notes-page__row-snippet">{extractSnippet(n.content, 60)}</div>}
                    </div>
                    <KebabMenu
                      className="notes-page__row-kebab"
                      items={[
                        { label: n.pinned === 1 ? 'Unpin' : 'Pin to top', onClick: () => togglePin(n) },
                        { label: 'Delete', onClick: () => setDeleting(n), danger: true, separatorBefore: true },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {showDetail && selected && (
          <div className="notes-page__detail">
            {isMobile && (
              <div className="breadcrumb notes-page__back-row">
                <button
                  type="button"
                  className="breadcrumb__back"
                  onClick={() => navigate('/notes')}
                  title="Back"
                  aria-label="Back"
                >
                  ‹
                </button>
                <span className="breadcrumb__current">Notes</span>
              </div>
            )}
            <div className="notes-page__detail-header">
              <input
                ref={titleInputRef}
                className="notes-page__title-input"
                value={noteTitle}
                placeholder="Untitled Note"
                onChange={(e) => handleTitleChange(e.target.value)}
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                className="notes-page__move-btn"
                onClick={() => setMoving(true)}
                title="Move to Project"
              >
                📁 <span>Move to Project</span>
              </button>
            </div>
            <NoteEditor key={selected.id} content={selected.content} onSave={handleContentSave} />
          </div>
        )}

        {showDetail && !selected && (
          <div className="notes-page__detail notes-page__detail--empty">
            <div className="empty-state">Select a note, or create a new one.</div>
          </div>
        )}
      </div>

      {deleting && (
        <ConfirmModal
          title="Delete note?"
          body={`"${deleting.title || 'Untitled'}" will be permanently deleted.`}
          onConfirm={() => deleteNote(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {moving && <MoveToProjectModal onMove={moveToProject} onClose={() => setMoving(false)} />}

      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
