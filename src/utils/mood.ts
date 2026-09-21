// Shared 1 (rough) – 5 (great) mood scale — one integer, no free text, so
// it can be picked with a single tap (JournalPage's picker) and charted or
// quoted back verbatim (JournalPage's trend strip, BriefingModal's weekly
// retrospective) without any parsing. Colors run red → teal and are reused
// everywhere a mood needs a swatch, so the same day always reads the same
// color no matter where it shows up.
export interface MoodOption {
  value: number;
  emoji: string;
  label: string;
  color: string;
}

export const MOOD_OPTIONS: MoodOption[] = [
  { value: 1, emoji: '😞', label: 'Rough', color: '#c1573b' },
  { value: 2, emoji: '😕', label: 'Off', color: '#cf9a4c' },
  { value: 3, emoji: '😐', label: 'Okay', color: '#c8b45a' },
  { value: 4, emoji: '🙂', label: 'Good', color: '#7fa66b' },
  { value: 5, emoji: '😄', label: 'Great', color: '#3f8f6f' },
];

export const MOOD_BY_VALUE = new Map(MOOD_OPTIONS.map((m) => [m.value, m]));

/** Nearest mood option's emoji for a possibly-fractional average (a
 * week's mean mood is rarely a whole number) — rounds to the closest
 * logged value rather than truncating. */
export function moodEmojiForAverage(avg: number): string {
  const rounded = Math.min(5, Math.max(1, Math.round(avg)));
  return MOOD_BY_VALUE.get(rounded)?.emoji ?? '😐';
}
