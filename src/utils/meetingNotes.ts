// Shared by TodayPage and JournalPage's meeting rows — kept here rather
// than duplicated by eye (like most of this app's small date helpers)
// because both the title format and the "has this meeting already
// happened" rule need to stay byte-for-byte identical between the two
// pages' note icons.

// Meeting times are shown in Mike's home timezone specifically (rather
// than the viewing device's own zone) — same fixed Bedford Hills, NY
// assumption the rest of the meeting UI (and the weather widget) makes.
const MEETING_TZ = 'America/New_York';

/** The default title for a note created from a meeting's note icon:
 * "9/17/26 | 2:00 PM – 2:30 PM | Planning Sync" (all-day events drop the
 * time range). Matches what's shown on the row itself, not the viewer's
 * local time. */
export function buildMeetingNoteTitle(m: { title: string; start: string; end: string; allDay: boolean }): string {
  const dateLabel = new Date(m.start).toLocaleDateString('en-US', {
    timeZone: MEETING_TZ,
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
  });
  const title = m.title || 'Untitled meeting';
  if (m.allDay) return `${dateLabel} | ${title}`;
  const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: MEETING_TZ, hour: 'numeric', minute: '2-digit' });
  return `${dateLabel} | ${timeLabel(m.start)} – ${timeLabel(m.end)} | ${title}`;
}

/** Whether this meeting occurrence is already over — the same rule used
 * for the strikethrough on Today/Journal meeting rows. A past meeting's
 * note icon never creates a new note (see each page's openMeetingNote) —
 * it only opens one that already exists. */
export function meetingHasEnded(m: { end: string; allDay: boolean }): boolean {
  return !m.allDay && new Date(m.end).getTime() <= Date.now();
}
