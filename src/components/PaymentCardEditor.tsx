import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { VaultFactsTable } from './VaultFactsTable';
import type { PaymentCard, PaymentCardFact, PaymentCardType, RewardsCard } from '../api/types';

const SWATCHES = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 16 }, (_, i) => THIS_YEAR + i);

// The major networks Mike actually carries, plus "Other" so an unusual
// network (a store card, a foreign network) still has somewhere to go —
// picking "Other" reveals a free-text field instead of leaving the
// dropdown unable to represent it.
const NETWORKS = ['Visa', 'Mastercard', 'American Express', 'Discover'];

type FormState = {
  nickname: string;
  cardType: PaymentCardType;
  network: string;
  issuer: string;
  nameOnCard: string;
  expiryMonth: string;
  expiryYear: string;
  billingZip: string;
  notes: string;
  color: string | null;
  coverArtKey: string | null;
  backArtKey: string | null;
};

function toForm(card: PaymentCard | null): FormState {
  return {
    nickname: card?.nickname ?? '',
    cardType: card?.cardType ?? 'credit',
    network: card?.network ?? '',
    issuer: card?.issuer ?? '',
    nameOnCard: card?.nameOnCard ?? '',
    expiryMonth: card?.expiryMonth ? String(card.expiryMonth) : '',
    expiryYear: card?.expiryYear ? String(card.expiryYear) : '',
    billingZip: card?.billingZip ?? '',
    notes: card?.notes ?? '',
    color: card?.color ?? null,
    coverArtKey: card?.coverArtKey ?? null,
    backArtKey: card?.backArtKey ?? null,
  };
}

/** Human error text from client.ts's `request()`, which throws
 * `Error(\`API ${status}: ${body}\`)` — strip that prefix so the field
 * shows the server's actual message (e.g. "PAYMENT_CARD_ENC_KEY is not
 * set…") instead of a generic "try again" that hides what's actually
 * wrong. */
function errorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  return err.message.replace(/^API \d+:\s*/, '') || fallback;
}

// A fact row that only exists locally, before the card itself has been
// saved (see the component comment for why). Its id is a client-side
// placeholder, never sent to the server — handleSave uses `local-` as the
// signal to create it for real once the card has an id to attach to.
let localFactSeq = 0;
function localFact(label: string, value: string, position: number): PaymentCardFact {
  return { id: `local-${++localFactSeq}`, entry_id: 'pending', label, value: value || null, position, created_at: new Date().toISOString() };
}

/** Add/edit modal for a Payment Card. The number and CVV are write-only
 * from here on out — a saved card reports only hasNumber/hasCvv (see
 * PaymentCard's own comment), so this form never shows a real value back;
 * it shows "on file" and lets Mike replace or clear it, same shape as the
 * cover-art upload's "Replace"/"Remove". Flagging a card reward-worthy
 * links it to a Rewards card rather than ever creating a second entry for
 * something Mike already catalogued there.
 *
 * Details (structured facts, same idea as Vault/Wallet) is a child table
 * that normally needs a real card id to attach to — but unlike Wallet/
 * Rewards, there's no reason to make Mike save-and-reopen just to add a
 * field to a card he's still filling out for the first time. So on a
 * brand-new card, facts are staged locally (see localFact above) and only
 * actually created, in order, right after the card itself is — all inside
 * one Save. Editing an existing card, facts already have somewhere to
 * attach to, so they save immediately as they're edited, same as
 * everywhere else in Wallet. */
