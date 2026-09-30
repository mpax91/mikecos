import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ElectricalBreaker, ElectricalPanel, HomeFixture, HomeFixtureType } from '../api/types';
import { feetInchesToInches, inchesToFeet, inchesRemainder } from '../lib/homeUnits';
import { Modal } from './Modal';
import { VaultLinkPicker } from './VaultLinkPicker';

export const FIXTURE_TYPE_LABEL: Record<HomeFixtureType, string> = {
  appliance: 'Appliance',
  furniture: 'Furniture',
  outlet: 'Outlet',
  switch: 'Switch',
  fixture: 'Fixture',
};

// Footprint (width/depth) only matters for things that actually take up
// floor space you'd plan furniture layout around — an outlet on the wall
// isn't something you're checking clearance for.
const HAS_FOOTPRINT: HomeFixtureType[] = ['appliance', 'furniture'];
// Furniture is never on a circuit; everything else plausibly is (a
// dishwasher or range is usually hardwired straight to a breaker, not
// plugged into a switched outlet).
const HAS_BREAKER: HomeFixtureType[] = ['appliance', 'outlet', 'switch', 'fixture'];
// "Smart device" tracking matches what Mike actually asked for — outlets
// and switches that might carry a smart plug/switch and, someday, an
// automation. Not offered for appliance/furniture/fixture to keep the form
// from growing a field nobody uses there.
const HAS_SMART: HomeFixtureType[] = ['outlet', 'switch'];

export interface HomeFixtureFormValue {
  label: string;
  width: number;
  depth: number;
  vaultEntryId: string | null;
  breakerId: string | null;
  smartDevice: boolean;
  smartNotes: string | null;
  notes: string | null;
}

/** Add/edit a single placed fixture — an appliance/furniture footprint, or
 * an outlet/switch/fixture symbol. Type is fixed at creation (which "+ Add
 * …" toolbar button was clicked) and never changes on edit, since that's
 * what picks which fields below even apply. */
export function HomeFixtureModal({
  type,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  type: HomeFixtureType;
  initial?: HomeFixture;
  onSave: (value: HomeFixtureFormValue) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [widthFt, setWidthFt] = useState(initial ? String(inchesToFeet(initial.width)) : '');
  const [widthIn, setWidthIn] = useState(initial ? String(inchesRemainder(initial.width)) : '');
  const [depthFt, setDepthFt] = useState(initial ? String(inchesToFeet(initial.depth)) : '');
  const [depthIn, setDepthIn] = useState(initial ? String(inchesRemainder(initial.depth)) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [smartDevice, setSmartDevice] = useState(initial?.smartDevice ?? false);
  const [smartNotes, setSmartNotes] = useState(initial?.smartNotes ?? '');

  const [vaultEntryId, setVaultEntryId] = useState(initial?.vaultEntryId ?? null);
  const [vaultEntryTitle, setVaultEntryTitle] = useState(initial?.vaultEntryTitle ?? null);

  const [breakerId, setBreakerId] = useState(initial?.breakerId ?? null);
  const [panels, setPanels] = useState<ElectricalPanel[] | null>(null);
  const [breakersByPanel, setBreakersByPanel] = useState<Record<string, ElectricalBreaker[]>>({});

  const hasFootprint = HAS_FOOTPRINT.includes(type);
  const hasBreaker = HAS_BREAKER.includes(type);
  const hasSmart = HAS_SMART.includes(type);

  useEffect(() => {
    if (!hasBreaker) return;
    api
      .listElectricalPanels()
      .then(async (list) => {
        setPanels(list);
        const entries = await Promise.all(list.map((p) => api.listElectricalBreakers(p.id).then((bs): [string, ElectricalBreaker[]] => [p.id, bs])));
        setBreakersByPanel(Object.fromEntries(entries));
      })
      .catch(() => setPanels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const width = feetInchesToInches(widthFt, widthIn);
  const depth = feetInchesToInches(depthFt, depthIn);
  const valid = label.trim().length > 0;

  function save() {
    if (!valid) return;
    onSave({
      label: label.trim(),
      width: hasFootprint ? width || 1 : initial?.width ?? 6,
      depth: hasFootprint ? depth || 1 : initial?.depth ?? 6,
      vaultEntryId,
      breakerId: hasBreaker ? breakerId : null,
      smartDevice: hasSmart ? smartDevice : false,
      smartNotes: hasSmart ? smartNotes.trim() || null : null,
      notes: notes.trim() || null,
    });
  }

  return (
    <Modal title={initial ? `Edit "${initial.label}"` : `Add ${FIXTURE_TYPE_LABEL[type] === 'Outlet' ? 'an' : 'a'} ${FIXTURE_TYPE_LABEL[type]}`} onClose={onClose}>
      <label className="wallet-editor__field">
        <span>Label</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={type === 'appliance' ? 'e.g. Dishwasher' : type === 'furniture' ? 'e.g. Sofa' : type === 'outlet' ? 'e.g. Kitchen counter — north wall' : type === 'switch' ? 'e.g. Hallway lights' : 'e.g. Ceiling fan'}
        />
      </label>

      {hasFootprint && (
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Width</span>
            <div className="home-feet-inches">
              <input type="number" min={0} value={widthFt} onChange={(e) => setWidthFt(e.target.value)} placeholder="2" />
              <span>ft</span>
              <input type="number" min={0} max={11} value={widthIn} onChange={(e) => setWidthIn(e.target.value)} placeholder="0" />
              <span>in</span>
            </div>
          </label>
          <label className="wallet-editor__field">
            <span>Depth</span>
            <div className="home-feet-inches">
              <input type="number" min={0} value={depthFt} onChange={(e) => setDepthFt(e.target.value)} placeholder="3" />
              <span>ft</span>
              <input type="number" min={0} max={11} value={depthIn} onChange={(e) => setDepthIn(e.target.value)} placeholder="0" />
              <span>in</span>
            </div>
          </label>
        </div>
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
        Purchase info, serial number, and the manual all live on the Vault entry — this just points at it so clicking the fixture takes you straight there.
      </div>

      {hasBreaker && (
        <label className="wallet-editor__field">
          <span>Circuit breaker</span>
          <select value={breakerId ?? ''} onChange={(e) => setBreakerId(e.target.value || null)}>
            <option value="">Not assigned</option>
            {(panels ?? []).map((p) => (
              <optgroup key={p.id} label={p.name}>
                {(breakersByPanel[p.id] ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    #{b.number}
                    {b.label ? ` — ${b.label}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {panels !== null && panels.length === 0 && <div className="wallet-editor__hint">No electrical panels set up yet — add one from the Electrical tab.</div>}
        </label>
      )}

      {hasSmart && (
        <>
          <label className="home-checkbox-field">
            <input type="checkbox" checked={smartDevice} onChange={(e) => setSmartDevice(e.target.checked)} />
            <span>This is a smart {type} (app/automation-controlled)</span>
          </label>
          {smartDevice && (
            <label className="wallet-editor__field">
              <span>Smart device notes</span>
              <input value={smartNotes} onChange={(e) => setSmartNotes(e.target.value)} placeholder="Make/model, which app, what it's grouped with" />
            </label>
          )}
        </>
      )}

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
