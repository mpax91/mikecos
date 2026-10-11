import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContactComms } from '../api/types';

/** Collapsed "Calls & Texts" bar on a contact card (same look as Voter
 * Insight): last time you talked + how often in the bar; the last 12
 * months inside. From the phone backup in Drive (worker/src/comms/) —
 * counts and dates only, never message text. */

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null);
const ago = (iso: string | null) => {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${Math.round(days / 365)} years ago`;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 15).toLocaleDateString('en-US', { month: 'short' });
};
const KIND: Record<string, string> = { call_in: 'Incoming', call_out: 'Outgoing', call_missed: 'Missed', text_in: 'Received', text_out: 'Sent' };

function Tile({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <div className="voter-tile">
      <div className="voter-tile__label">{label}</div>
      <div className="voter-tile__value">{value}</div>
    </div>
  );
}

export function ContactCommsSection({ comms }: { comms: ContactComms | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!comms) return null;
  const y = comms.year;
  const max = Math.max(1, ...comms.months.map((m) => m.calls + m.texts));
  const since = (ym: string | null) => (ym ? new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 15).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null);
  return (
    <div className={`voter-insight comms-contact${open ? ' is-open' : ''}`}>
      <button type="button" className="voter-insight__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="voter-insight__caret" aria-hidden>
          ›
        </span>
        <span className="voter-insight__title">Calls &amp; Texts</span>
        <span className="voter-insight__summary">
          <span className="comms-contact__last">{comms.lastTouch ? `Last In Touch ${ago(comms.lastTouch)}` : 'No Calls or Texts on File'}</span>
          {comms.lastTouch && <span className="bee-badge bee-badge--muted">{comms.cadence}</span>}
        </span>
        <span className="voter-insight__toggle">{open ? 'Hide Details' : 'Show Details'}</span>
      </button>
      {open && (
        <div className="voter-insight__card">
          <div className="voter-insight__body">
            <div className="voter-insight__group-title">Most Recent</div>
            <div className="voter-tiles">
              <Tile label="Last Call" value={comms.lastCall ? `${fmtDay(comms.lastCall.at)} · ${KIND[comms.lastCall.kind] ?? ''}` : 'None on file'} />
              <Tile label="Last Text" value={comms.lastText ? `${fmtDay(comms.lastText.at)} · ${KIND[comms.lastText.kind] ?? ''}` : 'None on file'} />
              {comms.groups.count > 0 && <Tile label="Group Chats Together" value={`${comms.groups.count}${comms.groups.lastAt ? ` · active ${fmtDay(comms.groups.lastAt)}` : ''}`} />}
            </div>
            <div className="voter-insight__group-title">Last 12 Months</div>
            <div className="voter-tiles">
              <Tile label="Calls" value={`${y.callsOut} out · ${y.callsIn} in${y.callsMissed ? ` · ${y.callsMissed} missed` : ''}`} />
              <Tile label="Talk Time" value={y.minutes ? `${y.minutes.toLocaleString()} min` : '—'} />
              <Tile label="Texts" value={`${y.textsOut} sent · ${y.textsIn} received`} />
              {y.groupIn > 0 && <Tile label="Their Group Messages" value={y.groupIn} />}
              <Tile label="Months in Touch" value={`${comms.activeMonths} of 12`} />
              <Tile label="Who Reaches Out" value={comms.theyStartPct === null ? null : comms.theyStartPct >= 60 ? `Mostly them (${comms.theyStartPct}%)` : comms.theyStartPct <= 40 ? `Mostly you (${100 - comms.theyStartPct}%)` : 'About even'} />
            </div>
            <div className="comms-contact__months" role="img" aria-label="Calls and texts per month, last 12 months">
              {comms.months.map((m) => (
                <div key={m.month} className="comms-contact__month" title={`${m.month}: ${m.calls} calls, ${m.texts} texts`}>
                  <span className="comms-contact__bar">
                    <span className="comms-contact__bar-calls" style={{ height: `${(m.calls / max) * 100}%` }} />
                    <span className="comms-contact__bar-texts" style={{ height: `${(m.texts / max) * 100}%` }} />
                  </span>
                  <span className="comms-contact__month-label">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
            <p className="fin-dash__note">
              <span className="comms-contact__key comms-contact__key--calls" /> Calls <span className="comms-contact__key comms-contact__key--texts" /> 1:1 texts · From your phone backup
              {comms.coverage.chatsSince ? ` — chat history starts ${since(comms.coverage.chatsSince)}` : ''} · Counts and dates only ·{' '}
              <Link to="/settings?cat=comms">Settings</Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
