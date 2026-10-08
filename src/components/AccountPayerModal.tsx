import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { AccountPayer, AccountPayerMode, Entity, PaymentCard } from '../api/types';
import { Modal } from './Modal';

const OTHER = '__other__';
const cardLabel = (c: PaymentCard) => `${c.nickname}${c.last4 ? ` ••${c.last4}` : ''}`;

/** Sets which card pays an account (worker/src/accountPayersRouter.ts).
 * Opened from either side:
 *  - a Vault entry (entryId fixed) → pick the card, or type a non-card
 *    payer like "Chase Checking ••1234";
 *  - a Wallet payment card's Pays For (cardId fixed) → pick the account. */
export function AccountPayerModal({
  entryId: fixedEntryId,
  cardId: fixedCardId,
  onClose,
  onSaved,
}: {
  entryId?: string;
  cardId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cards, setCards] = useState<PaymentCard[]>([]);
  const [entries, setEntries] = useState<Entity[]>([]);
  const [entryId, setEntryId] = useState(fixedEntryId ?? '');
  const [existing, setExisting] = useState<AccountPayer | null>(null);
  const [cardChoice, setCardChoice] = useState(fixedCardId ?? '');
  const [payerText, setPayerText] = useState('');
  const [mode, setMode] = useState<AccountPayerMode>('autopay');
  const [dueDay, setDueDay] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPaymentCards().then(setCards).catch(() => {});
    if (!fixedEntryId) api.listVaultEntries().then(setEntries).catch(() => {});
  }, [fixedEntryId]);

  // Load the account's current payer whenever the account changes.
  useEffect(() => {
    if (!entryId) {
      setExisting(null);
      return;
    }
    api
      .getAccountPayer(entryId)
      .then((p) => {
        setExisting(p);
        if (!p) return;
        if (fixedEntryId) {
          setCardChoice(p.paymentCardId ?? OTHER);
          setPayerText(p.payerText ?? '');
        }
        setMode(p.mode);
        setDueDay(p.dueDay ? String(p.dueDay) : '');
      })
      .catch(() => setExisting(null));
  }, [entryId, fixedEntryId]);

  const activeCards = useMemo(() => cards.filter((c) => c.active || c.id === cardChoice), [cards, cardChoice]);
  const sortedEntries = useMemo(() => [...entries].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '')), [entries]);
  const replacing = fixedCardId && existing && existing.paymentCardId !== fixedCardId ? existing.label : null;

  const isOther = cardChoice === OTHER;
  const canSave = !!entryId && (isOther ? !!payerText.trim() : !!cardChoice) && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.setAccountPayer(entryId, {
        mode,
        paymentCardId: isOther ? null : cardChoice,
        payerText: isOther ? payerText.trim() : null,
        dueDay: dueDay ? Number(dueDay) : null,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await api.removeAccountPayer(entryId);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={fixedCardId ? 'Add Account' : 'Payment Method'} onClose={onClose}>
      <div className="account-payer">
        {!fixedEntryId && (
          <label className="account-payer__field">
            <span>Account</span>
            <select value={entryId} onChange={(e) => setEntryId(e.target.value)} autoFocus>
              <option value="">Choose a Vault Entry…</option>
              {sortedEntries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title || 'Untitled Entry'}
                </option>
              ))}
            </select>
          </label>
        )}
        {replacing && <div className="account-payer__hint">Currently paid with {replacing} — saving moves it to this card.</div>}

        {!fixedCardId && (
          <label className="account-payer__field">
            <span>Paid With</span>
            <select value={cardChoice} onChange={(e) => setCardChoice(e.target.value)}>
              <option value="">Choose a Card or Account…</option>
              {[
                { label: 'Cards', rows: activeCards.filter((c) => c.cardType !== 'bank') },
                { label: 'Bank Accounts', rows: activeCards.filter((c) => c.cardType === 'bank') },
              ]
                .filter((g) => g.rows.length)
                .map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.rows.map((c) => (
                      <option key={c.id} value={c.id}>
                        {cardLabel(c)}
                        {c.active ? '' : c.cardType === 'bank' ? ' (Closed)' : ' (Inactive)'}
                      </option>
                    ))}
                  </optgroup>
                ))}
              <option value={OTHER}>Other…</option>
            </select>
          </label>
        )}
        {isOther && <input placeholder="e.g. Venmo, cash, someone else" value={payerText} onChange={(e) => setPayerText(e.target.value)} autoFocus />}

        <div className="account-payer__field">
          <span>How</span>
          <div className="account-payer__seg" role="radiogroup">
            <button type="button" role="radio" aria-checked={mode === 'autopay'} className={mode === 'autopay' ? 'is-on' : ''} onClick={() => setMode('autopay')}>
              Auto-Pay
            </button>
            <button type="button" role="radio" aria-checked={mode === 'on_file'} className={mode === 'on_file' ? 'is-on' : ''} onClick={() => setMode('on_file')}>
              On File
            </button>
          </div>
        </div>
        <div className="account-payer__hint">
          {mode === 'autopay' ? 'Pays automatically each bill.' : 'Saved with them — you click Pay.'}
        </div>

        <label className="account-payer__field">
          <span>Due Day</span>
          <input type="number" min={1} max={31} inputMode="numeric" placeholder="Optional (1–31)" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
        </label>
        <div className="account-payer__hint">Statements fill in the exact due date when a bill shows one.</div>

        {error && <div className="wallet-editor__error">{error}</div>}
      </div>
      <div className="modal__actions">
        {existing && !replacing && (
          <button className="btn btn--ghost account-payer__remove" onClick={remove} disabled={saving}>
            Remove
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
