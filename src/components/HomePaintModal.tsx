import { useState } from 'react';
import { api } from '../api/client';
import type { HomePaint } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import type { RoomOption } from './HomeNetworkDeviceModal';
import { Modal } from './Modal';

const SURFACES = ['Walls', 'Ceiling', 'Trim', 'Doors', 'Accent Wall', 'Cabinets', 'Closet', 'Windows', 'Floor', 'Stairs', 'Exterior'];
const BRANDS = ['Benjamin Moore', 'Sherwin-Williams', 'Behr', 'Farrow & Ball', 'Valspar', 'PPG'];
const PRODUCTS = ['Aura', 'Regal Select', 'Ben', 'Advance', 'Ceiling Paint', 'Waterborne Ceiling', 'Duration', 'Emerald', 'SuperPaint'];
const FINISHES = ['Ultra Flat', 'Flat', 'Matte', 'Eggshell', 'Pearl', 'Satin', 'Semi-Gloss', 'Gloss', 'High Gloss'];

/** "AF-680 Wish" — code then name, whichever exist. */
export function paintColorLabel(p: Pick<HomePaint, 'colorCode' | 'colorName'>): string {
  return [p.colorCode, p.colorName].filter(Boolean).join(' ');
}

/** One-line summary of a paint for pickers: "Trim · Living Room — Aura OC-151 White". */
function paintPickLabel(p: HomePaint): string {
  const color = paintColorLabel(p);
  return `${p.surface}${p.roomName ? ` · ${p.roomName}` : ''}${color || p.product ? ` — ${[p.product, color].filter(Boolean).join(' ')}` : ''}`;
}

/** Add / edit one painted surface (Home → Paint). "Same As" copies the paint
 * from another surface (the same trim white in every room). */
