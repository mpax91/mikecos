import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { WalletBarcodeType, WalletCard, WalletCategory } from '../api/types';

// Used only if Settings' category list (0046_wallet_categories.sql) hasn't
// loaded yet — the field is always free text regardless (see that
// migration's comment) so a one-off card is never blocked either way.
const FALLBACK_CATEGORIES = ['Retail', 'Other'];

// Mike doesn't (and shouldn't have to) know Code128 from UPC-A from EAN-13
// to add a card — those are rendering details, not a decision he should be
// asked to make. He picks one of these three; detectBarcodeFormat below
// works out the actual symbology from the digits he types.
type CodeKind = 'barcode' | 'qr' | 'none';
const CODE_KINDS: { value: CodeKind; label: string; hint: string }[] = [
  { value: 'barcode', label: 'Barcode', hint: 'The classic striped lines. We’ll figure out the exact format from the number itself — just paste or type it in.' },
  { value: 'qr', label: 'QR code', hint: 'The square pixel-grid code, not the striped bars.' },
  { value: 'none', label: 'No scannable code', hint: 'The card is only ever checked by number or by hand.' },
];

function codeKindOf(barcodeType: WalletBarcodeType): CodeKind {
  if (barcodeType === 'qr') return 'qr';
  if (barcodeType === 'none') return 'none';
  return 'barcode';
}

// UPC-A is always exactly 12 digits, EAN-13 always exactly 13 — no letters,
// no separators — so counting digits after stripping spaces/dashes is a
// reliable, silent way to pick between them. Anything else (letters, a
// different length, dashes that don't strip to a clean 12/13) falls back to
// Code128, which is the most permissive format and handles almost every
// membership/loyalty number in practice.
function detectBarcodeFormat(value: string): WalletBarcodeType {
  const digitsOnly = value.replace(/[\s-]/g, '');
  if (/^\d{12}$/.test(digitsOnly)) return 'upc';
  if (/^\d{13}$/.test(digitsOnly)) return 'ean13';
  return 'code128';
}

const SWATCHES = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

type FormState = {
  name: string;
  category: string;
  codeKind: CodeKind;
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
    codeKind: codeKindOf(card?.barcodeType ?? 'code128'),
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
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() => toForm(card));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingArt, setUploadingArt] = useState(false);
  const [categories, setCategories] = useState<WalletCategory[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listWalletCategories().then(setCategories).catch(() => {});
  }, []);

  const categoryNames = categories.length ? categories.map((c) => c.name) : FALLBACK_CATEGORIES;

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
    const trimmedValue = form.barcodeValue.trim();
    const barcodeType: WalletBarcodeType =
      form.codeKind === 'qr' ? 'qr' : form.codeKind === 'none' ? 'none' : trimmedValue ? detectBarcodeFormat(trimmedValue) : 'code128';
    const payload = {
      name,
      category: form.category.trim() || 'Other',
      barcodeType,
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
              <div className="wallet-editor__hint">
                Works best as a photo or screenshot of the actual card's face, cropped to just the card — standard
                card proportions (about 241×152px or any size in that ~8:5 ratio). It fills the tile edge-to-edge, so
                crop tight; the name is shown separately below the art, not on top of it.
              </div>
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
            {/* A native <select> rather than a text input + datalist — the
                datalist combo silently refused to show its suggestion
                dropdown when the field already held a value that matched
                an option exactly (e.g. an existing "Retail"), so clicking
                it appeared to do nothing until the text was deleted first.
                A <select> has no such ambiguity: clicking it always opens
                the full list. "Custom…" is the escape hatch back to free
                text, since the field itself is never meant to be a fence
                (see 0046_wallet_categories.sql). */}
            <select
              value={categoryNames.includes(form.category) ? form.category : '__custom__'}
              onChange={(e) => set('category', e.target.value === '__custom__' ? '' : e.target.value)}
            >
              {categoryNames.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {!categoryNames.includes(form.category) && (
              <input
                value={form.category}
                onChange={(e) => set('category', e.target.value)}
                placeholder="Type a category"
                autoFocus
                style={{ marginTop: 6 }}
              />
            )}
            <button
              type="button"
              className="wallet-editor__manage-link"
              onClick={() => {
                onClose();
                navigate('/settings?cat=wallet');
              }}
            >
              Manage categories in Settings
            </button>
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Code type</span>
              <select value={form.codeKind} onChange={(e) => set('codeKind', e.target.value as CodeKind)}>
                {CODE_KINDS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {form.codeKind !== 'none' && (
              <label className="wallet-editor__field">
                <span>Code value</span>
                <input value={form.barcodeValue} onChange={(e) => set('barcodeValue', e.target.value)} placeholder="What the scanner reads" />
              </label>
            )}
          </div>
          <div className="wallet-editor__hint">{CODE_KINDS.find((t) => t.value === form.codeKind)?.hint}</div>

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
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder={'What this covers, restrictions, renewal date — as much as you need.\nMost cards won’t need this; shown collapsed when opened.'}
              rows={4}
            />
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
