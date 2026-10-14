import type { MeetingAction, MeetingItem, MeetingPrep, MeetingSummaryBundle, WeekBrief, WorkTask } from '../api/types';

/** "Copy for Claude": plain-text packets Mike pastes into his work Claude
 * Project (Prep / Debrief / Weekly modes) so it starts from what MikeOS
 * already knows — people, what's open with them, last time's notes. The
 * project's instructions read the first line to pick the mode. */

const TZ = 'America/New_York';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const ymdLong = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const taskTitle = (t: WorkTask) => t.title.replace(/^Check Back: /, '');
const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

function actionLine(a: MeetingAction): string {
  const who = a.isMine ? 'Me' : a.contactName ?? a.ownerName ?? 'Unowned';
  const state = a.status === 'pending' ? 'not sorted' : a.status === 'task' ? 'my task' : a.status === 'waiting' ? 'waiting' : a.status;
  return `[${who}] ${a.text} (${state}${a.dueDate ? `, due ${a.dueDate}` : ''})`;
}

export function meetingPacket(meeting: MeetingItem & { date?: string }, prep: MeetingPrep | null, own: MeetingSummaryBundle | null, mode: 'prep' | 'debrief'): string {
  const m = prep?.meeting ?? meeting;
  const when = meeting.allDay ? `${day(meeting.start)}, all day` : `${day(meeting.start)}, ${time(meeting.start)} – ${time(meeting.end)}`;
  const out: string[] = [];
  out.push(
    mode === 'prep'
      ? `Prep me for ${meeting.title} on ${when}. What do I need to get out of it, and what am I likely to get asked?`
      : `Debrief: ${meeting.title}, ${when}. My notes and what's open are below; Gemini notes / deck / sheet attached or pasted after this, if I have them.`
  );
  out.push('');
  out.push(`Meeting: ${meeting.title}${m.recurring ? ' (recurring)' : ''}`);
  out.push(`When: ${when}`);
  const people = prep?.people ?? [];
  if (people.length) {
    out.push('People:');
    for (const p of people) out.push(`- ${[p.name, p.title, p.email].filter(Boolean).join(' — ')}`);
  } else if (meeting.attendees?.length) {
    out.push('Invited:');
    for (const a of meeting.attendees) out.push(`- ${[a.name, a.email].filter(Boolean).join(' — ')}`);
  }

  const note = (prep?.agendaNoteText ?? '').trim();
  if (note) out.push('', 'My notes:', note.slice(0, 6000));

  const raise = people.filter((p) => (p.agenda ?? []).some((a) => !a.doneAt));
  if (raise.length) {
    out.push('', 'I want to raise:');
    for (const p of raise) out.push(`- With ${p.name}: ${(p.agenda ?? []).filter((a) => !a.doneAt).map((a) => a.text).join('; ')}`);
  }

  const owed = people.filter((p) => p.iOwe.length || p.theyOwe.length);
  if (owed.length) {
    out.push('', 'Open with these people:');
    for (const p of owed) {
      if (p.iOwe.length) out.push(`- I owe ${p.name}: ${p.iOwe.map(taskTitle).join('; ')}`);
      if (p.theyOwe.length) out.push(`- Waiting on ${p.name}: ${p.theyOwe.map(taskTitle).join('; ')}`);
    }
  }

  const cf = prep?.carryForward;
  if (cf) {
    out.push('', `Since last time (${day(cf.start)}) — report follow-through on these:`);
    if (cf.tldr.length) out.push('Last time in short:', bullet(cf.tldr));
    if (cf.myFollowUps.length) out.push('What I did from those notes:', bullet(cf.myFollowUps.map((f) => `[${f.done ? 'done' : 'open'}] ${f.title.replace(/^Check Back: /, 'Waiting on: ')}`)));
    if (cf.commitments.length) out.push('Next steps recorded last time:', bullet(cf.commitments.slice(0, 40).map((x) => `[${x.owner}] ${x.text}${x.due ? ` (due ${x.due})` : ''}`)));
  }

  const earlier = (prep?.openActions ?? []).filter((a) => a.meetingId !== meeting.id);
  if (earlier.length) out.push('', 'Still open from earlier meetings:', bullet(earlier.slice(0, 25).map(actionLine)));
  const stillOpen = prep?.stillOpenItems ?? [];
  if (stillOpen.length) out.push('', 'Open questions / watch-outs from earlier briefs:', bullet(stillOpen.slice(0, 20).map((i) => `${i.kind === 'question' ? 'Q' : 'Watch'}: ${i.text}`)));

  const here = (own?.actions ?? []).filter((a) => a.meetingId === meeting.id && a.status !== 'dismissed');
  if (here.length) out.push('', 'Next steps already captured for this meeting:', bullet(here.slice(0, 25).map(actionLine)));

  const last = prep?.past?.[0];
  if (last && (last.summary || last.myNote)) {
    out.push('', `Last time (${day(last.start)}):`);
    if (last.summary?.tldr?.length) out.push(bullet(last.summary.tldr));
    else if (last.summary?.summary) out.push(last.summary.summary.slice(0, 1500));
    if (last.myNote?.snippet) out.push(`My notes then: ${last.myNote.snippet.slice(0, 600)}`);
  }
  return out.join('\n').trim() + '\n';
}

