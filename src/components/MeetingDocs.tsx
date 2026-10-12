import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { MeetingDoc } from '../api/types';
import { KebabMenu } from './KebabMenu';

/** Documents on a meeting — kept per series, so a recurring meeting (a 1:1's
 * running Google Doc) shows them on every occurrence. Links pasted into the
 * Google invite's description that point at Google Docs/Sheets/Slides show
 * underneath as "In the invite" with a one-tap Save. */

export const DOC_ICON: Record<string, string> = { doc: '📄', sheet: '📊', slides: '📽️', form: '📋', drive: '📁', link: '🔗' };

/** 'ms-abc:2026-10-13T…' → 'ms-abc' (same rule as the worker's seriesKeyOf). */
export function seriesKeyFor(meetingId: string): string {
  const i = meetingId.indexOf(':');
  return i === -1 ? meetingId : meetingId.slice(0, i);
}

const GOOGLE_FILE = /^https?:\/\/(docs|sheets|slides|drive)\.google\.com\//i;
/** Same doc, different suffix (/edit, ?usp=…, #heading) → same key. */
function docId(url: string): string {
  const m = /\/d\/([\w-]{10,})/.exec(url) ?? /[?&]id=([\w-]{10,})/.exec(url);
  return m ? m[1] : url.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

export function MeetingDocs({ seriesKey, recurring, inviteLinks, onChanged }: { seriesKey: string; recurring: boolean; inviteLinks: string[]; onChanged?: () => void }) {
  const [docs, setDocs] = useState<MeetingDoc[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MeetingDoc | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMeetingDocs(seriesKey)
      .then((r) => setDocs(r.docs))
      .catch(() => setDocs([]));
  }, [seriesKey]);

  const saved = new Set((docs ?? []).map((d) => docId(d.url)));
  const fromInvite = [...new Set(inviteLinks.filter((l) => GOOGLE_FILE.test(l)))].filter((l) => !saved.has(docId(l)));

  function startAdd(prefill = '') {
    setEditing(null);
    setUrl(prefill);
    setTitle('');
    setError(null);
    setAdding(true);
  }
  function startEdit(d: MeetingDoc) {
    setEditing(d);
    setUrl(d.url);
    setTitle(d.title);
    setError(null);
    setAdding(true);
  }
  function cancel() {
    setAdding(false);
    setEditing(null);
    setError(null);
  }

  async function save() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const d = await api.updateMeetingDoc(editing.id, { url, title });
        setDocs((list) => (list ?? []).map((x) => (x.id === d.id ? d : x)));
      } else {
        const d = await api.addMeetingDoc(seriesKey, url, title);
        setDocs((list) => [...(list ?? []), d]);
      }
      cancel();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+: /, '').replace(/^\{"error":"(.*)"\}$/, '$1') : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveFromInvite(link: string) {
    const d = await api.addMeetingDoc(seriesKey, link);
    setDocs((list) => [...(list ?? []), d]);
    onChanged?.();
  }

  async function remove(d: MeetingDoc) {
    if (!window.confirm(`Remove "${d.title}" from this meeting? The document itself isn't touched.`)) return;
    await api.deleteMeetingDoc(d.id);
    setDocs((list) => (list ?? []).filter((x) => x.id !== d.id));
    onChanged?.();
  }

  return (
    <section className="mtg-section mtg-docs">
      <div className="mtg-section__title mtg-docs__head">
        <span>Documents</span>
        {!adding && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => startAdd()}>
            + Add Document
          </button>
        )}
      </div>

      {docs && docs.length > 0 && (
        <ul className="mtg-docs__list">
          {docs.map((d) => (
            <li key={d.id} className="mtg-doc">
              <a className="mtg-doc__link" href={d.url} target="_blank" rel="noreferrer" title={d.url}>
                <span className="mtg-doc__icon" aria-hidden>
                  {DOC_ICON[d.kind] ?? '🔗'}
                </span>
                <span className="mtg-doc__title">{d.title}</span>
              </a>
              <KebabMenu
                items={[
                  { label: 'Copy Link', onClick: () => void navigator.clipboard?.writeText(d.url) },
                  { label: 'Edit', onClick: () => startEdit(d) },
                  { label: 'Remove', danger: true, separatorBefore: true, onClick: () => void remove(d) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mtg-docs__form">
          <input
            className="input"
            type="url"
            inputMode="url"
            placeholder="Paste a link — https://docs.google.com/document/d/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            autoFocus
          />
          <input className="input" placeholder="Name (optional — e.g. 1:1 Running Doc)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          {error && <div className="mtg-error">{error}</div>}
          <div className="mtg-paste__row">
            <button type="button" className="btn btn--sm" disabled={busy || !url.trim()} onClick={save}>
              {editing ? 'Save' : 'Add'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {fromInvite.length > 0 && (
        <div className="mtg-docs__invite">
          <div className="mtg-label">In the Invite</div>
          <ul className="mtg-docs__list">
            {fromInvite.map((l) => (
              <li key={l} className="mtg-doc mtg-doc--invite">
                <a className="mtg-doc__link" href={l} target="_blank" rel="noreferrer" title={l}>
                  <span className="mtg-doc__icon" aria-hidden>
                    🔗
                  </span>
                  <span className="mtg-doc__title">{l.replace(/^https?:\/\//, '')}</span>
                </a>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => saveFromInvite(l)}>
                  Save
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {docs && docs.length === 0 && !adding && fromInvite.length === 0 && (
        <div className="mtg-hint">{recurring ? 'Keep the doc this meeting works from here — it shows on every occurrence.' : 'Keep any doc for this meeting here.'}</div>
      )}
    </section>
  );
}
