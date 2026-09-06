import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Entity } from '../api/types';
import { NoteEditor } from '../components/NoteEditor';
import { JotBody } from '../components/JotBody';
import { JotPanel } from '../components/JotPanel';
import { ConvertModal } from '../components/ConvertModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { isTiptapDocEmpty } from '../utils/tiptapEmpty';
import { useReportTabMeta } from '../contexts/TabsContext';

function JotCard({
  jot,
  onOpen,
  onConvert,
  onTogglePin,
  onDelete,
}: {
  jot: Entity;
  onOpen: () => void;
  onConvert: (to: 'note' | 'task') => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="jot-card" onClick={onOpen}>
      <div className="jot-card__top">
        <span className="last-modified-badge" title={new Date(jot.updated_at).toLocaleString()}>
          {jot.pinned === 1 && (
            <span className="jot-card__pin" title="Pinned">
              📌
            </span>
          )}
          {formatRelativeTime(jot.updated_at)}
        </span>
        <KebabMenu
          items={[
            { label: jot.pinned === 1 ? 'Unpin' : 'Pin', onClick: onTogglePin },
            {
              label: 'Turn into Task (Coming soon)',
              onClick: () => onConvert('task'),
              disabled: true,
            },
            { label: 'Turn into Note', onClick: () => onConvert('note') },
            { label: 'Delete', onClick: onDelete, danger: true, separatorBefore: true },
          ]}
        />
      </div>
      {jot.title && <div className="jot-card__title">{jot.title}</div>}
      <div className="jot-card__body">
        <JotBody content={jot.content} />
      </div>
    </div>
  );
}

/** Jots — a Keep-style quick-capture section, deliberately temporary: the
 * point is to jot something down in under a second from wherever you are,
 * then clear it out often by turning it into a Task or Note (or just
 * deleting it), not to let it become a permanent home for anything.
 * Oldest-first ordering (unlike Notes' newest-first) is itself the main
 * "staleness" signal — whatever's been sitting longest is always what you
 * see first when you open the section. */
export function JotsPage() {
  useReportTabMeta('Jots', 'jots-list');
  const [jots, setJots] = useState<Entity[] | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const draftEmptyRef = useRef(true);
  const draftJsonRef = useRef<string | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const draftTitleRef = useRef('');
  const [openJot, setOpenJot] = useState<Entity | null>(null);
  const [converting, setConverting] = useState<{ jot: Entity; to: 'note' | 'task' } | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);

  const load = useCallback(() => {
    api.listJots().then(setJots);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openComposer() {
    setComposerOpen(true);
    if (!draftIdRef.current) {
      const jot = await api.createJot(null);
      draftIdRef.current = jot.id;
      draftEmptyRef.current = true;
      draftTitleRef.current = '';
      setDraftId(jot.id);
      setDraftTitle('');
    }
  }

  function handleDraftTitleChange(value: string) {
    setDraftTitle(value);
    draftTitleRef.current = value;
  }

  async function finishComposer() {
    const id = draftIdRef.current;
    const finalJson = draftJsonRef.current;
    const finalTitle = draftTitleRef.current.trim();
    setComposerOpen(false);
    draftIdRef.current = null;
    setDraftId(null);
    setDraftTitle('');
    if (!id) return;
    if (draftEmptyRef.current && !finalTitle) {
      await api.deleteEntity(id);
    } else {
      // Explicitly save-then-refresh rather than relying on NoteEditor's own
      // debounced/flush-on-unmount save, whose PATCH could otherwise still
      // be in flight when the list GET below fires — a race that would show
      // the card with stale (often still-empty) content for a beat.
      await api.updateEntity(id, { content: finalJson ?? null, title: finalTitle });
      load();
    }
  }

  // A composer left open with nothing typed shouldn't leave a phantom empty
  // jot behind if you navigate away instead of hitting Done.
  useEffect(() => {
    return () => {
      if (draftIdRef.current && draftEmptyRef.current && !draftTitleRef.current.trim()) {
        api.deleteEntity(draftIdRef.current).catch(() => {});
      }
    };
  }, []);

  async function handleConvert(parentId: string | null) {
    if (!converting) return;
    await api.convertEntity(converting.jot.id, converting.to, parentId);
    setConverting(null);
    load();
  }

  async function handleTogglePin(jot: Entity) {
    const next = jot.pinned === 1 ? 0 : 1;
    setJots((prev) => (prev ? prev.map((j) => (j.id === jot.id ? { ...j, pinned: next } : j)) : prev));
    await api.setPinned(jot.id, next === 1);
    load();
  }

  async function handleDelete() {
    if (!deleting) return;
    await api.deleteEntity(deleting.id);
    setDeleting(null);
    load();
  }

  if (!jots) return <div className="empty-state">Loading…</div>;

  return (
    <div className="jots-page">
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Jots
        </h1>
      </div>

      <div className="jots-page__composer-wrap">
        {!composerOpen ? (
          <button type="button" className="jots-page__composer-collapsed" onClick={openComposer}>
            Jot something down…
          </button>
        ) : (
          <div className="jots-page__composer-expanded card">
            {/* Deliberately not rendered until draftId resolves: mounting the
                editor immediately (keyed by a not-yet-real id) would let
                early keystrokes land in an instance whose onSave closure
                still captures a null id — a silent no-op — and then get
                wiped out entirely when the id arrives and the key changes,
                remounting a fresh, empty editor underneath. */}
            {draftId ? (
              <>
                <input
                  className="jots-page__composer-title"
                  placeholder="Title"
                  value={draftTitle}
                  onChange={(e) => handleDraftTitleChange(e.target.value)}
                />
                <NoteEditor
                  key={draftId}
                  content={null}
                  autoFocus
                  compact
                  onSave={(json) => api.updateEntity(draftId, { content: json })}
                  onChange={(json) => {
                    draftJsonRef.current = json;
                    draftEmptyRef.current = isTiptapDocEmpty(json);
                  }}
                />
              </>
            ) : (
              <div className="empty-state empty-state--section">Loading…</div>
            )}
            <div className="jots-page__composer-actions">
              <button type="button" className="btn" onClick={finishComposer} disabled={!draftId}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {jots.length === 0 ? (
        <div className="empty-state empty-state--section">Nothing sitting here right now.</div>
      ) : (
        <div className="jots-page__grid">
          {jots.map((jot) => (
            <JotCard
              key={jot.id}
              jot={jot}
              onOpen={() => setOpenJot(jot)}
              onConvert={(to) => setConverting({ jot, to })}
              onTogglePin={() => handleTogglePin(jot)}
              onDelete={() => setDeleting(jot)}
            />
          ))}
        </div>
      )}

      {openJot && (
        <JotPanel
          jotId={openJot.id}
          content={openJot.content}
          title={openJot.title}
          onClose={() => {
            setOpenJot(null);
            load();
          }}
        />
      )}

      {converting && (
        <ConvertModal to={converting.to} onConvert={handleConvert} onClose={() => setConverting(null)} />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete jot?"
          body="This jot will be permanently deleted."
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
