import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { VaultFactsTable } from './VaultFactsTable';
import { BANK_KIND_LABEL } from '../utils/bankAccount';
import type { BankAccountKind, BankAccountSuggestion, PaymentCard, PaymentCardFact } from '../api/types';

const SWATCHES = ['#3B5BA9', '#2F6F5E', '#8A5A3B', '#6B4C9A', '#3D7EA6', '#9A4C5F', '#4C6B4C', '#7A5C2E', '#B8632F', '#5C6B8A'];

function errorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  return err.message.replace(/^API \d+:\s*/, '') || fallback;
}

let localFactSeq = 0;
function localFact(label: string, value: string, position: number): PaymentCardFact {
  return { id: `local-${++localFactSeq}`, entry_id: 'pending', label, value: value || null, position, created_at: new Date().toISOString() };
}

const kindFromStatement = (k: string | null): BankAccountKind => (k === 'checking' || k === 'savings' ? k : 'other');

/** Add/edit modal for a Wallet bank account (a payment_cards row with
 * cardType 'bank' — see 0094_bank_accounts.sql). Same security model as a
 * card: the account number is write-only here (encrypted at rest; the
 * detail view reveals it on tap); the routing number is plain (it's printed
 * on every check). A `suggestion` (an account found on a live statement)
 * prefills bank, type, last 4 and owners. */
