import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { BarItem, BarItemType } from '../api/types';
import { Modal } from './Modal';

// Every one of these is now a real locked dropdown, not free text with
// suggestions — the whole point of this redesign is that "Type"/"Category"/
// "Color"/"Geo" are a small, consistent vocabulary so Mike can actually
// filter on them later ("all my red wines", "all Barolos", "all vodkas")
// instead of hoping he typed the same thing twice.
const SPIRIT_CATEGORIES = ['Gin', 'Vodka', 'Whiskey', 'Bourbon', 'Scotch', 'Rum', 'Tequila', 'Mezcal', 'Liqueur', 'Brandy & Cognac', 'Amaro', 'Other'];

const WINE_COLORS = ['Red', 'White', 'Rosé', 'Sparkling', 'Orange'];

// Country-level only — on purpose. Mike's old finer "Region" field
// (e.g. "Piedmont, Italy") is dropped; Type below is often itself a
// sub-region (Barolo literally is one), and country is what's actually
// worth filtering by.
const WINE_GEO = ['Italy', 'France', 'USA', 'Spain', 'Portugal', 'Argentina', 'Chile', 'Germany', 'Australia', 'New Zealand', 'Other'];

// "Type" deliberately mixes appellations (Barolo, Chianti — place-based
// names) with grape varietals (Cabernet Sauvignon, Pinot Noir) in one flat
// list, because that's genuinely how a bottle gets described out loud —
// nobody says "Nebbiolo" when they mean the Barolo in the rack. Still
// leans Italian, same as the old varietal list did, since that's most of
// what's actually in the rack.
const WINE_TYPES = [
  'Barolo', "Barbera d'Alba", 'Chianti', 'Chianti Classico', 'Brunello di Montalcino', 'Vino Nobile di Montepulciano',
  'Amarone della Valpolicella', 'Valpolicella', 'Soave', 'Primitivo di Manduria', "Nero d'Avola", 'Aglianico',
  'Montepulciano d’Abruzzo', 'Prosecco',
  'Bordeaux Blend', 'Burgundy (Red)', 'Burgundy (White)', 'Châteauneuf-du-Pape', 'Côtes du Rhône', 'Beaujolais', 'Champagne', 'Sancerre',
  'Rioja', 'Ribera del Duero', 'Priorat', 'Cava', 'Port',
  'Cabernet Sauvignon', 'Pinot Noir', 'Merlot', 'Syrah/Shiraz', 'Malbec', 'Zinfandel', 'Grenache',
  'Chardonnay', 'Sauvignon Blanc', 'Riesling', 'Pinot Grigio',
  'Red Blend', 'White Blend', 'Other',
];

const BEER_STYLES = ['IPA', 'Pale Ale', 'Lager', 'Pilsner', 'Stout', 'Porter', 'Wheat', 'Sour', 'Belgian', 'Amber', 'Other'];

// "Gift" sits first since it's the one non-store option Mike wants offered
// right alongside real store names — same freeform-with-suggestions pattern
// as before (Store is the one field that stays free text — a store name is
// genuinely open-ended, unlike the category-style fields above).
const SOURCE_SUGGESTIONS = ['Gift', 'Total Wine', 'Costco', 'BevMo', "Trader Joe's", 'Local wine shop', 'Winery direct', 'Duty free'];

const TYPE_ICON: Record<BarItemType, string> = { spirit: '🥃', wine: '🍷', beer: '🍺' };

function categoryOptions(type: BarItemType): string[] {
  if (type === 'spirit') return SPIRIT_CATEGORIES;
  if (type === 'wine') return WINE_TYPES;
  return BEER_STYLES;
}

// Most bottle photos are vertical, so that's the fallback if dimensions
// can't be read — but it's always detected from the actual uploaded image
// (front label shot, a case, whatever Mike points the camera at), same
// pattern as Wallet card art (see WalletCardEditor.tsx's detectOrientation
// — Mike never picks this himself).
function detectOrientation(file: File): Promise<'landscape' | 'portrait'> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalHeight >= img.naturalWidth ? 'portrait' : 'landscape');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('portrait');
    };
    img.src = url;
  });
}

export interface BarItemFormValue {
  type: BarItemType;
  name: string;
  category: string | null;
  producer: string | null;
  vintage: number | null;
  color: string | null;
  geo: string | null;
  quantity: number;
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  notes: string | null;
  price: number | null;
  source: string | null;
  photoKey: string | null;
  photoOrientation: 'landscape' | 'portrait';
}

/** Add/edit a Bar item. Category/Type/Color/Geo are all locked dropdowns
 * (a small fixed vocabulary) rather than free text — that's what makes
 * "show me all my red wines" or "all my Barolos" actually work later on
 * the Bar page's filters, instead of depending on Mike having typed the
 * same word the same way every time. Wine gets the extra Color/Geo/vintage/
 * drink-window fields, since those genuinely don't apply to a bottle of
 * gin or a six-pack. */
