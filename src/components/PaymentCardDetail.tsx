import { useState } from 'react';
import { api } from '../api/client';
import type { PaymentCard } from '../api/types';
import { CardImageLightbox } from './CardImageLightbox';

/** View modal for a single Payment Card. The number and CVV are never
 * fetched until Mike explicitly taps "Reveal" — GET /cards/:id/reveal is
 * the only call in the app that ever returns them decrypted, and even
 * then only into this component's own state, never logged or cached
 * beyond this view being open. */
export function PaymentCardDetail({ card, onClose, onEdit }: { card: PaymentCard; onClose: () => void; onEdit: () => void }) {
  const [revealed, setRevealed] = useState<{ number: string | null; cvv: string | null } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<'number' | 'cvv' | null>(null);
  const [lightboxSide, setLightboxSide] = useState<'front' | 'back' | null>(null);

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

  function copy(field: 'number' | 'cvv', value: string | null) {
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
            {[card.cardType === 'debit' ? 'Debit' : 'Credit', card.network, card.issuer].filter(Boolean).join(' · ')}
            {card.rewardWorthy ? ' · ★ Earns rewards' : ''}
          </div>
        </div>

        {(card.hasNumber || card.hasCvv || card.last4) && (
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
            {expiry && (
              <div className="payment-detail__secure-row">
                <span>Expires</span>
                <span className="payment-detail__secure-value">{expiry}</span>
              </div>
            )}
            <div className="payment-detail__secure-actions">
              {(card.hasNumber || card.hasCvv) && (
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

        {card.notes && (
          <div className="wallet-barcode-view__notes">
            <div className="wallet-barcode-view__notes-body" style={{ marginTop: 0 }}>
              {card.notes}
            </div>
          </div>
        )}

        <button type="button" className="wallet-barcode-view__edit" onClick={onEdit}>
          Edit card
        </button>
      </div>

      {lightboxSide && (
        <CardImageLightbox frontUrl={card.coverArtUrl} backUrl={card.backArtUrl} side={lightboxSide} onSide={setLightboxSide} onClose={() => setLightboxSide(null)} />
      )}
    </div>
  );
}
