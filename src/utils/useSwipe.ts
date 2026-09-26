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
    // Without this, a real touchscreen can silently stop delivering
    // pointermove to this element mid-drag — the finger slides a few
    // pixels off the card's shrinking hit area (it's translating under the
    // finger via the live transform) and the browser starts treating later
    // events as hitting whatever's now underneath, or hands the gesture off
    // to its own scroll/navigation handling entirely. Capturing the pointer
    // pins every subsequent event for this gesture to this element
    // regardless of where the finger physically is, which is what a
    // synthetic PointerEvent test (dispatched directly, never touching the
    // browser's real hit-testing) can never catch — this only shows up on
    // an actual touchscreen, which is exactly the "feels broken on
    // mobile/tablet but the code looks right" symptom.
    //
    // Skipped for mouse input: a mouse pointer never "slides off" a shrinking
    // hit area the way a finger does, so there's no drag-tracking reason to
    // capture it — and capturing it anyway has a real cost on desktop. Once
    // this element holds capture, some browsers (Chrome included) redirect
    // the synthesized "click" event to the capturing element instead of the
    // actual descendant under the cursor, so a plain, un-dragged click on a
    // button nested inside this card (News's "Mark Read"/"Save" buttons) ends
    // up targeting the card itself and firing the card's own onClick (open
    // the article) instead of the button's. Touch/pen still capture as
    // before, since that's the input this guard exists for.
    if (e.pointerType === 'mouse') return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some elements/environments don't support capture — the gesture
      // still mostly works without it, just without this guarantee.
    }
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

  function releaseCapture(e: React.PointerEvent) {
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // no-op — nothing to release
    }
  }

  function finish(e: React.PointerEvent) {
    if (!start.current || start.current.id !== e.pointerId) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    start.current = null;
    releaseCapture(e);
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
    // With pointer capture in place this shouldn't normally fire mid-drag
    // any more — kept as a safety net for whatever environment doesn't
    // support capture (see the try/catch in onPointerDown) so a drag can't
    // get stuck if it does.
    if (start.current?.id === e.pointerId && moved.current) finish(e);
  }

  function onPointerCancel(e: React.PointerEvent) {
    // The browser can cancel a gesture mid-drag on its own initiative (an
    // incoming system gesture, the OS taking over, losing the touch) —
    // real-device-only behavior a synthetic PointerEvent test never
    // triggers. Without handling it, `start` stays set forever and the row
    // is left visually stuck mid-swipe until something else resets it —
    // exactly the kind of "broken" this hook needs to never do. Always
    // springs back (never fires an action) since a cancel is never a
    // deliberate release.
    if (!start.current || start.current.id !== e.pointerId) return;
    start.current = null;
    releaseCapture(e);
    if (moved.current) opts.onCancel?.();
    moved.current = false;
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

  return { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onPointerCancel, onClickCapture };
}
