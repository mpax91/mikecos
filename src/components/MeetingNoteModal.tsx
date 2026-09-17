import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../api/client';
import type { MeetingItem } from '../api/types';

/** The note editor for one meeting occurrence — opened from the note icon
 * on a meeting row (TodayPage, JournalPage). Loads whatever's already
 * saved for this exact meeting id (see MeetingItem.id / the worker's
 * /api/meetings/:meetingId/note comment for why that id is stable even
 * though meetings themselves aren't stored), and upserts on Save. Saving
 * blank text clears the note entirely rather than leaving an empty one —
 * matches the "only sticks to the meeting if a note was actually taken"
 * rule the backend enforces. */
export function MeetingNoteModal({ meeting, onClose, onSaved }: { meeting: MeetingItem; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getMeetingNote(meeting.id)
      .then((res) => {
        if (!cancelled) setText(res.note?.text ?? '');
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [meeting.id]);

  async function save() {
    setSaving(true);
    try {
      await api.saveMeetingNote(meeting.id, text, meeting.title, meeting.start);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function clearNote() {
    setSaving(true);
    try {
      await api.deleteMeetingNote(meeting.id);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={meeting.title || 'Untitled meeting'} onClose={onClose}>
      <textarea
        className="meeting-note-modal__textarea"
        placeholder="Notes about this meeting…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        rows={8}
        disabled={!loaded}
      />
      <div className="modal__actions">
        {meeting.hasNote && (
          <button type="button" className="btn btn--ghost meeting-note-modal__delete" onClick={clearNote} disabled={saving}>
            Delete note
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={save} disabled={saving || !loaded}>
          Save
        </button>
      </div>
    </Modal>
  );
}
