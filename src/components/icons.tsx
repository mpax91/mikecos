/** A handful of small inline icons for spots where an emoji glyph turned
 * out to render unreliably (the 🗑 "Remove" button on several Settings
 * panels was rendering as a near-invisible sliver on Mike's system —
 * emoji glyph coverage/rendering varies by OS/font in a way plain SVG
 * doesn't). Kept deliberately tiny — add to this file rather than
 * hand-rolling SVG inline wherever the next case turns up. */
export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.5h11" />
      <path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M6.5 7.5v4.5" />
      <path d="M9.5 7.5v4.5" />
      <path d="M3.5 4.5l.6 8.4a1 1 0 0 0 1 .93h5.8a1 1 0 0 0 1-.93l.6-8.4" />
    </svg>
  );
}
