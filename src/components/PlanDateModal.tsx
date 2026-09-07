import { useState } from 'react';
import { Modal } from './Modal';

function tomorrowLocalISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Small date-only picker for "Plan for a date" — turns a Jot into a
 * standalone task due on the chosen date in one step. Deliberately not the
 * full project-picker ConvertModal: planning something onto the daily
 * planner shouldn't require deciding whether it belongs to a project first,
 * same as jotting it down in the first place didn't. */
export function PlanDateModal({ onPlan, onClose }: { onPlan: (date: string) => void; onClose: () => void }) {
  const [date, setDate] = useState(tomorrowLocalISO());

  return (
    <Modal title="Plan for a date" onClose={onClose}>
      <div className="task-panel__field">
        <input type="date" autoFocus value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={() => date && onPlan(date)} disabled={!date}>
          Plan
        </button>
      </div>
    </Modal>
  );
}
