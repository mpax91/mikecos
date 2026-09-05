import { useEffect, useState } from 'react';

// Tablets already render fine at the desktop breakpoint (confirmed against
// the sizes Mike actually uses), so mobile gets exactly one extra tier —
// phone widths only — rather than a three-way desktop/tablet/phone split.
const MOBILE_QUERY = '(max-width: 640px)';

/** True on phone-width screens. Reactive to resize/rotation, not just the
 * width at mount — matches matchMedia's own 'change' event rather than
 * polling, so it costs nothing when the viewport isn't changing. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
