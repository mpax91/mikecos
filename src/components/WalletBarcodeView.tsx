import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { QRCodeSVG } from 'qrcode.react';
import type { WalletCard } from '../api/types';

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
  const [wakeLockSupported] = useState(() => typeof navigator !== 'undefined' && 'wakeLock' in navigator);

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

  return (
    <div className="wallet-barcode-view" onClick={onClose}>
      <div className="wallet-barcode-view__card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wallet-barcode-view__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="wallet-barcode-view__header">
          {card.coverArtUrl && <img src={card.coverArtUrl} alt="" className="wallet-barcode-view__logo" />}
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

        {fallbackNumber && <div className="wallet-barcode-view__number">{fallbackNumber}</div>}

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

        <button type="button" className="wallet-barcode-view__edit" onClick={onEdit}>
          Edit card
        </button>
      </div>
    </div>
  );
}
