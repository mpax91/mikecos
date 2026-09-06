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
  onDelete,
}: {
  jot: Entity;
  onOpen: () => void;
  onConvert: (to: 'note' | 'task') => void;
  onDelete: () => void;
}) {
  return (
    <div className="jot-card" onClick={onOpen}>
      <div className="jot-card__top">
        <span className="last-modified-badge" title={new Date(jot.updated_at).toLocaleString()}>
          {formatRelativeTime(jot.updated_at)}
        </span>
        <KebabMenu
          items={[
            { label: 'Turn into Task', onClick: () => onConvert('task') },
            { label: 'Turn into Note', onClick: () => onConvert('note') },
            { label: 'Delete', onClick: onDelete, danger: true, separatorBefore: true },
          ]}
        />
      </div>
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
  const draftEmptyRef = useRef(true);
  const draftJsonRef = useRef<string | null>(null);
  const draftIdRef = useRef<string | null>(null);
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
      setDraftId(jot.id);
    }
  }

  async function finishComposer() {
    const id = draftIdRef.current;
    const finalJson = draftJsonRef.current;
    setComposerOpen(false);
    draftIdRef.current = null;
    setDraftId(null);
    if (!id) return;
    if (draftEmptyRef.current) {
      await api.deleteEntity(id);
    } else {
      // Explicitly save-then-refresh rather than relying on NoteEditor's own
      // debounced/flush-on-unmount save, whose PATCH could otherwise still
      // be in flight when the list GET below fires — a race that would show
      // the card with stale (often still-empty) content for a beat.
      if (finalJson) await api.updateEntity(id, { content: finalJson });
      load();
    }
  }

  // A composer left open with nothing typed shouldn't leave a phantom empty
  // jot behind if you navigate away instead of hitting Done.
  useEffect(() => {
    return () => {
      if (draftIdRef.current && draftEmptyRef.current) {
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
              <NoteEditor
                key={draftId}
                content={null}
                onSave={(json) => api.updateEntity(draftId, { content: json })}
                onChange={(json) => {
                  draftJsonRef.current = json;
                  draftEmptyRef.current = isTiptapDocEmpty(json);
                }}
              />
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
              onDelete={() => setDeleting(jot)}
            />
          ))}
        </div>
      )}

      {openJot && (
        <JotPanel
          jotId={openJot.id}
          content={openJot.content}
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
