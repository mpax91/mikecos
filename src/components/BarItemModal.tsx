import { useState } from 'react';
import type { BarItem, BarItemType } from '../api/types';
import { Modal } from './Modal';

const SPIRIT_CATEGORIES = ['Gin', 'Vodka', 'Whiskey', 'Bourbon', 'Scotch', 'Rum', 'Tequila', 'Mezcal', 'Liqueur', 'Brandy & Cognac', 'Amaro', 'Other'];
const WINE_VARIETALS = [
  'Cabernet Sauvignon', 'Pinot Noir', 'Merlot', 'Syrah/Shiraz', 'Malbec', 'Zinfandel', 'Sangiovese', 'Nebbiolo', 'Gamay', 'Grenache',
  'Chardonnay', 'Sauvignon Blanc', 'Riesling', 'Pinot Grigio', 'Champagne/Sparkling', 'Rosé', 'Red Blend', 'White Blend',
];
const BEER_STYLES = ['IPA', 'Pale Ale', 'Lager', 'Pilsner', 'Stout', 'Porter', 'Wheat', 'Sour', 'Belgian', 'Amber', 'Other'];

function categoryOptions(type: BarItemType): string[] {
  if (type === 'spirit') return SPIRIT_CATEGORIES;
  if (type === 'wine') return WINE_VARIETALS;
  return BEER_STYLES;
}

export interface BarItemFormValue {
  type: BarItemType;
  name: string;
  category: string | null;
  producer: string | null;
  vintage: number | null;
  region: string | null;
  quantity: number;
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  notes: string | null;
}

/** Add/edit a Bar item — same fields regardless of type except wine gets
 * vintage/region/drink-window, since those genuinely don't apply to a
 * bottle of gin or a six-pack. Category is a free-text input with a
 * datalist of common values per type (native, no custom autocomplete
 * component needed) rather than a locked dropdown — Mike's own naming for
 * a varietal/style should always be allowed through. */
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
  const [producer, setProducer] = useState(initial?.producer ?? '');
  const [vintage, setVintage] = useState(initial?.vintage != null ? String(initial.vintage) : '');
  const [region, setRegion] = useState(initial?.region ?? '');
  const [quantity, setQuantity] = useState(initial?.quantity != null ? String(initial.quantity) : '1');
  const [drinkStart, setDrinkStart] = useState(initial?.drinkWindowStart != null ? String(initial.drinkWindowStart) : '');
  const [drinkEnd, setDrinkEnd] = useState(initial?.drinkWindowEnd != null ? String(initial.drinkWindowEnd) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const isWine = type === 'wine';
  const datalistId = `bar-category-options-${type}`;

  function save() {
    if (!name.trim()) return;
    onSave({
      type,
      name: name.trim(),
      category: category.trim() || null,
      producer: producer.trim() || null,
      vintage: vintage.trim() ? Number(vintage) : null,
      region: region.trim() || null,
      quantity: quantity.trim() ? Math.max(0, Math.trunc(Number(quantity))) : 1,
      drinkWindowStart: drinkStart.trim() ? Number(drinkStart) : null,
      drinkWindowEnd: drinkEnd.trim() ? Number(drinkEnd) : null,
      notes: notes.trim() || null,
    });
  }

  const typeLabel = type === 'spirit' ? 'Spirit' : type === 'wine' ? 'Wine' : 'Beer';

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : `Add a ${typeLabel}`} onClose={onClose}>
      <label className="wallet-editor__field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isWine ? 'e.g. Produttori del Barbaresco' : 'e.g. Hendrick’s Gin'} />
      </label>

      <label className="wallet-editor__field">
        <span>{isWine ? 'Varietal / blend' : type === 'beer' ? 'Style' : 'Category'}</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} list={datalistId} placeholder="Start typing or pick a suggestion" />
        <datalist id={datalistId}>
          {categoryOptions(type).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>

      <label className="wallet-editor__field">
        <span>{isWine ? 'Producer / winery' : type === 'beer' ? 'Brewery' : 'Distillery'}</span>
        <input value={producer} onChange={(e) => setProducer(e.target.value)} />
      </label>

      {isWine && (
        <>
          <div className="bar-item-modal__row">
            <label className="wallet-editor__field">
              <span>Vintage</span>
              <input type="number" value={vintage} onChange={(e) => setVintage(e.target.value)} placeholder="2021" />
            </label>
            <label className="wallet-editor__field">
              <span>Region</span>
              <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. Piedmont, Italy" />
            </label>
          </div>
          <div className="bar-item-modal__row">
            <label className="wallet-editor__field">
              <span>Drink window — from</span>
              <input type="number" value={drinkStart} onChange={(e) => setDrinkStart(e.target.value)} placeholder="2028" />
            </label>
            <label className="wallet-editor__field">
              <span>Drink window — to</span>
              <input type="number" value={drinkEnd} onChange={(e) => setDrinkEnd(e.target.value)} placeholder="2029" />
            </label>
          </div>
        </>
      )}

      <label className="wallet-editor__field">
        <span>Quantity on hand</span>
        <input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>

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