export function BarItemModal({
  type,
  initial,
  onSave,
  onClose,
}: {
  type: BarItemType;
  initial?: BarItem;
  onSave: (value: BarItemFormValue) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [color, setColor] = useState(initial?.color ?? '');
  const [geo, setGeo] = useState(initial?.geo ?? '');
  const [producer, setProducer] = useState(initial?.producer ?? '');
  const [vintage, setVintage] = useState(initial?.vintage != null ? String(initial.vintage) : '');
  const [quantity, setQuantity] = useState(initial?.quantity != null ? String(initial.quantity) : '1');
  const [drinkStart, setDrinkStart] = useState(initial?.drinkWindowStart != null ? String(initial.drinkWindowStart) : '');
  const [drinkEnd, setDrinkEnd] = useState(initial?.drinkWindowEnd != null ? String(initial.drinkWindowEnd) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price) : '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [photoKey, setPhotoKey] = useState(initial?.photoKey ?? null);
  const [photoOrientation, setPhotoOrientation] = useState<'landscape' | 'portrait'>(initial?.photoOrientation ?? 'portrait');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const isWine = type === 'wine';

  async function handlePhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const [res, orientation] = await Promise.all([api.uploadInline(file), detectOrientation(file)]);
      setPhotoKey(res.r2_key);
      setPhotoOrientation(orientation);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function save() {
    if (!name.trim()) return;
    onSave({
      type,
      name: name.trim(),
      category: category || null,
      producer: producer.trim() || null,
      vintage: vintage.trim() ? Number(vintage) : null,
      color: isWine ? color || null : null,
      geo: isWine ? geo || null : null,
      quantity: quantity.trim() ? Math.max(0, Math.trunc(Number(quantity))) : 1,
      drinkWindowStart: drinkStart.trim() ? Number(drinkStart) : null,
      drinkWindowEnd: drinkEnd.trim() ? Number(drinkEnd) : null,
      notes: notes.trim() || null,
      price: price.trim() ? Number(price) : null,
      source: source.trim() || null,
      photoKey,
      photoOrientation,
    });
  }

  const typeLabel = type === 'spirit' ? 'Spirit' : type === 'wine' ? 'Wine' : 'Beer';
  const categoryLabel = isWine ? 'Type' : type === 'beer' ? 'Style' : 'Category';

  const photoPreview = photoKey ? api.fileUrl(photoKey) : null;

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : `Add a ${typeLabel}`} onClose={onClose}>
      <div className="wallet-editor__image-slot" style={{ marginBottom: 12 }}>
        <div className={`bar-item-modal__photo-preview${photoOrientation === 'landscape' ? ' bar-item-modal__photo-preview--landscape' : ''}`}>
          {photoPreview ? <img src={photoPreview} alt="" /> : <span>{TYPE_ICON[type]}</span>}
        </div>
        <input ref={photoInputRef} type="file" accept="image/*" onChange={handlePhotoPick} style={{ display: 'none' }} />
        <div className="wallet-editor__image-actions">
          <button type="button" className="btn btn--ghost" onClick={() => photoInputRef.current?.click()} disabled={uploadingPhoto}>
            {uploadingPhoto ? 'Uploading…' : photoKey ? 'Replace photo' : 'Add a photo'}
          </button>
          {photoKey && (
            <button type="button" className="btn btn--ghost" onClick={() => setPhotoKey(null)}>
              Remove
            </button>
          )}
        </div>
      </div>

      <label className="wallet-editor__field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isWine ? 'e.g. Produttori del Barbaresco' : 'e.g. Hendrick’s Gin'} />
      </label>

      {isWine && (
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Color</span>
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              <option value="">Select…</option>
              {WINE_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Geo</span>
            <select value={geo} onChange={(e) => setGeo(e.target.value)}>
              <option value="">Select…</option>
              {WINE_GEO.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="bar-item-modal__row">
        <label className="wallet-editor__field">
          <span>{categoryLabel}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select…</option>
            {categoryOptions(type).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {isWine && (
          <label className="wallet-editor__field">
            <span>Year</span>
            <input type="number" value={vintage} onChange={(e) => setVintage(e.target.value)} placeholder="2021" />
          </label>
        )}
      </div>

      <label className="wallet-editor__field">
        <span>{isWine ? 'Producer / winery' : type === 'beer' ? 'Brewery' : 'Distillery'}</span>
        <input value={producer} onChange={(e) => setProducer(e.target.value)} />
      </label>

      {isWine && (
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Drink window — from (optional)</span>
            <input type="number" value={drinkStart} onChange={(e) => setDrinkStart(e.target.value)} placeholder="2028" />
          </label>
          <label className="wallet-editor__field">
            <span>Drink window — to (optional)</span>
            <input type="number" value={drinkEnd} onChange={(e) => setDrinkEnd(e.target.value)} placeholder="2029" />
          </label>
        </div>
      )}

      <label className="wallet-editor__field">
        <span>Quantity on hand</span>
        <input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>

      <div className="bar-item-modal__row">
        <label className="wallet-editor__field">
          <span>Price (optional)</span>
          <input type="number" min={0} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="24.99" />
        </label>
        <label className="wallet-editor__field">
          <span>Store — or Gift (optional)</span>
          <input value={source} onChange={(e) => setSource(e.target.value)} list="bar-source-options" placeholder="Where'd it come from?" />
          <datalist id="bar-source-options">
            {SOURCE_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
      </div>

      <label className="wallet-editor__field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Where it's from, who gave it to you, anything worth remembering" />
      </label>

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!name.trim()}>
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </Modal>
  );
}
