import { useRef } from 'react';

// Threshold, in pixels, past which a drag counts as a deliberate swipe
// rather than an accidental nudge or the start of a scroll/click. Exported
// so a caller that wants to show its own "you've gone far enough to fire
// this" cue during the drag (see NewsPage's ArticleRow) can key it off the
// exact same number this hook actually fires at, instead of a second,
// easy-to-drift-out-of-sync guess at the right pixel value.
export const SWIPE_THRESHOLD = 60;

interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  /** Live horizontal drag offset, called on every pointer move so the UI
   * can reveal the pending action (a "Read"/"Save" label, a translated
   * card) before the gesture completes. */
  onDragX?: (dx: number) => void;
  /** Same, vertically. */
  onDragY?: (dy: number) => void;
  /** Called when a drag ends without crossing the threshold, so the
   * caller can spring the UI back to rest. */
  onCancel?: () => void;
}

/** Pointer-events-based swipe/drag detector — works for touch, mouse, and
 * pen in one implementation (rather than separate touch/mouse handlers),
 * which is also what makes the desktop drag-to-preview behavior "just
 * work" the same way touch does. Returns the handler props to spread onto
 * the draggable element. */
export function useSwipe(opts: SwipeOptions) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);

  function onPointerDown(e: React.PointerEvent) {
    // Only the primary button/touch — ignore right-click drags etc.
    if (e.button !== undefined && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    moved.current = false;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current || start.current.id !== e.pointerId) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true;
    if (!moved.current) return;
    // Whichever axis moved further governs — a mostly-horizontal drag
    // shouldn't also nudge the vertical offset and vice versa.
    if (Math.abs(dx) >= Math.abs(dy)) {
      opts.onDragX?.(dx);
      opts.onDragY?.(0);
    } else {
      opts.onDragY?.(dy);
      opts.onDragX?.(0);
    }
  }

  function finish(e: React.PointerEvent) {
    if (!start.current || start.current.id !== e.pointerId) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    start.current = null;
    if (!moved.current) return; // a plain click/tap — let the element's own onClick handle it

    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx <= -SWIPE_THRESHOLD) return opts.onSwipeLeft?.();
      if (dx >= SWIPE_THRESHOLD) return opts.onSwipeRight?.();
    } else {
      if (dy <= -SWIPE_THRESHOLD) return opts.onSwipeUp?.();
      if (dy >= SWIPE_THRESHOLD) return opts.onSwipeDown?.();
    }
    opts.onCancel?.();
  }

  function onPointerUp(e: React.PointerEvent) {
    finish(e);
  }

  function onPointerLeave(e: React.PointerEvent) {
    // A drag that leaves the element (finger slides off, mouse leaves the
    // window) should still resolve rather than leaving the card stuck
    // mid-drag forever.
    if (start.current?.id === e.pointerId && moved.current) finish(e);
  }

  // A swiped article's onClick shouldn't also fire as "open externally" —
  // suppress the synthetic click that follows a drag.
  function onClickCapture(e: React.MouseEvent) {
    if (moved.current) {
      e.preventDefault();
      e.stopPropagation();
      moved.current = false;
    }
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onClickCapture };
}
