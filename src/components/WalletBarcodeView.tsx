import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api/client';
import type { WalletCard, WalletCardFact } from '../api/types';
import { CardImageLightbox } from './CardImageLightbox';
import { isPhoneLabel, telHref } from '../utils/phone';

const JSBARCODE_FORMAT: Record<string, string> = {
  code128: 'CODE128',
  upc: 'UPC',
  ean13: 'EAN13',
};

/** The full-screen "hand this to the cashier" view — the whole reason
 * Wallet exists. Deliberately forced to a plain white surface regardless of
 * the app's own theme (light or dark): every real barcode-wallet app does
 * this, because a dark background around the code is what actually costs
 * you the scan, not what looks nice. Also requests a screen wake lock for
 * as long as this is open, so the phone doesn't dim or lock mid-scan —
 * that's a real, supported browser API (unlike screen *brightness*, which
 * no web page can control; the honest equivalent here is "never let the
 * screen shut off while this is on screen"). */
export function WalletBarcodeView({ card, onClose, onEdit }: { card: WalletCard; onClose: () => void; onEdit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pinRevealed, setPinRevealed] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [facts, setFacts] = useState<WalletCardFact[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedFactId, setCopiedFactId] = useState<string | null>(null);
  const [lightboxSide, setLightboxSide] = useState<'front' | 'back' | null>(null);
  const [wakeLockSupported] = useState(() => typeof navigator !== 'undefined' && 'wakeLock' in navigator);
  // Reveal-on-tap for the encrypted ID number (license/passport/military
  // ID), same fetch-on-first-tap state machine as PaymentCardDetail's
  // reveal() for number/CVV.
  const [idRevealed, setIdRevealed] = useState<string | null>(null);
  const [idRevealing, setIdRevealing] = useState(false);
  const [idRevealError, setIdRevealError] = useState<string | null>(null);
  const [idShown, setIdShown] = useState(false);
  const [idCopied, setIdCopied] = useState(false);

  useEffect(() => {
    api.listWalletCardFacts(card.id).then(setFacts).catch(() => {});
  }, [card.id]);

  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    if (wakeLockSupported) {
      navigator.wakeLock
        .request('screen')
        .then((s) => {
          sentinel = s;
        })
        .catch(() => {
          // Common (backgrounded tab, battery saver, unsupported context) —
          // the barcode still works, it just might dim after the usual
          // timeout, same as before this existed.
        });
    }
    return () => {
      sentinel?.release().catch(() => {});
    };
  }, [wakeLockSupported]);

  useEffect(() => {
    if (card.barcodeType === 'code128' || card.barcodeType === 'upc' || card.barcodeType === 'ean13') {
      if (!canvasRef.current || !card.barcodeValue) return;
      try {
        JsBarcode(canvasRef.current, card.barcodeValue, {
          format: JSBARCODE_FORMAT[card.barcodeType],
          lineColor: '#000000',
          background: '#ffffff',
          width: 2.4,
          height: 110,
          displayValue: false,
          margin: 0,
        });
      } catch {
        // A malformed value for the chosen format (e.g. non-numeric UPC) —
        // the fallback text number below still lets the number be keyed in
        // by hand, so this fails silently rather than showing an error
        // screen at the register.
      }
    }
  }, [card.barcodeType, card.barcodeValue]);

  const fallbackNumber = card.displayNumber || card.barcodeValue;

  function copyNumber() {
    if (!fallbackNumber) return;
    navigator.clipboard.writeText(fallbackNumber).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1300);
    });
  }

  async function revealId() {
    if (idRevealed !== null) {
      setIdShown((v) => !v);
      return;
    }
    setIdRevealing(true);
    setIdRevealError(null);
    try {
      const secret = await api.revealWalletCardId(card.id);
      setIdRevealed(secret.idNumber);
      setIdShown(true);
    } catch {
      setIdRevealError("Couldn't decrypt — try again.");
    } finally {
      setIdRevealing(false);
    }
  }

  function copyIdNumber() {
    if (!idRevealed) return;
    navigator.clipboard.writeText(idRevealed).then(() => {
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1300);
    });
  }

  function copyFact(fact: WalletCardFact) {
    if (!fact.value) return;
    navigator.clipboard.writeText(fact.value).then(() => {
      setCopiedFactId(fact.id);
      setTimeout(() => setCopiedFactId((id) => (id === fact.id ? null : id)), 1300);
    });
  }

  return (
    <div className="wallet-barcode-view" onClick={onClose}>
      <div className="wallet-barcode-view__card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wallet-barcode-view__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="wallet-barcode-view__header">
          {card.coverArtUrl && (
            <button type="button" className="wallet-barcode-view__logo-btn" onClick={() => setLightboxSide('front')} aria-label="View card image larger">
              <img
                src={card.coverArtUrl}
                alt=""
                className={`wallet-barcode-view__logo${card.coverArtOrientation === 'portrait' ? ' wallet-barcode-view__logo--portrait' : ''}`}
              />
            </button>
          )}
          <div className="wallet-barcode-view__name">{card.name}</div>
          <div className="wallet-barcode-view__category">{card.category}</div>
        </div>

        <div className="wallet-barcode-view__code">
          {card.barcodeType === 'none' ? (
            <div className="wallet-barcode-view__no-code">No barcode on file — show the number below</div>
          ) : card.barcodeType === 'qr' ? (
            card.barcodeValue && <QRCodeSVG value={card.barcodeValue} size={230} marginSize={2} />
          ) : (
            <canvas ref={canvasRef} />
          )}
        </div>

        {fallbackNumber && (
          <div className="wallet-barcode-view__number-row">
            <span className="wallet-barcode-view__number">{fallbackNumber}</span>
            <button type="button" className="wallet-barcode-view__copy" onClick={copyNumber} aria-label="Copy number">
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        )}

        {(card.pinCode || card.balance) && (
          <div className="wallet-barcode-view__extra">
            {card.balance && (
              <div className="wallet-barcode-view__extra-row">
                <span>Balance</span>
                <span>{card.balance}</span>
              </div>
            )}
            {card.pinCode && (
              <div className="wallet-barcode-view__extra-row">
                <span>PIN</span>
                <button type="button" className="wallet-barcode-view__reveal" onClick={() => setPinRevealed((v) => !v)}>
                  {pinRevealed ? card.pinCode : 'Tap to reveal'}
                </button>
              </div>
            )}
          </div>
        )}

        {card.hasIdNumber && (
          <div className="wallet-barcode-view__extra">
            <div className="wallet-barcode-view__extra-row">
              <span>ID #</span>
              <button type="button" className="wallet-barcode-view__reveal" onClick={revealId} disabled={idRevealing}>
                {idRevealing ? 'Decrypting…' : idShown && idRevealed ? idRevealed : 'Tap to reveal'}
              </button>
              {idShown && idRevealed && (
                <button type="button" className="wallet-barcode-view__copy" onClick={copyIdNumber} aria-label="Copy ID number">
                  {idCopied ? 'Copied ✓' : 'Copy'}
                </button>
              )}
            </div>
            {idRevealError && <div className="wallet-editor__error">{idRevealError}</div>}
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

        {card.notes && (
          <div className="wallet-barcode-view__notes">
            <button type="button" className="wallet-barcode-view__notes-toggle" onClick={() => setNotesOpen((v) => !v)}>
              {notesOpen ? '▾' : '▸'} Notes
            </button>
            {notesOpen && <div className="wallet-barcode-view__notes-body">{card.notes}</div>}
          </div>
        )}

        <button type="button" className="wallet-barcode-view__edit" onClick={onEdit}>
          Edit card
        </button>
      </div>

      {lightboxSide && (
        <CardImageLightbox
          frontUrl={card.coverArtUrl}
          backUrl={card.backArtUrl}
          side={lightboxSide}
          onSide={setLightboxSide}
          onClose={() => setLightboxSide(null)}
          frontOrientation={card.coverArtOrientation}
          backOrientation={card.backArtOrientation}
        />
      )}
    </div>
  );
}