export function PaymentCardEditor({
  card,
  onClose,
  onSaved,
}: {
  /** null = creating a new card */
  card: PaymentCard | null;
  onClose: () => void;
  onSaved: (card: PaymentCard) => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(card));
  // The network select's own value: one of NETWORKS, or 'Other' when the
  // card's stored network (if any) isn't one of the major ones — in which
  // case the free-text field below stays populated with the real value so
  // nothing is silently dropped by switching to a dropdown.
  const [networkChoice, setNetworkChoice] = useState<string>(() => (card?.network && NETWORKS.includes(card.network) ? card.network : card?.network ? 'Other' : ''));
  const [numberInput, setNumberInput] = useState('');
  const [cvvInput, setCvvInput] = useState('');
  const [clearNumber, setClearNumber] = useState(false);
  const [clearCvv, setClearCvv] = useState(false);
  const [rewardWorthy, setRewardWorthy] = useState(card?.rewardWorthy ?? false);
  const [rewardsChoice, setRewardsChoice] = useState<string>(card?.rewardsCardId ?? 'new');
  const [rewardsCards, setRewardsCards] = useState<RewardsCard[]>([]);
  const [otherPaymentCards, setOtherPaymentCards] = useState<PaymentCard[]>([]);
  const [facts, setFacts] = useState<PaymentCardFact[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingFront, setUploadingFront] = useState(false);
  const [uploadingBack, setUploadingBack] = useState(false);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.listRewardsCards(), api.listPaymentCards()]).then(([rewards, payments]) => {
      setRewardsCards(rewards);
      setOtherPaymentCards(payments.filter((p) => p.id !== card?.id));
    });
    if (card) api.listPaymentCardFacts(card.id).then(setFacts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A Rewards card already linked to a DIFFERENT payment card is off the
  // list — picking it here would silently steal that other card's link.
  // The one currently linked to *this* card (if editing) stays selectable
  // so re-saving without changing the choice doesn't disappear it.
  const linkedElsewhere = new Set(otherPaymentCards.filter((p) => p.rewardsCardId).map((p) => p.rewardsCardId as string));
  const selectableRewardsCards = rewardsCards.filter((rc) => !linkedElsewhere.has(rc.id));

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleImagePick(side: 'front' | 'back', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const setUploading = side === 'front' ? setUploadingFront : setUploadingBack;
    setUploading(true);
    try {
      const res = await api.uploadInline(file);
      set(side === 'front' ? 'coverArtKey' : 'backArtKey', res.r2_key);
    } catch {
      setError("Couldn't upload that image — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    const nickname = form.nickname.trim();
    if (!nickname) {
      setError('Give the card a name.');
      return;
    }
    setSaving(true);
    setError(null);
    // last4 is never typed in directly — it's derived from whatever full
    // number is on file so there's only one place to keep it correct. A
    // freshly typed number wins; clearing the number clears last4 with it;
    // otherwise (editing without touching the number) the existing last4
    // is left as-is by simply not sending the field.
    let last4: string | null | undefined;
    if (numberInput.trim()) last4 = numberInput.replace(/\D/g, '').slice(-4) || null;
    else if (clearNumber) last4 = null;
    else last4 = undefined;

    const payload: Record<string, unknown> = {
      nickname,
      cardType: form.cardType,
      network: (networkChoice === 'Other' ? form.network : networkChoice).trim() || null,
      issuer: form.issuer.trim() || null,
      nameOnCard: form.nameOnCard.trim() || null,
      expiryMonth: form.expiryMonth ? parseInt(form.expiryMonth, 10) : null,
      expiryYear: form.expiryYear ? parseInt(form.expiryYear, 10) : null,
      billingZip: form.billingZip.trim() || null,
      notes: form.notes.trim() || null,
      color: form.color,
      coverArtKey: form.coverArtKey,
      backArtKey: form.backArtKey,
      rewardWorthy,
    };
    if (last4 !== undefined) payload.last4 = last4;
    if (numberInput.trim()) payload.number = numberInput.trim();
    else if (clearNumber) payload.number = null;
    if (cvvInput.trim()) payload.cvv = cvvInput.trim();
    else if (clearCvv) payload.cvv = null;
    if (rewardWorthy && rewardsChoice !== 'new') payload.rewardsCardId = rewardsChoice;

    try {
      const result = card ? await api.updatePaymentCard(card.id, payload) : await api.createPaymentCard(payload);
      // A brand-new card's Details were staged locally (see localFact) —
      // create them for real now that the card has an id, in the order
      // they were added.
      if (!card) {
        for (const f of facts) {
          await api.createPaymentCardFact(result.id, f.label, f.value ?? '');
        }
      }
      onSaved(result);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save — try again."));
    } finally {
      setSaving(false);
    }
  }

  const frontPreview = form.coverArtKey ? api.fileUrl(form.coverArtKey) : null;
  const backPreview = form.backArtKey ? api.fileUrl(form.backArtKey) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide wallet-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 style={{ margin: 0 }}>{card ? 'Edit Card' : 'Add Payment Card'}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="wallet-editor__body">
          <div className="wallet-editor__images-row">
            <div className="wallet-editor__image-slot">
              <div className="wallet-editor__art-preview" style={{ background: frontPreview ? undefined : form.color || '#8A7B5E' }}>
                {frontPreview ? <img src={frontPreview} alt="" /> : <span>{form.nickname.slice(0, 1).toUpperCase() || '💳'}</span>}
              </div>
              <input ref={frontInputRef} type="file" accept="image/*" onChange={(e) => handleImagePick('front', e)} style={{ display: 'none' }} />
              <div className="wallet-editor__image-actions">
                <button type="button" className="btn btn--ghost" onClick={() => frontInputRef.current?.click()} disabled={uploadingFront}>
                  {uploadingFront ? 'Uploading…' : form.coverArtKey ? 'Replace front' : 'Upload front'}
                </button>
                {form.coverArtKey && (
                  <button type="button" className="btn btn--ghost" onClick={() => set('coverArtKey', null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="wallet-editor__image-slot">
              <div className="wallet-editor__art-preview wallet-editor__art-preview--back" style={{ background: backPreview ? undefined : '#e4dcc7' }}>
                {backPreview ? <img src={backPreview} alt="" /> : <span className="wallet-editor__art-preview-empty">Back (optional)</span>}
              </div>
              <input ref={backInputRef} type="file" accept="image/*" onChange={(e) => handleImagePick('back', e)} style={{ display: 'none' }} />
              <div className="wallet-editor__image-actions">
                <button type="button" className="btn btn--ghost" onClick={() => backInputRef.current?.click()} disabled={uploadingBack}>
                  {uploadingBack ? 'Uploading…' : form.backArtKey ? 'Replace back' : 'Upload back'}
                </button>
                {form.backArtKey && (
                  <button type="button" className="btn btn--ghost" onClick={() => set('backArtKey', null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
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

          <label className="wallet-editor__field">
            <span>Nickname</span>
            <input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="e.g. Chase Checking Debit" autoFocus />
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Type</span>
              <select value={form.cardType} onChange={(e) => set('cardType', e.target.value as PaymentCardType)}>
                <option value="credit">Credit</option>
                <option value="debit">Debit</option>
              </select>
            </label>
            <label className="wallet-editor__field">
              <span>Network (optional)</span>
              <select value={networkChoice} onChange={(e) => setNetworkChoice(e.target.value)}>
                <option value="">—</option>
                {NETWORKS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value="Other">Other…</option>
              </select>
            </label>
          </div>

          {networkChoice === 'Other' && (
            <label className="wallet-editor__field">
              <span>Network name</span>
              <input value={form.network} onChange={(e) => set('network', e.target.value)} placeholder="e.g. store card, foreign network…" autoFocus />
            </label>
          )}

          <label className="wallet-editor__field">
            <span>Issuer / bank (optional)</span>
            <input value={form.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="Chase, Amex, your credit union…" />
          </label>

          <label className="wallet-editor__field">
            <span>Name on card (optional)</span>
            <input value={form.nameOnCard} onChange={(e) => set('nameOnCard', e.target.value)} placeholder="As printed on the card" />
          </label>

          <div className="wallet-editor__subsection">
            <div className="wallet-editor__subsection-title">Number & CVV</div>
            <div className="wallet-editor__hint" style={{ marginBottom: 2 }}>
              Encrypted at rest, and never shown again after you save — the detail view reveals it on tap, freshly
              decrypted each time.
            </div>
            <div className="wallet-editor__row">
              <label className="wallet-editor__field">
                <span>Card number{card?.hasNumber ? ' — on file' : ' (optional)'}</span>
                <input
                  value={numberInput}
                  onChange={(e) => {
                    setNumberInput(e.target.value);
                    if (e.target.value) setClearNumber(false);
                  }}
                  placeholder={card?.hasNumber && !clearNumber ? '•••• •••• •••• ••••' : 'Enter the full number'}
                  inputMode="numeric"
                />
                {card?.hasNumber && !clearNumber && !numberInput && (
                  <button type="button" className="wallet-editor__manage-link" onClick={() => setClearNumber(true)}>
                    Remove number on file
                  </button>
                )}
                {clearNumber && <div className="wallet-editor__hint">Will be removed on save.</div>}
                {(() => {
                  // Last 4 is never typed by hand — shown here read-only,
                  // derived from whatever number is being saved (a freshly
                  // typed one, or the one already on file).
                  const shown = numberInput.trim() ? numberInput.replace(/\D/g, '').slice(-4) : clearNumber ? '' : card?.last4;
                  return shown ? <div className="wallet-editor__hint">Shows as last 4: {shown}</div> : null;
                })()}
              </label>
              <label className="wallet-editor__field">
                <span>CVV{card?.hasCvv ? ' — on file' : ' (optional)'}</span>
                <input
                  value={cvvInput}
                  onChange={(e) => {
                    setCvvInput(e.target.value.replace(/\D/g, '').slice(0, 4));
                    if (e.target.value) setClearCvv(false);
                  }}
                  placeholder={card?.hasCvv && !clearCvv ? '•••' : 'Enter CVV'}
                  inputMode="numeric"
                />
                {card?.hasCvv && !clearCvv && !cvvInput && (
                  <button type="button" className="wallet-editor__manage-link" onClick={() => setClearCvv(true)}>
                    Remove CVV on file
                  </button>
                )}
                {clearCvv && <div className="wallet-editor__hint">Will be removed on save.</div>}
              </label>
            </div>
          </div>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Expires (optional)</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={form.expiryMonth} onChange={(e) => set('expiryMonth', e.target.value)}>
                  <option value="">MM</option>
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, '0')}
                    </option>
                  ))}
                </select>
                <select value={form.expiryYear} onChange={(e) => set('expiryYear', e.target.value)}>
                  <option value="">YYYY</option>
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label className="wallet-editor__field">
              <span>Billing ZIP (optional)</span>
              <input value={form.billingZip} onChange={(e) => set('billingZip', e.target.value)} placeholder="10506" />
            </label>
          </div>

          <div className="wallet-editor__subsection">
            <div className="wallet-editor__subsection-title">Rewards</div>
            <label className="wallet-editor__checkbox-field">
              <input type="checkbox" checked={rewardWorthy} onChange={(e) => setRewardWorthy(e.target.checked)} />
              <span>This card earns rewards</span>
            </label>
            {rewardWorthy && (
              <label className="wallet-editor__field">
                <span>Rewards card</span>
                <select value={rewardsChoice} onChange={(e) => setRewardsChoice(e.target.value)}>
                  <option value="new">+ Create a new Rewards card</option>
                  {selectableRewardsCards.map((rc) => (
                    <option key={rc.id} value={rc.id}>
                      {rc.nickname}
                    </option>
                  ))}
                </select>
                <div className="wallet-editor__hint">
                  {rewardsChoice === 'new'
                    ? "A matching card will be added to the Rewards tab so you can set its bonus categories and perks there."
                    : "Linked — bonus categories and perks for this card live on the Rewards tab."}
                </div>
              </label>
            )}
          </div>

          <div className="wallet-editor__subsection">
            <div className="wallet-editor__subsection-title">Details</div>
            <div className="wallet-editor__hint" style={{ marginBottom: 2 }}>
              Anything else worth its own labeled field — member ID #, a phone number to report it lost, whatever
              this particular card needs.
            </div>
            <VaultFactsTable
              facts={facts}
              onAdd={(label, value) => {
                if (card) {
                  api.createPaymentCardFact(card.id, label, value).then((f) => setFacts((prev) => [...prev, f]));
                } else {
                  setFacts((prev) => [...prev, localFact(label, value, prev.length)]);
                }
              }}
              onUpdate={(fact, patch) => {
                if (card) {
                  api.updatePaymentCardFact(fact.id, patch).then((f) => setFacts((prev) => prev.map((x) => (x.id === f.id ? f : x))));
                } else {
                  setFacts((prev) =>
                    prev.map((x) =>
                      x.id === fact.id ? { ...x, label: patch.label ?? x.label, value: patch.value !== undefined ? patch.value || null : x.value } : x
                    )
                  );
                }
              }}
              onDelete={(fact) => {
                if (card) {
                  api.deletePaymentCardFact(fact.id).then(() => setFacts((prev) => prev.filter((x) => x.id !== fact.id)));
                } else {
                  setFacts((prev) => prev.filter((x) => x.id !== fact.id));
                }
              }}
              onReorder={(orderedIds) => {
                const byId = new Map(facts.map((f) => [f.id, f]));
                setFacts(orderedIds.map((id, i) => ({ ...byId.get(id)!, position: i })));
                if (card) api.reorderPaymentCardFacts(card.id, orderedIds);
              }}
            />
          </div>

          <label className="wallet-editor__field">
            <span>Notes (optional)</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Anything else worth remembering about this card." rows={3} />
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
