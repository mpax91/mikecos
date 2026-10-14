import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Editor } from '@tiptap/react';
import { api } from '../api/client';
import type { ListItem } from '../api/types';

/** Highlight text in a note → do something with it (Mike, 2026-10-13):
 * a task due tomorrow, a Waiting check-back, a project, a list item, a jot,
 * or a link. The new item remembers the note it came from (so the next
 * meeting's prep can show what came of last time's notes), and the text is
 * highlighted in the note so it reads as handled. */

type Kind = 'task' | 'waiting' | 'project' | 'list' | 'jot' | 'link';
type Done = { kind: Kind; title: string; path: string; dueDate: string | null; listTitle?: string };

const LABEL: Record<Kind, string> = { task: '✓ Task', waiting: '⏳ Waiting', project: '📁 Project', list: '☑️ List', jot: '🗒️ Jot', link: '🔗 Link' };
const fmtDue = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const URL_RE = /https?:\/\/\S+/i;

export function NoteSelectionMenu({ editor, noteId, container }: { editor: Editor; noteId: string; container: HTMLElement | null }) {
  const [lists, setLists] = useState<ListItem[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSel = useRef('');

  const { from, to, empty } = editor.state.selection;
  const text = empty ? '' : editor.state.doc.textBetween(from, to, ' ', ' ').trim();
  const selKey = `${from}:${to}`;
  useEffect(() => {
    if (lastSel.current !== selKey) {
      lastSel.current = selKey;
      setPicking(false);
      setError(null);
      if (text) setDone(null);
    }
  }, [selKey, text]);

  // A confirmation lingers a few seconds after the selection collapses.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 6000);
    return () => window.clearTimeout(t);
  }, [done]);

  const show = (text.length >= 2 && editor.isFocused) || !!done;
  if (!show || !container) return null;

  // Place under the end of the selection, inside the content area.
  let top = 0;
  let left = 0;
  try {
    const box = container.getBoundingClientRect();
    const at = editor.view.coordsAtPos(done ? editor.state.selection.to : to);
    top = at.bottom - box.top + container.scrollTop + 8;
    left = Math.max(0, Math.min(at.left - box.left - 20, box.width - 330));
  } catch {
    return null;
  }

  async function act(kind: Kind, listId?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.noteSelectionAction({ noteId, text, kind, listId });
      // Mark it handled in the note, then drop the selection.
      editor.chain().setTextSelection({ from, to }).setHighlight().setTextSelection(to).run();
      setDone({ kind, title: r.title, path: r.path, dueDate: r.dueDate, listTitle: r.listTitle });
      setPicking(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^API \d+: /, '') : String(e);
      try {
        setError((JSON.parse(msg) as { error?: string }).error ?? msg);
      } catch {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openLists() {
    setPicking(true);
    if (!lists) setLists((await api.listLists().catch(() => [])).filter((l) => l.status !== 'archived'));
  }

  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();
  return (
    <div className="note-sel" style={{ top, left }} onMouseDown={keep} role="toolbar" aria-label="Do something with the selected text">
      {done ? (
        <div className="note-sel__done">
          <span>
            {done.kind === 'task' && `Task added · due ${done.dueDate ? fmtDue(done.dueDate) : 'tomorrow'}`}
            {done.kind === 'waiting' && `Waiting · check back ${done.dueDate ? fmtDue(done.dueDate) : 'in a week'}`}
            {done.kind === 'project' && 'Project created'}
            {done.kind === 'list' && `Added to ${done.listTitle ?? 'list'}`}
            {done.kind === 'jot' && 'Saved as a jot'}
            {done.kind === 'link' && 'Link saved'}
          </span>
          <Link to={done.path} className="note-sel__open">
            Open →
          </Link>
        </div>
      ) : picking ? (
        <div className="note-sel__lists">
          {lists === null ? (
            <span className="note-sel__hint">Loading lists…</span>
          ) : lists.length === 0 ? (
            <span className="note-sel__hint">No lists yet.</span>
          ) : (
            lists.map((l) => (
              <button key={l.id} type="button" className="note-sel__btn" disabled={busy} onClick={() => act('list', l.id)}>
                {l.title}
              </button>
            ))
          )}
          <button type="button" className="note-sel__btn note-sel__btn--quiet" onClick={() => setPicking(false)}>
            ‹ Back
          </button>
        </div>
      ) : (
        <>
          {(['task', 'waiting', 'project'] as Kind[]).map((k) => (
            <button key={k} type="button" className="note-sel__btn" disabled={busy} onClick={() => act(k)}>
              {LABEL[k]}
            </button>
          ))}
          <button type="button" className="note-sel__btn" disabled={busy} onClick={openLists}>
            {LABEL.list}
          </button>
          <button type="button" className="note-sel__btn" disabled={busy} onClick={() => act('jot')}>
            {LABEL.jot}
          </button>
          {URL_RE.test(text) && (
            <button type="button" className="note-sel__btn" disabled={busy} onClick={() => act('link')}>
              {LABEL.link}
            </button>
          )}
          {error && <span className="note-sel__error">{error}</span>}
        </>
      )}
    </div>
  );
}
