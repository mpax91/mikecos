import { useState } from 'react';
import type { BarTasting } from '../api/types';
import { Modal } from './Modal';
import { StarRating } from './StarRating';

// One shared tag vocabulary across spirits/wine/beer rather than a
// per-type list — keeps the tasting log's shape (and the eventual "what do
// I tend to like" view) consistent, and these descriptors read fine for
// all three anyway. Tap-to-toggle rather than typed, so logging a tasting
// stays a few taps, not a paragraph.
const TAGS = ['Fruity', 'Tannic', 'Oaky', 'Light', 'Bold', 'Smooth', 'Spicy', 'Sweet', 'Dry', 'Smoky', 'Crisp', 'Complex'];

export interface TastingFormValue {
  consumedAt: string | null;
  score: number | null;
  tags: string[];
  notes: string | null;
  buyAgain: boolean | null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Log or edit a tasting — Vivino/Untappd-lite: a half-star score, a
 * handful of tap-to-toggle descriptors instead of typing them out, and a
 * free-text notes field with a prompt placeholder rather than a blank box.
 * Score/tags/notes are all optional (score alone, or notes alone, are both
 * fine — this shouldn't feel like paperwork). */
export function BarTastingModal({
  itemName,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  itemName: string;
  initial?: BarTasting;
  onSave: (value: TastingFormValue) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [consumedAt, setConsumedAt] = useState(initial?.consumedAt ?? todayIso());
  const [score, setScore] = useState<number | null>(initial?.score ?? null);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [buyAgain, setBuyAgain] = useState<boolean | null>(initial?.buyAgain ?? null);

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function save() {
    onSave({ consumedAt: consumedAt || null, score, tags, notes: notes.trim() || null, buyAgain });
  }

  return (
    <Modal title={`Log a tasting — ${itemName}`} onClose={onClose}>
      <label className="wallet-editor__field">
        <span>Date</span>
        <input type="date" value={consumedAt} onChange={(e) => setConsumedAt(e.target.value)} />
      </label>

      <label className="wallet-editor__field">
        <span>Score</span>
        <StarRating value={score} onChange={setScore} size={26} />
      </label>

      <label className="wallet-editor__field">
        <span>Tasting notes</span>
        <div className="bar-tasting__tags">
          {TAGS.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`chip${tags.includes(tag) ? ' is-active' : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      </label>

      <label className="wallet-editor__field">
        <span>Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What did you taste? Who was it with? Would you buy it again?"
        />
      </label>

      <label className="wallet-editor__field">
        <span>Buy again?</span>
        <div className="bar-tasting__buy-again">
          <button type="button" className={`chip${buyAgain === true ? ' is-active' : ''}`} onClick={() => setBuyAgain(buyAgain === true ? null : true)}>
            👍 Yes
          </button>
          <button type="button" className={`chip${buyAgain === false ? ' is-active' : ''}`} onClick={() => setBuyAgain(buyAgain === false ? null : false)}>
            👎 No
          </button>
        </div>
      </label>

      <div className="modal__actions">
        {onDelete && (
          <button className="btn btn--ghost btn--danger" onClick={onDelete} style={{ marginRight: 'auto' }}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