export function BankAccountEditor({
  account,
  suggestion,
  onClose,
  onSaved,
}: {
  account: PaymentCard | null;
  suggestion?: BankAccountSuggestion | null;
  onClose: () => void;
  onSaved: (card: PaymentCard) => void;
}) {
  const sKind = suggestion ? kindFromStatement(suggestion.kind) : null;
  const [nickname, setNickname] = useState(account?.nickname ?? (suggestion ? `${(suggestion.institution ?? 'Bank').replace(/ Bank$/, '')} ${BANK_KIND_LABEL[sKind!]}` : ''));
  const [bank, setBank] = useState(account?.issuer ?? suggestion?.institution ?? '');
  const [kind, setKind] = useState<BankAccountKind>(account?.accountKind ?? sKind ?? 'checking');
  const [routing, setRouting] = useState(account?.routingNumber ?? '');
  const [wireRouting, setWireRouting] = useState(account?.wireRoutingNumber ?? '');
  const [owners, setOwners] = useState(account?.accountOwners ?? suggestion?.owners ?? '');
  const [numberInput, setNumberInput] = useState('');
  const [clearNumber, setClearNumber] = useState(false);
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [color, setColor] = useState<string | null>(account?.color ?? null);
  const [active, setActive] = useState(account?.active ?? true);
  const [facts, setFacts] = useState<PaymentCardFact[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (account) api.listPaymentCardFacts(account.id).then(setFacts).catch(() => {});
  }, [account]);

  const typedLast4 = numberInput.replace(/\D/g, '').slice(-4);
  const last4Shown = typedLast4 || (clearNumber ? '' : account?.last4 ?? suggestion?.last4 ?? '');
  const routingDigits = routing.replace(/\D/g, '');
  const routingWarn = routingDigits && routingDigits.length !== 9 ? 'Routing numbers are 9 digits.' : null;
  const mismatch = suggestion && typedLast4 && typedLast4 !== suggestion.last4 ? `That number ends in ${typedLast4}, but the statement account ends in ${suggestion.last4}.` : null;

  async function handleSave() {
    const name = nickname.trim();
    if (!name) {
      setError('Give the account a name.');
      return;
    }
    setSaving(true);
    setError(null);
    const payload: Record<string, unknown> = {
      nickname: name,
      cardType: 'bank',
      issuer: bank.trim() || null,
      accountKind: kind,
      routingNumber: routing.trim() || null,
      wireRoutingNumber: wireRouting.trim() || null,
      accountOwners: owners.trim() || null,
      notes: notes.trim() || null,
      color,
    };
    if (account) payload.active = active;
    if (numberInput.trim()) {
      payload.number = numberInput.replace(/\s+/g, '').trim();
      payload.last4 = typedLast4 || null;
    } else if (clearNumber) {
      payload.number = null;
      payload.last4 = null;
    } else if (!account && suggestion) {
      payload.last4 = suggestion.last4; // links the balance even before the full number is entered
    }
    try {
      const result = account ? await api.updatePaymentCard(account.id, payload) : await api.createPaymentCard(payload);
      if (!account) for (const f of facts) await api.createPaymentCardFact(result.id, f.label, f.value ?? '');
      onSaved(result);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save — try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide wallet-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 style={{ margin: 0 }}>{account ? 'Edit Bank Account' : 'Add Bank Account'}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="wallet-editor__body">
          {suggestion && !account && (
            <div className="wallet-editor__hint bank-editor__from">
              From your {suggestion.folderNickname} statements: {BANK_KIND_LABEL[kindFromStatement(suggestion.kind)]} ••{suggestion.last4}
              {suggestion.product ? ` (${suggestion.product})` : ''}. Add the full account and routing numbers below.
            </div>
          )}

          <label className="wallet-editor__field">
            <span>Nickname</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Ally Checking" autoFocus />
          </label>

          <div className="wallet-editor__row">
            <label className="wallet-editor__field">
              <span>Bank</span>
              <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Ally Bank, Chase, your credit union…" />
            </label>
            <label className="wallet-editor__field">
              <span>Account Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as BankAccountKind)}>
                {(Object.keys(BANK_KIND_LABEL) as BankAccountKind[]).map((k) => (
                  <option key={k} value={k}>
                    {BANK_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="wallet-editor__subsection">
            <div className="wallet-editor__subsection-title">Account & Routing Numbers</div>
            <div className="wallet-editor__hint" style={{ marginBottom: 2 }}>
              The account number is encrypted at rest and never shown again after you save — the detail view reveals it on tap.
            </div>
            <label className="wallet-editor__field">
              <span>Account Number{account?.hasNumber ? ' — on file' : ''}</span>
              <input
                value={numberInput}
                onChange={(e) => {
                  setNumberInput(e.target.value);
                  if (e.target.value) setClearNumber(false);
                }}
                placeholder={account?.hasNumber && !clearNumber ? '•••••••••' : 'Full account number'}
                inputMode="numeric"
                autoComplete="off"
              />
              {account?.hasNumber && !clearNumber && !numberInput && (
                <button type="button" className="wallet-editor__manage-link" onClick={() => setClearNumber(true)}>
                  Remove number on file
                </button>
              )}
              {clearNumber && <div className="wallet-editor__hint">Will be removed on save.</div>}
              {last4Shown && <div className="wallet-editor__hint">Shows as last 4: {last4Shown}</div>}
              {mismatch && <div className="wallet-editor__error">{mismatch}</div>}
            </label>
            <div className="wallet-editor__row">
              <label className="wallet-editor__field">
                <span>Routing Number (ACH)</span>
                <input value={routing} onChange={(e) => setRouting(e.target.value)} placeholder="9 digits" inputMode="numeric" autoComplete="off" />
                {routingWarn && <div className="wallet-editor__hint">{routingWarn}</div>}
              </label>
              <label className="wallet-editor__field">
                <span>Wire Routing (if different)</span>
                <input value={wireRouting} onChange={(e) => setWireRouting(e.target.value)} placeholder="Optional" inputMode="numeric" autoComplete="off" />
              </label>
            </div>
          </div>

          <label className="wallet-editor__field">
            <span>Owners (optional)</span>
            <input value={owners} onChange={(e) => setOwners(e.target.value)} placeholder="e.g. Michael & Cornelia (Joint)" />
          </label>

          <div className="wallet-editor__swatches">
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                type="button"
                className={`wallet-editor__swatch${color === sw ? ' is-selected' : ''}`}
                style={{ background: sw }}
                onClick={() => setColor(color === sw ? null : sw)}
                aria-label={`Use ${sw} as the tile color`}
              />
            ))}
          </div>

          {account && (
            <label className="wallet-editor__checkbox-field">
              <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
              <span>Account is closed (keeps it for history; anything it pays gets flagged)</span>
            </label>
          )}

          <div className="wallet-editor__subsection">
            <div className="wallet-editor__subsection-title">Details</div>
            <div className="wallet-editor__hint" style={{ marginBottom: 2 }}>
              Anything else worth a labeled field — SWIFT code, branch phone, online banking username.
            </div>
            <VaultFactsTable
              facts={facts}
              onAdd={(label, value) => {
                if (account) api.createPaymentCardFact(account.id, label, value).then((f) => setFacts((prev) => [...prev, f]));
                else setFacts((prev) => [...prev, localFact(label, value, prev.length)]);
              }}
              onUpdate={(fact, patch) => {
                if (account) api.updatePaymentCardFact(fact.id, patch).then((f) => setFacts((prev) => prev.map((x) => (x.id === f.id ? f : x))));
                else
                  setFacts((prev) =>
                    prev.map((x) => (x.id === fact.id ? { ...x, label: patch.label ?? x.label, value: patch.value !== undefined ? patch.value || null : x.value } : x))
                  );
              }}
              onDelete={(fact) => {
                if (account) api.deletePaymentCardFact(fact.id).then(() => setFacts((prev) => prev.filter((x) => x.id !== fact.id)));
                else setFacts((prev) => prev.filter((x) => x.id !== fact.id));
              }}
              onReorder={(orderedIds) => {
                const byId = new Map(facts.map((f) => [f.id, f]));
                setFacts(orderedIds.map((id, i) => ({ ...byId.get(id)!, position: i })));
                if (account) api.reorderPaymentCardFacts(account.id, orderedIds);
              }}
            />
          </div>

          <label className="wallet-editor__field">
            <span>Notes (optional)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Anything else worth remembering about this account." />
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
