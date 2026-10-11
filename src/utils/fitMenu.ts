/**
 * Placement for popup menus (KebabMenu dropdown, right-click ContextMenu) so
 * they never run off the screen.
 *
 * Vertical: open below the anchor when the whole menu fits there; otherwise
 * open above if it fits there; otherwise use whichever side has more room
 * and cap the height so the menu scrolls inside itself. Horizontal: right-
 * align to `anchorRight` (kebab) or start at `anchorLeft` (cursor), then
 * clamp into the viewport. All values are viewport (position: fixed) px.
 */
export interface MenuPlacement {
  top: number;
  left: number;
  maxHeight?: number;
}

const MARGIN = 8; // keep this far from the viewport edges
const GAP = 4; // space between the trigger and the menu

export function fitMenu(opts: {
  /** Menu's natural size (measured with no max-height applied). */
  width: number;
  height: number;
  /** Vertical anchor: the menu opens below `below` or ends above `above`. */
  below: number;
  above: number;
  /** Horizontal anchor: right edge to align to, or left edge to start at. */
  anchorRight?: number;
  anchorLeft?: number;
}): MenuPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { width, height } = opts;

  const roomBelow = vh - MARGIN - (opts.below + GAP);
  const roomAbove = opts.above - GAP - MARGIN;

  let top: number;
  let maxHeight: number | undefined;
  if (height <= roomBelow) {
    top = opts.below + GAP;
  } else if (height <= roomAbove) {
    top = opts.above - GAP - height;
  } else if (roomBelow >= roomAbove) {
    top = opts.below + GAP;
    maxHeight = Math.max(roomBelow, 80);
  } else {
    maxHeight = Math.max(roomAbove, 80);
    top = opts.above - GAP - maxHeight;
  }
  top = Math.max(MARGIN, top);

  let left = opts.anchorRight != null ? opts.anchorRight - width : (opts.anchorLeft ?? 0);
  left = Math.min(left, vw - MARGIN - width);
  left = Math.max(MARGIN, left);

  return { top, left, maxHeight };
}
