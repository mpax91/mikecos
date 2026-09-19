import { useEffect, useState } from 'react';

/** True whenever `query` currently matches. Reactive to resize/rotation via
 * matchMedia's own 'change' event rather than polling, so it costs nothing
 * when the viewport isn't changing. Shared by useIsMobile and useIsCompact
 * below — each just pins a different breakpoint. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

// Tablets already render fine at the desktop breakpoint (confirmed against
// the sizes Mike actually uses), so mobile gets exactly one extra tier —
// phone widths only — rather than a three-way desktop/tablet/phone split.
const MOBILE_QUERY = '(max-width: 640px)';

/** True on phone-width screens. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

// Notes' split view is the one exception to the "tablets render fine at the
// desktop breakpoint" rule above: its sidebar is a fixed 320px, which on a
// ~768-820px tablet (a Galaxy Tab in portrait, e.g.) leaves the detail pane
// only a couple hundred cramped pixels next to it — the two-pane split just
// doesn't have room to work there the way it does on a real desktop monitor.
// This is a wider, page-specific tier for exactly that kind of layout,
// rather than lowering the shared MOBILE_QUERY threshold (and dragging every
// other tablet-width page back into its phone treatment along with it).
const COMPACT_QUERY = '(max-width: 900px)';

/** True up through tablet-portrait widths — wider than useIsMobile's phone-
 * only cutoff. Use for a layout (like Notes' sidebar+detail split) that
 * specifically needs more room than a fixed-width two-pane split can offer
 * on a tablet, not as a general mobile check. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}
