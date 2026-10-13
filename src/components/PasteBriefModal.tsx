import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { BriefImportResult } from '../api/types';
import { Modal } from './Modal';
import { MEETING_CHANGED_EVENT, openMeetingSheet } from './MeetingSheet';

/** Paste Brief: the whole response from Mike's work Claude Project (it ends
 * with a meeting-record block). Debrief / prep → its meeting's sheet (found
 * by title on that date, or a new one-off); thread → its own sheet; weekly →
 * fills this week's Work review. Rule-based filing — the AI is in Claude. */

export function PasteBriefButton({ className = 'today-page__add-meeting' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Paste a brief from your work Claude">
        📋 Paste Brief
      </button>
      {open && <PasteBriefModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function PasteBriefModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<Extract<BriefImportResult, { kind: 'weekly' }> | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importBrief(text);
      window.dispatchEvent(new Event(MEETING_CHANGED_EVENT));
      if (r.kind === 'weekly') {
        setWeekly(r);
        return;
      }
      onClose();
      openMeetingSheet(r.meeting);
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

  return (
    <Modal title="Paste Brief" onClose={onClose} className="paste-brief">
      {weekly ? (
        <div className="paste-brief__result">
          <p>
            Week of {weekly.week}: {weekly.filled.length ? `filled ${weekly.filled.join(', ')}` : 'nothing new to add'}
            {weekly.kept.length ? ` — kept what you'd already written in ${weekly.kept.join(', ')}` : ''}.
          </p>
          <div className="paste-brief__row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                navigate(`/briefs?kind=review&week=${weekly.week}`);
              }}
            >
              Open Week in Review
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="paste-brief__hint">
            Paste the whole response from your work Claude — use the copy button under it. A meeting debrief or prep lands on that meeting (or a new one on its date), a Slack / email thread gets its own entry, and a weekly brief fills
            this week's review.
          </div>
          <textarea className="paste-brief__box" value={text} onChange={(e) => setText(e.target.value)} placeholder="## TL;DR …&#10;&#10;```meeting-record&#10;{ &quot;format&quot;: &quot;meeting-record/1&quot;, … }&#10;```" autoFocus />
          {error && <div className="mtg-error">{error}</div>}
          <div className="paste-brief__row">
            <button type="button" className="btn" disabled={busy || text.trim().length < 20} onClick={save}>
              {busy ? 'Filing…' : 'File It'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