export function weekPacket(b: WeekBrief, mode: 'review' | 'ahead'): string {
  const out: string[] = [];
  out.push(mode === 'review' ? `Weekly mode. Here's my week (${ymdLong(b.week)} – ${ymdLong(b.weekEnd)}). Write my Week in Review, ready to post.` : `Weekly mode, Week Ahead (${ymdLong(b.week)} – ${ymdLong(b.weekEnd)}). What are my top 3 priorities, and what should I drop or delegate?`);
  const sec = (title: string, xs: string[]) => {
    if (xs.length) out.push('', `${title}:`, bullet(xs));
  };
  const t = (x: WorkTask) => `${taskTitle(x)}${x.project ? ` (${x.project.title})` : ''}${x.contactName ? ` — ${x.contactName}` : ''}`;
  if (b.review.priorities.trim()) out.push('', 'My priorities:', b.review.priorities.trim());
  sec('Done', b.done.map(t));
  sec('Received (waiting items that came in)', b.received.map(t));
  sec('Pushed later', b.pushed.map((x) => `${t(x)} — pushed ${x.pushCount ?? 1}×`));
  sec('Slipped (due this week, still open)', b.slipped.map(t));
  sec('Overdue', b.overdue.map((x) => `${t(x)} — due ${x.due_date}`));
  sec('Due this week', b.dueThisWeek.map((x) => `${t(x)}${x.due_date ? ` — ${x.due_date}` : ''}`));
  sec('Blocked', b.blocked.map((x) => `${t(x)}${x.blocked_reason ? ` (${x.blocked_reason})` : ''}`));
  sec('Waiting on', b.waiting.map((x) => `${t(x)}${x.waiting_since ? ` — since ${x.waiting_since}` : ''}`));
  sec('Due next week', b.dueNextWeek.map((x) => `${t(x)}${x.due_date ? ` — ${x.due_date}` : ''}`));
  const meetings = b.meetings.filter((m) => !m.allDay || m.summaryCount);
  if (meetings.length) {
    out.push('', `Meetings (${b.meetingHours} h):`);
    for (const m of meetings) {
      out.push(`- ${ymdLong(m.date)} · ${m.title}${m.people.length ? ` — ${m.people.map((p) => p.name).join(', ')}` : ''}`);
      if (m.summary) out.push(`  ${m.summary.replace(/\n+/g, ' / ').slice(0, 400)}`);
    }
  }
  if (b.review.highlights.trim()) out.push('', 'Highlights so far:', b.review.highlights.trim());
  if (b.pendingActions) out.push('', `${b.pendingActions} next steps from meetings are still unsorted.`);
  return out.join('\n').trim() + '\n';
}
