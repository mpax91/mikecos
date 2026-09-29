import { useSwipe } from '../utils/useSwipe';

/** Tap a card's art to see it full-size, and — when a back image exists —
 * swipe (or tap the dots) to flip between front and back, the same way
 * flipping a physical card over works. Shared between Wallet's My Cards
 * and Payment Cards, since both now carry a front/back image pair. Front-
 * only shows the one image large with no swipe affordance. */
export function CardImageLightbox({
  frontUrl,
  backUrl,
  side,
  onSide,
  onClose,
  frontOrientation = 'landscape',
  backOrientation = 'landscape',
}: {
  frontUrl: string | null;
  backUrl: string | null;
  side: 'front' | 'back';
  onSide: (side: 'front' | 'back') => void;
  onClose: () => void;
  /** Wallet-only, and independent per side (a card can be vertical on one
   * face and horizontal on the other) — a physical payment card is always
   * landscape both sides, so PaymentCardDetail never passes these and gets
   * the default. */
  frontOrientation?: 'landscape' | 'portrait';
  backOrientation?: 'landscape' | 'portrait';
}) {
  const hasBack = !!backUrl;
  const showingBack = side === 'back' && backUrl;
  const src = showingBack ? backUrl : frontUrl;
  const orientation = showingBack ? backOrientation : frontOrientation;
  const swipe = useSwipe({
    onSwipeLeft: () => hasBack && onSide('front'),
    onSwipeRight: () => hasBack && onSide('back'),
  });

  return (
    <div className="wallet-lightbox" onClick={onClose}>
      <button type="button" className="wallet-lightbox__close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      <div
        className={`wallet-lightbox__image-wrap${orientation === 'portrait' ? ' wallet-lightbox__image-wrap--portrait' : ''}`}
        onClick={(e) => e.stopPropagation()}
        {...swipe}
      >
        {src && <img src={src} alt="" />}
      </div>
      {hasBack && (
        <>
          <div className="wallet-lightbox__hint">Swipe to flip</div>
          <div className="wallet-lightbox__dots" onClick={(e) => e.stopPropagation()}>
            <button type="button" className={`wallet-lightbox__dot${side === 'front' ? ' is-active' : ''}`} onClick={() => onSide('front')} aria-label="Front" />
            <button type="button" className={`wallet-lightbox__dot${side === 'back' ? ' is-active' : ''}`} onClick={() => onSide('back')} aria-label="Back" />
          </div>
        </>
      )}
    </div>
  );
}
