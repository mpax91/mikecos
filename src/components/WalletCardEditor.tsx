import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { WalletBarcodeType, WalletCard } from '../api/types';

// Starting point, not a fence — the category field stays free text on the
// backend (see 0045_wallet.sql) specifically so a federal recreation pass
// or a one-off local shop card is never blocked by a missing preset.
const CATEGORY_PRESETS = ['Retail', 'Grocery', 'Pharmacy', 'Gym & Fitness', 'Parks & Recreation', 'Membership', 'Gift Card', 'Local Shop', 'Other'];

const BARCODE_TYPES: { value: WalletBarcodeType; label: string }[] = [
  { value: 'code128', label: 'Barcode (Code 128)' },
  { value: 'upc', label: 'Barcode (UPC-A)' },
  { value: 'ean13', label: 'Barcode (EAN-13)' },
  { value: 'qr', label: 'QR code' },
  { value: 'none', label: 'No scannable code' },
];

const SWATCHES = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

type FormState = {
  name: string;
  category: string;
  barcodeType: WalletBarcodeType;
  barcodeValue: string;
  displayNumber: string;
  pinCode: string;
  balance: string;
  notes: string;
  color: string | null;
  coverArtKey: string | null;
};

function toForm(card: WalletCard | null): FormState {
  return {
    name: card?.name ?? '',
    category: card?.category ?? 'Retail',
    barcodeType: card?.barcodeType ?? 'code128',
    barcodeValue: card?.barcodeValue ?? '',
    displayNumber: card?.displayNumber ?? '',
    pinCode: card?.pinCode ?? '',
    balance: card?.balance ?? '',
    notes: card?.notes ?? '',
    color: card?.color ?? null,
    coverArtKey: card?.coverArtKey ?? null,
  };
}

/** Add/edit modal for a single Wallet card. One flat form — no wizard, no
 * required fields beyond a name — because the fastest way to kill "just
 * type your 15 cards in" is to make each one take a minute. */
export function WalletCardEditor({
  card,
  onClose,
  onSaved,
}: {
  /** null = creating a new card */
  card: WalletCard | null;
  onClose: () => void;
  onSaved: (card: WalletCard) => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(card));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingArt, setUploadingArt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleCoverArtPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingArt(true);
    try {
      const res = await api.uploadInline(file);
      set('coverArtKey', res.r2_key);
    } catch {
      setError("Couldn't upload that image — try again.");
    } finally {
      setUploadingArt(false);
    }
  }

  async function handleSave() {
    const name = form.name.trim();
    if (!name) {
      setError('Give the card a name.');
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      name,
      category: form.category.trim() || 'Other',
      barcodeType: form.barcodeType,
      barcodeValue: form.barcodeValue.trim() || null,
      displayNumber: form.displayNumber.trim() || null,
      pinCode: form.pinCode.trim() || null,
      balance: form.balance.trim() || null,
      notes: form.notes.trim() || null,
      color: form.color,
      coverArtKey: form.coverArtKey,
    };
    try {
      const saved = card ? await api.updateWalletCard(card.id, payload) : await api.createWalletCard(payload);
      onSaved(saved);
    } catch {
      setError("Couldn't save — try again.");
      setSaving(false);
    }
  }

  const previewUrl = form.coverArtKey ? api.fileUrl(form.coverArtKey) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide wallet-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 style={{ margin: 0 }}>{card ? 'Edit Card' : 'Add Card'}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="wallet-editor__body">
          <div className="wallet-editor__art-row">
            <div className="wallet-editor__art-preview" style={{ background: previewUrl ? undefined : form.color || '#8A7B5E' }}>
              {previewUrl ? <img src={previewUrl} alt="" /> : <span>{form.name.slice(0, 1).toUpperCase() || '🎫'}</span>}
            </div>
            <div className="wallet-editor__art-controls">
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverArtPick} style={{ display: 'none' }} />
              <button type="button" className="btn btn--ghost" onClick={() => fileInputRef.current?.click()} disabled={uploadingArt}>
                {uploadingArt ? 'Uploading…' : form.coverArtKey ? 'Replace cover art' : 'Upload cover art'}
              </button>
              {form.coverArtKey && (
                <button type="button" className="btn btn--ghost" onClick={() => set('coverArtKey', null)}>
                  Remove
                </button>
              )}
              <div className="wallet-editor__swatches">
                {SWATCHES.map((sw) => (
                  <button
                    key={sw}
                    type="button"
                    className={`wallet-editor__swatch${form.color === sw ? ' is-selected' : ''}`}
                    style={{ background: sw }}
                    onClick={() => set('color', form.color === sw ? null : sw)}
                    aria-label={`Use ${sw} as the fallback tile color`}
                  />
                ))}
              </div>
            </div>
          </div>

          <label className="wallet-editor__field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Whole Foods, America the Beautiful Pass" autoFocus />
          </label>

          <label className="wallet-editor__field">
            <span>Category</span>
            <input value={form.category} onChange={(e) => set('category', e.target.value)} list="wallet-category-presets" placeholder="Retail, Grocery, Parks & Recreation…" />
            <datalist id="wallet-category-presets">
              {CATEGORY_PRESETS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Code type</span>
              <select value={form.barcodeType} onChange={(e) => set('barcodeType', e.target.value as WalletBarcodeType)}>
                {BARCODE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {form.barcodeType !== 'none' && (
              <label className="wallet-editor__field">
                <span>Code value</span>
                <input value={form.barcodeValue} onChange={(e) => set('barcodeValue', e.target.value)} placeholder="What the scanner reads" />
              </label>
            )}
          </div>

          <label className="wallet-editor__field">
            <span>Display number (optional)</span>
            <input
              value={form.displayNumber}
              onChange={(e) => set('displayNumber', e.target.value)}
              placeholder="Only if it differs from the code value above"
            />
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>PIN (optional)</span>
              <input value={form.pinCode} onChange={(e) => set('pinCode', e.target.value)} placeholder="Gift card PIN" />
            </label>
            <label className="wallet-editor__field">
              <span>Balance (optional)</span>
              <input value={form.balance} onChange={(e) => set('balance', e.target.value)} placeholder="e.g. $42.50" />
            </label>
          </div>

          <label className="wallet-editor__field">
            <span>Notes (optional)</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Expiration, terms, anything worth remembering" />
          </label>

          {error && <div className="wallet-editor__error">{error}</div>}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