export function HomePaintModal({
  paint,
  defaults,
  rooms,
  allPaints,
  onSaved,
  onDeleted,
  onClose,
}: {
  paint: HomePaint | 'new';
  defaults?: { roomId?: string | null };
  rooms: RoomOption[];
  /** Every paint entry — feeds suggestions and Same As. */
  allPaints: HomePaint[];
  onSaved: (p: HomePaint) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const isNew = paint === 'new';
  const p = isNew ? null : paint;
  const [roomId, setRoomId] = useState(p?.roomId ?? defaults?.roomId ?? '');
  const [surface, setSurface] = useState(p?.surface ?? '');
  const [brand, setBrand] = useState(p?.brand ?? '');
  const [product, setProduct] = useState(p?.product ?? '');
  const [finish, setFinish] = useState(p?.finish ?? '');
  const [colorName, setColorName] = useState(p?.colorName ?? '');
  const [colorCode, setColorCode] = useState(p?.colorCode ?? '');
  const [hex, setHex] = useState(p?.hex ?? '');
  const [formula, setFormula] = useState(p?.formula ?? '');
  const [store, setStore] = useState(p?.store ?? '');
  const [paintedOn, setPaintedOn] = useState(p?.paintedOn ?? '');
  const [notes, setNotes] = useState(p?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const uniq = (vals: (string | null)[], base: string[] = []) => [...new Set([...vals.filter((v): v is string => !!v), ...base])].sort((a, b) => a.localeCompare(b));
  const surfaceOptions = uniq(
    allPaints.map((x) => x.surface),
    SURFACES,
  );
  const brandOptions = uniq(
    allPaints.map((x) => x.brand),
    BRANDS,
  );
  const productOptions = uniq(
    allPaints.map((x) => x.product),
    PRODUCTS,
  );
  const finishOptions = uniq(
    allPaints.map((x) => x.finish),
    FINISHES,
  );
  const storeOptions = uniq(allPaints.map((x) => x.store));
  const sameAsOptions = allPaints.filter((x) => x.id !== p?.id && (x.colorName || x.colorCode || x.product));

  const floors: { id: string; name: string; rooms: RoomOption[] }[] = [];
  for (const r of rooms) {
    let f = floors.find((x) => x.id === r.floorId);
    if (!f) floors.push((f = { id: r.floorId, name: r.floorName, rooms: [] }));
    f.rooms.push(r);
  }

  function copyFrom(id: string) {
    const src = allPaints.find((x) => x.id === id);
    if (!src) return;
    setBrand(src.brand ?? '');
    setProduct(src.product ?? '');
    setFinish(src.finish ?? '');
    setColorName(src.colorName ?? '');
    setColorCode(src.colorCode ?? '');
    setHex(src.hex ?? '');
    setFormula(src.formula ?? '');
    setStore(src.store ?? '');
    if (!surface.trim()) setSurface(src.surface);
  }

  async function save() {
    if (!surface.trim() || saving) return;
    setSaving(true);
    setError(null);
    const payload = {
      roomId: roomId || null,
      surface: surface.trim(),
      brand: brand.trim() || null,
      product: product.trim() || null,
      finish: finish.trim() || null,
      colorName: colorName.trim() || null,
      colorCode: colorCode.trim() || null,
      hex: hex.trim() || null,
      formula: formula.trim() || null,
      store: store.trim() || null,
      paintedOn: paintedOn || null,
      notes: notes.trim() || null,
    };
    try {
      const saved = p ? await api.updateHomePaint(p.id, payload) : await api.createHomePaint(payload);
      onSaved(saved);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!p) return;
    await api.deleteHomePaint(p.id);
    onDeleted(p.id);
  }

  const validHex = /^#?[0-9a-f]{6}$/i.test(hex.trim()) ? (hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`) : null;

  return (
    <Modal title={isNew ? 'Add Paint' : `Edit ${p!.surface}${p!.roomName ? ` · ${p!.roomName}` : ''}`} onClose={onClose} className="home-net-modal">
      <div className="home-net-modal__form">
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">—</option>
              {floors.map((f) => (
                <optgroup key={f.id} label={f.name}>
                  {f.rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Surface</span>
            <input autoFocus={isNew} list="home-paint-surfaces" value={surface} onChange={(e) => setSurface(e.target.value)} placeholder="Walls, Ceiling, Trim…" />
            <datalist id="home-paint-surfaces">
              {surfaceOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
        </div>

        {sameAsOptions.length > 0 && (
          <label className="wallet-editor__field">
            <span>Same Paint As…</span>
            <select value="" onChange={(e) => e.target.value && copyFrom(e.target.value)}>
              <option value="">Copy from another surface…</option>
              {sameAsOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {paintPickLabel(x)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Brand</span>
            <input list="home-paint-brands" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Benjamin Moore" />
            <datalist id="home-paint-brands">
              {brandOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="wallet-editor__field">
            <span>Type</span>
            <input list="home-paint-products" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="e.g. Aura" />
            <datalist id="home-paint-products">
              {productOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Finish</span>
            <input list="home-paint-finishes" value={finish} onChange={(e) => setFinish(e.target.value)} placeholder="e.g. Matte" />
            <datalist id="home-paint-finishes">
              {finishOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="wallet-editor__field">
            <span>Swatch</span>
            <span className="home-paint-modal__swatch">
              <input type="color" value={validHex ?? '#ffffff'} onChange={(e) => setHex(e.target.value.toUpperCase())} aria-label="Pick swatch color" />
              <input className="home-net-mono" value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#RRGGBB" spellCheck={false} />
            </span>
          </label>
        </div>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Color Code</span>
            <input value={colorCode} onChange={(e) => setColorCode(e.target.value)} placeholder="e.g. AF-680" autoCapitalize="characters" />
          </label>
          <label className="wallet-editor__field">
            <span>Color Name</span>
            <input value={colorName} onChange={(e) => setColorName(e.target.value)} placeholder="e.g. Wish" />
          </label>
        </div>
        <label className="wallet-editor__field">
          <span>Tint Formula</span>
          <textarea className="home-net-mono" rows={4} value={formula} onChange={(e) => setFormula(e.target.value)} placeholder="One colorant per line, as printed on the can" spellCheck={false} />
        </label>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Bought At</span>
            <input list="home-paint-stores" value={store} onChange={(e) => setStore(e.target.value)} placeholder="e.g. the paint store" />
            <datalist id="home-paint-stores">
              {storeOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="wallet-editor__field">
            <span>Painted On</span>
            <input type="date" value={paintedOn} onChange={(e) => setPaintedOn(e.target.value)} />
          </label>
        </div>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Leftover quart in the basement" />
        </label>
        {error && <div className="home-net-modal__error">{error}</div>}
      </div>
      <div className="modal__actions">
        {!isNew && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!surface.trim() || saving}>
          {isNew ? 'Add' : 'Save'}
        </button>
      </div>
      {confirmDelete && p && (
        <ConfirmModal title="Delete this paint?" body={`${p.surface}${p.roomName ? ` in ${p.roomName}` : ''} will be removed from Home → Paint.`} onConfirm={doDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </Modal>
  );
}
