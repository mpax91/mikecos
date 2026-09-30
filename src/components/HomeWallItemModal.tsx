import { useState } from 'react';
import type { HomeWallItem, HomeWallItemType } from '../api/types';
import { feetInchesToInches, inchesToFeet, inchesRemainder } from '../lib/homeUnits';
import { Modal } from './Modal';
import { VaultLinkPicker } from './VaultLinkPicker';

export interface HomeWallItemFormValue {
  label: string;
  width: number; // whole inches
  swing?: 'left' | 'right';
  vaultEntryId: string | null;
  notes: string | null;
}

/** Add/edit a door or window mounted to one wall of a room. Which wall and
 * where along it is decided by where you clicked (see HomeFloorCanvas) and
 * isn't editable here — only what it IS: label, width, a door's hinge
 * side (purely which way the swing arc is drawn), and an optional Vault
 * link (exact window measurements for blinds, door hardware info). */
export function HomeWallItemModal({
  type,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  type: HomeWallItemType;
  initial?: HomeWallItem;
  onSave: (value: HomeWallItemFormValue) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [widthFt, setWidthFt] = useState(initial ? String(inchesToFeet(initial.width)) : '');
  const [widthIn, setWidthIn] = useState(initial ? String(inchesRemainder(initial.width)) : String(type === 'door' ? 30 : 36));
  const [swing, setSwing] = useState<'left' | 'right'>(initial?.swing ?? 'left');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [vaultEntryId, setVaultEntryId] = useState(initial?.vaultEntryId ?? null);
  const [vaultEntryTitle, setVaultEntryTitle] = useState(initial?.vaultEntryTitle ?? null);

  const width = feetInchesToInches(widthFt, widthIn);
  const valid = label.trim().length > 0 && width > 0;
  const noun = type === 'door' ? 'Door' : 'Window';

  function save() {
    if (!valid) return;
    onSave({ label: label.trim(), width, swing: type === 'door' ? swing : undefined, vaultEntryId, notes: notes.trim() || null });
  }

  return (
    <Modal title={initial ? `Edit "${initial.label}"` : `Add a ${noun}`} onClose={onClose}>
      <label className="wallet-editor__field">
        <span>Label</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={type === 'door' ? 'e.g. Front door, Pantry door' : 'e.g. Living room — south wall'}
        />
      </label>

      <label className="wallet-editor__field">
        <span>Width</span>
        <div className="home-feet-inches">
          <input type="number" min={0} value={widthFt} onChange={(e) => setWidthFt(e.target.value)} placeholder="0" />
          <span>ft</span>
          <input type="number" min={0} max={11} value={widthIn} onChange={(e) => setWidthIn(e.target.value)} placeholder={type === 'door' ? '30' : '36'} />
          <span>in</span>
        </div>
      </label>

      {type === 'door' && (
        <label className="wallet-editor__field">
          <span>Hinge side</span>
          <select value={swing} onChange={(e) => setSwing(e.target.value as 'left' | 'right')}>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      )}

      <VaultLinkPicker
        vaultEntryId={vaultEntryId}
        vaultEntryTitle={vaultEntryTitle}
        suggestedTitle={label}
        onChange={(v) => {
          setVaultEntryId(v.vaultEntryId);
          setVaultEntryTitle(v.vaultEntryTitle);
        }}
      />
      <div className="wallet-editor__hint" style={{ marginTop: -8 }}>
        {type === 'door' ? 'Hardware, replacement info, whatever’s worth remembering.' : 'Exact measurements for blinds/curtains, or anything else worth remembering.'}
      </div>

      <label className="wallet-editor__field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything worth remembering" />
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
