import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { MeetingPrep } from '../api/types';
import { copyText } from '../utils/clipboard';
import { meetingPacket } from '../utils/claudePacket';

/** "📋 Copy Prep for Claude" on a day-of Prep task. The prep loads when the
 * button appears, so the copy happens right inside the tap (phones refuse
 * clipboard writes after a network wait). */
export function MeetingPrepCopyButton({ meetingId, date, className = 'task-row__brief-link' }: { meetingId: string; date: string; className?: string }) {
  const [prep, setPrep] = useState<MeetingPrep | null>(null);
  const [state, setState] = useState<'idle' | 'done' | 'missing'>('idle');
  useEffect(() => {
    api
      .getMeetingPrep(date, meetingId)
      .then(setPrep)
      .catch(() => setState('missing'));
  }, [date, meetingId]);
  if (state === 'missing') return null;
  return (
    <button
      type="button"
      className={className}
      disabled={!prep}
      onClick={async (e) => {
        e.stopPropagation();
        if (!prep) return;
        if (await copyText(meetingPacket(prep.meeting, prep, null, 'prep'))) {
          setState('done');
          window.setTimeout(() => setState('idle'), 4000);
        }
      }}
    >
      {state === 'done' ? 'Copied ✓ — paste into Claude' : '📋 Copy Prep for Claude'}
    </button>
  );
}
