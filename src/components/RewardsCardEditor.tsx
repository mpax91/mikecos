import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { RewardsBonusKind, RewardsCard } from '../api/types';

const SWATCHES = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

type CoreForm = {
  nickname: string;
  network: string;
  last4: string;
  baseRate: string;
  annualFee: string;
  alwaysCarry: boolean;
  color: string | null;
  coverArtKey: string | null;
  notes: string;
};

function toCoreForm(card: RewardsCard | null): CoreForm {
  return {
    nickname: card?.nickname ?? '',
    network: card?.network ?? '',
    last4: card?.last4 ?? '',
    baseRate: card ? String(card.baseRate) : '1',
    annualFee: card?.annualFee != null ? String(card.annualFee) : '',
    alwaysCarry: card?.alwaysCarry ?? false,
    color: card?.color ?? null,
    coverArtKey: card?.coverArtKey ?? null,
    notes: card?.notes ?? '',
  };
}

/** Add/edit modal for a single Rewards card. Unlike Wallet's card editor,
 * this one also manages the card's bonus categories and perks inline —
 * both need the card to exist first (they're child rows), so those
 * sections only appear once a nickname has been saved at least once. New
 * cards therefore save in two visible steps: the core fields, then the
 * bonus/perk rows — which matches how someone would actually fill this in
 * while reading their card's own terms one section at a time. */
