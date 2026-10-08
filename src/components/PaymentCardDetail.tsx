import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { CardPaidAccount, PaymentCard, PaymentCardFact } from '../api/types';
import { AccountPayerModal } from './AccountPayerModal';
import { CardImageLightbox } from './CardImageLightbox';
import { isPhoneLabel, telHref } from '../utils/phone';
import { BANK_KIND_LABEL } from '../utils/bankAccount';

/** View modal for a single Payment Card. The number and CVV are never
 * fetched until Mike explicitly taps "Reveal" — GET /cards/:id/reveal is
 * the only call in the app that ever returns them decrypted, and even
 * then only into this component's own state, never logged or cached
 * beyond this view being open. Details (structured facts) renders the
 * same collapsible way WalletBarcodeView already does. */
export function PaymentCardDetail({ card, onClose, onEdit }: { card: PaymentCard; onClose: () => void; onEdit: () => void }) {
  const [revealed, setRevealed] = useState<{ number: string | null; cvv: string | null; pin: string | null } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<'number' | 'cvv' | 'pin' | 'routing' | 'wire' | null>(null);
  const isBank = card.cardType === 'bank';
  const [lightboxSide, setLightboxSide] = useState<'front' | 'back' | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [facts, setFacts] = useState<PaymentCardFact[]>([]);
  const [copiedFactId, setCopiedFactId] = useState<string | null>(null);

  const [paysOpen, setPaysOpen] = useState(false);
  const [paidAccounts, setPaidAccounts] = useState<CardPaidAccount[]>([]);
  const [payerModal, setPayerModal] = useState<{ entryId?: string } | null>(null);

  useEffect(() => {
    api.listPaymentCardFacts(card.id).then(setFacts).catch(() => {});
  }, [card.id]);

  const loadPaidAccounts = useCallback(() => {
    api.listCardPaidAccounts(card.id).then(setPaidAccounts).catch(() => {});
  }, [card.id]);
  useEffect(loadPaidAccounts, [loadPaidAccounts]);

  const autoPays = paidAccounts.filter((a) => a.mode === 'autopay');
  const onFile = paidAccounts.filter((a) => a.mode === 'on_file');

  function copyFact(fact: PaymentCardFact) {
    if (!fact.value) return;
    navigator.clipboard.writeText(fact.value).then(() => {
      setCopiedFactId(fact.id);
      setTimeout(() => setCopiedFactId((id) => (id === fact.id ? null : id)), 1300);
    });
  }

  async function reveal() {
    if (revealed) {
      setShown((v) => !v);
      return;
    }
    setRevealing(true);
    setRevealError(null);
    try {
      const secrets = await api.revealPaymentCard(card.id);
      setRevealed(secrets);
      setShown(true);
    } catch {
      setRevealError("Couldn't decrypt — try again.");
    } finally {
      setRevealing(false);
    }
  }

  function copy(field: 'number' | 'cvv' | 'pin' | 'routing' | 'wire', value: string | null) {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(field);
      setTimeout(() => setCopied((c) => (c === field ? null : c)), 1300);
    });
  }

  const expiry = card.expiryMonth && card.expiryYear ? `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}` : null;

  return (
    <div className="wallet-barcode-view" onClick={onClose}>
      <div className="wallet-barcode-view__card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wallet-barcode-view__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="wallet-barcode-view__header">
          {card.coverArtUrl && (
            <button type="button" className="wallet-barcode-view__logo-btn" onClick={() => setLightboxSide('front')} aria-label="View card image larger">
              <img src={card.coverArtUrl} alt="" className="wallet-barcode-view__logo" />
            </button>
          )}
          <div className="wallet-barcode-view__name">{card.nickname}</div>
          <div className="wallet-barcode-view__category">
            {(isBank
              ? [card.accountKind ? BANK_KIND_LABEL[card.accountKind] : 'Bank Account', card.issuer, card.active ? null : 'Closed']
              : [card.cardType === 'debit' ? 'Debit' : 'Credit', card.network, card.issuer]
            )
              .filter(Boolean)
              .join(' · ')}
            {card.rewardWorthy ? ' · ★ Earns rewards' : ''}
          </div>
        </div>

        {isBank && card.statementAccount && (
          <div className="bank-detail__balance">
            <div>
              <span className="bank-detail__balance-label">Balance</span>
              <span className="bank-detail__balance-value">
                ${card.statementAccount.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="bank-detail__balance-sub">
                As of the {new Date(`${card.statementAccount.asOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} statement
                {card.statementAccount.apy !== null ? ` · ${card.statementAccount.apy.toFixed(2)}% APY earned` : ''}
              </span>
            </div>
            <Link to={`/finance/${card.statementAccount.folderId}`} className="btn btn--ghost btn--sm" onClick={onClose}>
              Dashboard
            </Link>
          </div>
        )}

        {isBank && (
          <div className="payment-detail__secure bank-detail__secure">
            <div className="payment-detail__secure-row">
              <span>Account number</span>
              <span className="payment-detail__secure-value">{shown && revealed?.number ? revealed.number : card.last4 ? `••••••${card.last4}` : card.hasNumber ? '•••••••••' : '—'}</span>
            </div>
            <div className="payment-detail__secure-row">
              <span>Routing number</span>
              <span className="payment-detail__secure-value">
                {card.routingNumber ?? '—'}
                {card.routingNumber && (
                  <button type="button" className="wallet-barcode-view__details-copy" onClick={() => copy('routing', card.routingNumber)} aria-label="Copy routing number">
                    {copied === 'routing' ? '✓' : '⧉'}
                  </button>
                )}
              </span>
            </div>
            {card.wireRoutingNumber && (
              <div className="payment-detail__secure-row">
                <span>Wire routing</span>
                <span className="payment-detail__secure-value">
                  {card.wireRoutingNumber}
                  <button type="button" className="wallet-barcode-view__details-copy" onClick={() => copy('wire', card.wireRoutingNumber)} aria-label="Copy wire routing number">
                    {copied === 'wire' ? '✓' : '⧉'}
                  </button>
                </span>
              </div>
            )}
            {card.accountOwners && (
              <div className="payment-detail__secure-row">
                <span>Owners</span>
                <span className="payment-detail__secure-value bank-detail__owners">{card.accountOwners}</span>
              </div>
            )}
            <div className="payment-detail__secure-actions">
              {card.hasNumber && (
                <button type="button" className="wallet-barcode-view__reveal" onClick={reveal} disabled={revealing}>
                  {revealing ? 'Decrypting…' : shown ? 'Hide' : 'Reveal'}
                </button>
              )}
              {shown && revealed?.number && (
                <button type="button" className="wallet-barcode-view__copy" onClick={() => copy('number', revealed.number)}>
                  {copied === 'number' ? 'Copied ✓' : 'Copy account number'}
                </button>
              )}
            </div>
            {revealError && <div className="wallet-editor__error">{revealError}</div>}
          </div>
        )}

        {!isBank && (card.hasNumber || card.hasCvv || card.hasPin || card.last4) && (
          <div className="payment-detail__secure">
            <div className="payment-detail__secure-row">
              <span>Card number</span>
              <span className="payment-detail__secure-value">
                {shown && revealed?.number ? revealed.number : card.last4 ? `•••• •••• •••• ${card.last4}` : card.hasNumber ? '•••• •••• •••• ••••' : '—'}
              </span>
            </div>
            <div className="payment-detail__secure-row">
              <span>CVV</span>
              <span className="payment-detail__secure-value">{shown && revealed?.cvv ? revealed.cvv : card.hasCvv ? '•••' : '—'}</span>
            </div>
            {card.hasPin && (
              <div className="payment-detail__secure-row">
                <span>PIN</span>
                <span className="payment-detail__secure-value">{shown && revealed?.pin ? revealed.pin : '••••'}</span>
              </div>
            )}
            {expiry && (
              <div className="payment-detail__secure-row">
                <span>Expires</span>
                <span className="payment-detail__secure-value">{expiry}</span>
              </div>
            )}
            <div className="payment-detail__secure-actions">
              {(card.hasNumber || card.hasCvv || card.hasPin) && (
                <button type="button" className="wallet-barcode-view__reveal" onClick={reveal} disabled={revealing}>
                  {revealing ? 'Decrypting…' : shown ? 'Hide' : 'Reveal'}
                </button>
              )}
              {shown && revealed?.number && (
                <button type="button" className="wallet-barcode-view__copy" onClick={() => copy('number', revealed.number)}>
                  {copied === 'number' ? 'Copied ✓' : 'Copy number'}
                </button>
              )}
              {shown && revealed?.cvv && (
                <button type="button" className="wallet-barcode-view__copy" onClick={() => copy('cvv', revealed.cvv)}>
                  {copied === 'cvv' ? 'Copied ✓' : 'Copy CVV'}
                </button>
              )}
              {shown && revealed?.pin && (
                <button type="button" className="wallet-barcode-view__copy" onClick={() => copy('pin', revealed.pin)}>
                  {copied === 'pin' ? 'Copied ✓' : 'Copy PIN'}
                </button>
              )}
            </div>
            {revealError && <div className="wallet-editor__error">{revealError}</div>}
          </div>
        )}

        {(card.nameOnCard || card.billingZip) && (
          <div className="wallet-barcode-view__extra">
            {card.nameOnCard && (
              <div className="wallet-barcode-view__extra-row">
                <span>Name on card</span>
                <span>{card.nameOnCard}</span>
              </div>
            )}
            {card.billingZip && (
              <div className="wallet-barcode-view__extra-row">
                <span>Billing ZIP</span>
                <span>{card.billingZip}</span>
              </div>
            )}
          </div>
        )}

        {facts.length > 0 && (
          <div className="wallet-barcode-view__details">
            <button type="button" className="wallet-barcode-view__details-toggle" onClick={() => setDetailsOpen((v) => !v)}>
              {detailsOpen ? '▾' : '▸'} Details
            </button>
            {detailsOpen && (
              <div className="wallet-barcode-view__details-rows">
                {facts.map((f) => {
                  const tel = f.value && isPhoneLabel(f.label) ? telHref(f.value) : null;
                  return (
                    <div key={f.id} className="wallet-barcode-view__details-row">
                      <span>{f.label}</span>
                      <span>
                        {tel ? (
                          <a href={tel} className="wallet-barcode-view__details-tel">
                            {f.value}
                          </a>
                        ) : (
                          f.value || '—'
                        )}
                        {f.value && (
                          <button type="button" className="wallet-barcode-view__details-copy" onClick={() => copyFact(f)} aria-label={`Copy ${f.label}`}>
                            {copiedFactId === f.id ? '✓' : '⧉'}
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="wallet-barcode-view__details pays-for">
          <button type="button" className="wallet-barcode-view__details-toggle" onClick={() => setPaysOpen((v) => !v)}>
            {paysOpen ? '▾' : '▸'} Pays For{paidAccounts.length ? ` (${paidAccounts.length})` : ''}
          </button>
          {paysOpen && (
            <div className="pays-for__body">
              {paidAccounts.length === 0 && (
                <div className="pays-for__empty">
                  {isBank
                    ? 'No accounts linked yet — add the bills and cards paid from this account.'
                    : 'No accounts linked yet — add the ones that charge this card or keep it on file.'}
                </div>
              )}
              {[
                { title: 'Auto-Pay', rows: autoPays },
                { title: 'On File', rows: onFile },
              ]
                .filter((g) => g.rows.length)
                .map((g) => (
                  <div key={g.title} className="pays-for__group">
                    <div className="pays-for__group-title">
                      {g.title} <span>{g.rows.length}</span>
                    </div>
                    {g.rows.map((a) => (
                      <div key={a.entryId} className="pays-for__row">
                        <Link to={`/vault/${a.entryId}`} className="pays-for__name" onClick={onClose}>
                          {a.title || 'Untitled Entry'}
                        </Link>
                        <span className="pays-for__meta">{[a.latestBill, a.due ? `Due ${a.due}` : null].filter(Boolean).join(' · ')}</span>
                        <button type="button" className="pays-for__edit" onClick={() => setPayerModal({ entryId: a.entryId })} aria-label={`Edit ${a.title}`}>
                          Edit
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              <button type="button" className="pays-for__add" onClick={() => setPayerModal({})}>
                ＋ Add Account
              </button>
            </div>
          )}
        </div>

        {card.notes && (
          <div className="wallet-barcode-view__notes">
            <div className="wallet-barcode-view__notes-body" style={{ marginTop: 0 }}>
              {card.notes}
            </div>
          </div>
        )}

        <button type="button" className="wallet-barcode-view__edit" onClick={onEdit}>
          {isBank ? 'Edit account' : 'Edit card'}
        </button>
      </div>

      {payerModal && (
        <div onClick={(e) => e.stopPropagation()}>
          <AccountPayerModal
            cardId={payerModal.entryId ? undefined : card.id}
            entryId={payerModal.entryId}
            onClose={() => setPayerModal(null)}
            onSaved={loadPaidAccounts}
          />
        </div>
      )}

      {lightboxSide && (
        <CardImageLightbox frontUrl={card.coverArtUrl} backUrl={card.backArtUrl} side={lightboxSide} onSide={setLightboxSide} onClose={() => setLightboxSide(null)} />
      )}
    </div>
  );
}
