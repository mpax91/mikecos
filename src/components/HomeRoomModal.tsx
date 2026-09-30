import { useState } from 'react';
import type { HomeRoom } from '../api/types';
import { feetInchesToInches, inchesToFeet, inchesRemainder, formatFeetInches } from '../lib/homeUnits';
import { roomHasCustomShape } from '../lib/homeGeometry';
import { Modal } from './Modal';

export interface HomeRoomFormValue {
  name: string;
  width: number; // whole inches
  depth: number; // whole inches
  notes: string | null;
}

/** Add/edit a Room — dimensions are entered as separate feet/inches pairs
 * (matching how Mike will actually have the numbers, off a tape measure or
 * a floor plan) and converted to whole inches for storage, since that's
 * the unit the to-scale canvas draws everything in. */
export function HomeRoomModal({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: HomeRoom;
  onSave: (value: HomeRoomFormValue) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [widthFt, setWidthFt] = useState(initial ? String(inchesToFeet(initial.width)) : '');
  const [widthIn, setWidthIn] = useState(initial ? String(inchesRemainder(initial.width)) : '');
  const [depthFt, setDepthFt] = useState(initial ? String(inchesToFeet(initial.depth)) : '');
  const [depthIn, setDepthIn] = useState(initial ? String(inchesRemainder(initial.depth)) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const customShape = initial ? roomHasCustomShape(initial.points) : false;

  const width = feetInchesToInches(widthFt, widthIn);
  const depth = feetInchesToInches(depthFt, depthIn);
  const valid = name.trim() && (customShape || (width > 0 && depth > 0));

  function save() {
    if (!valid) return;
    onSave({ name: name.trim(), width: customShape ? initial!.width : width, depth: customShape ? initial!.depth : depth, notes: notes.trim() || null });
  }

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : 'Add a Room'} onClose={onClose}>
      <label className="wallet-editor__field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kitchen, Primary Bedroom" />
      </label>

      {customShape ? (
        <div className="wallet-editor__hint">
          This room's been shaped on the canvas ({formatFeetInches(initial!.width)} × {formatFeetInches(initial!.depth)} bounding box) — drag its walls there to resize. Name and notes only here.
        </div>
      ) : (
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Width</span>
            <div className="home-feet-inches">
              <input type="number" min={0} value={widthFt} onChange={(e) => setWidthFt(e.target.value)} placeholder="12" />
              <span>ft</span>
              <input type="number" min={0} max={11} value={widthIn} onChange={(e) => setWidthIn(e.target.value)} placeholder="6" />
              <span>in</span>
            </div>
          </label>
          <label className="wallet-editor__field">
            <span>Depth</span>
            <div className="home-feet-inches">
              <input type="number" min={0} value={depthFt} onChange={(e) => setDepthFt(e.target.value)} placeholder="14" />
              <span>ft</span>
              <input type="number" min={0} max={11} value={depthIn} onChange={(e) => setDepthIn(e.target.value)} placeholder="0" />
              <span>in</span>
            </div>
          </label>
        </div>
      )}

      <label className="wallet-editor__field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Ceiling height, flooring, anything worth remembering" />
      </label>

      <div className="modal__actions">
        {onDelete && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={onDelete}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!valid}>
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </Modal>
  );
}