export function RewardsCardEditor({
  card,
  onClose,
  onSaved,
}: {
  /** null = creating a new card */
  card: RewardsCard | null;
  onClose: () => void;
  onSaved: (card: RewardsCard) => void;
}) {
  const [saved, setSaved] = useState<RewardsCard | null>(card);
  const [form, setForm] = useState<CoreForm>(() => toCoreForm(card));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingArt, setUploadingArt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof CoreForm>(key: K, value: CoreForm[K]) {
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

  async function handleSaveCore() {
    const nickname = form.nickname.trim();
    if (!nickname) {
      setError('Give the card a nickname.');
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      nickname,
      network: form.network.trim() || null,
      last4: form.last4.trim() || null,
      baseRate: parseFloat(form.baseRate) || 0,
      annualFee: form.annualFee.trim() ? parseFloat(form.annualFee) : null,
      alwaysCarry: form.alwaysCarry,
      color: form.color,
      coverArtKey: form.coverArtKey,
      notes: form.notes.trim() || null,
    };
    try {
      const result = saved ? await api.updateRewardsCard(saved.id, payload) : await api.createRewardsCard(payload);
      setSaved(result);
      onSaved(result);
    } catch {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  }

  function patchSaved(next: RewardsCard) {
    setSaved(next);
    onSaved(next);
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
              {previewUrl ? <img src={previewUrl} alt="" /> : <span>{form.nickname.slice(0, 1).toUpperCase() || '💳'}</span>}
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
              <div className="wallet-editor__hint">A screenshot of the card's face, cropped tight — same ~8:5 proportions as Wallet's cards.</div>
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
            <span>Nickname</span>
            <input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="e.g. Chase Freedom Unlimited" autoFocus />
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Network (optional)</span>
              <input value={form.network} onChange={(e) => set('network', e.target.value)} placeholder="Visa, Mastercard, Amex…" />
            </label>
            <label className="wallet-editor__field">
              <span>Last 4 (optional)</span>
              <input value={form.last4} onChange={(e) => set('last4', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="1234" />
            </label>
          </div>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Base cashback %</span>
              <input type="number" step="0.1" value={form.baseRate} onChange={(e) => set('baseRate', e.target.value)} placeholder="1" />
            </label>
            <label className="wallet-editor__field">
              <span>Annual fee (optional)</span>
              <input type="number" step="1" value={form.annualFee} onChange={(e) => set('annualFee', e.target.value)} placeholder="0" />
            </label>
          </div>

          <label className="wallet-editor__checkbox-field">
            <input type="checkbox" checked={form.alwaysCarry} onChange={(e) => set('alwaysCarry', e.target.checked)} />
            <span>Always carry this card, regardless of quarter</span>
          </label>

          <label className="wallet-editor__field">
            <span>Notes (optional)</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Sign-up bonus terms, redemption quirks, anything worth remembering." rows={3} />
          </label>

          {error && <div className="wallet-editor__error">{error}</div>}

          <div className="modal__actions" style={{ paddingTop: 0 }}>
            <button type="button" className="btn" onClick={handleSaveCore} disabled={saving}>
              {saving ? 'Saving…' : saved ? 'Save changes' : 'Save & continue'}
            </button>
          </div>

          {saved ? (
            <>
              <BonusesEditor card={saved} onChanged={patchSaved} />
              <PerksEditor card={saved} onChanged={patchSaved} />
            </>
          ) : (
            <div className="wallet-editor__hint">Save the card above to start adding bonus categories and perks.</div>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function BonusesEditor({ card, onChanged }: { card: RewardsCard; onChanged: (card: RewardsCard) => void }) {
  const [category, setCategory] = useState('');
  const [rate, setRate] = useState('');
  const [kind, setKind] = useState<RewardsBonusKind>('fixed');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [saving, setSaving] = useState(false);

  async function addBonus() {
    const cat = category.trim();
    const r = parseFloat(rate);
    if (!cat || !r) return;
    setSaving(true);
    try {
      const bonus = await api.createRewardsBonus(card.id, {
        category: cat,
        rate: r,
        kind,
        startsOn: kind === 'rotating' ? startsOn || null : null,
        endsOn: kind === 'rotating' ? endsOn || null : null,
      });
      onChanged({ ...card, bonuses: [...card.bonuses, bonus] });
      setCategory('');
      setRate('');
      setStartsOn('');
      setEndsOn('');
    } finally {
      setSaving(false);
    }
  }

  async function removeBonus(id: string) {
    await api.deleteRewardsBonus(id);
    onChanged({ ...card, bonuses: card.bonuses.filter((b) => b.id !== id) });
  }

  return (
    <div className="wallet-editor__subsection">
      <div className="wallet-editor__subsection-title">Bonus categories</div>
      {card.bonuses.length > 0 && (
        <ul className="wallet-editor__rows">
          {card.bonuses.map((b) => (
            <li key={b.id} className="wallet-editor__row-item">
              <span className="wallet-editor__row-item-main">
                <strong>{b.rate}%</strong> · {b.category}
                {b.kind === 'rotating' && (
                  <span className="wallet-editor__row-item-tag">
                    rotating{b.startsOn ? ` · ${b.startsOn} – ${b.endsOn ?? '?'}` : ''}
                  </span>
                )}
              </span>
              <button type="button" className="wallet-editor__row-item-remove" onClick={() => removeBonus(b.id)} aria-label="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wallet-editor__add-row">
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category (e.g. Groceries)" style={{ flex: 2 }} />
        <input type="number" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="%" style={{ flex: 1 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value as RewardsBonusKind)} style={{ flex: 1 }}>
          <option value="fixed">Fixed</option>
          <option value="rotating">Rotating</option>
        </select>
        {kind === 'rotating' && (
          <>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} style={{ flex: 1 }} />
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} style={{ flex: 1 }} />
          </>
        )}
        <button type="button" className="btn btn--ghost" onClick={addBonus} disabled={saving || !category.trim() || !rate}>
          Add
        </button>
      </div>
    </div>
  );
}

function PerksEditor({ card, onChanged }: { card: RewardsCard; onChanged: (card: RewardsCard) => void }) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function addPerk() {
    const l = label.trim();
    if (!l) return;
    setSaving(true);
    try {
      const perk = await api.createRewardsPerk(card.id, { label: l, description: description.trim() || null });
      onChanged({ ...card, perks: [...card.perks, perk] });
      setLabel('');
      setDescription('');
    } finally {
      setSaving(false);
    }
  }

  async function removePerk(id: string) {
    await api.deleteRewardsPerk(id);
    onChanged({ ...card, perks: card.perks.filter((p) => p.id !== id) });
  }

  return (
    <div className="wallet-editor__subsection">
      <div className="wallet-editor__subsection-title">Perks & protections</div>
      <div className="wallet-editor__hint">Cell phone protection, rental car coverage, lounge access — whatever this card gives you beyond cashback.</div>
      {card.perks.length > 0 && (
        <ul className="wallet-editor__rows">
          {card.perks.map((p) => (
            <li key={p.id} className="wallet-editor__row-item">
              <span className="wallet-editor__row-item-main">
                <strong>{p.label}</strong>
                {p.description ? ` — ${p.description}` : ''}
              </span>
              <button type="button" className="wallet-editor__row-item-remove" onClick={() => removePerk(p.id)} aria-label="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wallet-editor__add-row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Perk (e.g. Cell phone protection)" style={{ flex: 1 }} />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detail (optional)" style={{ flex: 2 }} />
        <button type="button" className="btn btn--ghost" onClick={addPerk} disabled={saving || !label.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
