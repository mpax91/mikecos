import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HouseholdMember, TurnoutCount, VoterDiff, VoterInsight, VoterRecord } from '../api/types';

/* Voter-file pieces of the contact page (Mike, 2026-10-10), modeled on the
 * Bedford Voter Intelligence app's voter card:
 * - PartyPill + HouseholdGlance live in the always-visible main card
 *   (party and spouse's name at a glance).
 * - VoterDiffBox is the "check before overwriting": the card never takes
 *   voter-file values over Mike's own without a click.
 * - VoterInsightSection is the collapsed deep-dive panel.
 * The voter-file phone is deliberately NOT on the main card — it's
 * unreliable; it stays in the panel, labeled as such. */

function partyTone(code: string | null | undefined): 'dem' | 'rep' | 'other' {
  if (code === 'DEM' || code === 'WOR') return 'dem';
  if (code === 'REP' || code === 'CON') return 'rep';
  return 'other';
}

export function PartyPill({ code, name }: { code: string | null | undefined; name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className={`party-pill party-pill--${partyTone(code)}`} title="Party registration (voter file)">
      {name}
    </span>
  );
}

function pct(t: TurnoutCount | undefined): string {
  if (!t || t.eligible === 0) return '—';
  return `${Math.round((t.voted / t.eligible) * 100)}%`;
}

function turnoutText(t: TurnoutCount | undefined): string {
  if (!t || t.eligible === 0) return 'no elections yet';
  return `${t.voted}/${t.eligible} elections`;
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** Household line inside the main contact card. */
export function HouseholdGlance({ members }: { members: HouseholdMember[] }) {
  if (members.length === 0) return null;
  return (
    <div className="contact-detail__field household-glance">
      <span className="contact-detail__field-icon">🏠</span>
      <span className="contact-detail__field-value household-glance__list">
        {members.map((m, i) => (
          <span key={m.contactId} className="household-glance__member">
            <span className={`party-dot party-dot--${partyTone(m.partyCode)}`} aria-hidden />
            <Link to={`/contacts/${m.contactId}`} className="household-glance__name">
              {m.name}
            </Link>
            <span className="household-glance__meta">
              {[m.partyCode, m.age != null ? m.age : null].filter((v) => v != null && v !== '').join(' · ')}
            </span>
            {i < members.length - 1 && <span className="household-glance__sep" aria-hidden />}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Where Mike's card and the voter file disagree. Nothing is overwritten
 * until he picks; "Keep Mine" stops asking until the voter value changes. */
export function VoterDiffBox({ diffs, onDecide }: { diffs: VoterDiff[]; onDecide: (d: VoterDiff, decision: 'use' | 'keep') => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (diffs.length === 0) return null;
  async function decide(d: VoterDiff, decision: 'use' | 'keep') {
    setBusy(d.field);
    try {
      await onDecide(d, decision);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="voter-diff" role="region" aria-label="Voter File Differs">
      <div className="voter-diff__title">Voter File Differs</div>
      <p className="voter-diff__hint">The voter roll disagrees with this card. Nothing changes until you choose.</p>
      {diffs.map((d) => (
        <div key={d.field} className="voter-diff__row">
          <div className="voter-diff__label">{d.label}</div>
          <div className="voter-diff__values">
            <div className="voter-diff__value">
              <span className="voter-diff__which">Yours</span>
              {d.mine}
            </div>
            <div className="voter-diff__value voter-diff__value--voter">
              <span className="voter-diff__which">Voter File</span>
              {d.voter}
            </div>
          </div>
          <div className="voter-diff__actions">
            <button type="button" className="btn btn--small" disabled={busy === d.field} onClick={() => decide(d, 'use')}>
              Use Voter File
            </button>
            <button type="button" className="btn btn--ghost btn--small" disabled={busy === d.field} onClick={() => decide(d, 'keep')}>
              Keep Mine
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, wide, mono }: { label: string; value: string | number | null | undefined; wide?: boolean; mono?: boolean }) {
  if (value == null || value === '') return null;
  return (
    <div className={`voter-tile${wide ? ' voter-tile--wide' : ''}`}>
      <div className="voter-tile__label">{label}</div>
      <div className={`voter-tile__value${mono ? ' voter-tile__value--small' : ''}`}>{value}</div>
    </div>
  );
}

const METHOD_NAMES: Record<string, string> = {
  MAC: 'in person',
  EAR: 'early',
  ABS: 'absentee',
  AFF: 'affidavit',
  EMG: 'emergency',
};
function methodLabel(m: string | null): string {
  if (!m) return '';
  return m
    .split('/')
    .map((p) => METHOD_NAMES[p.trim().toUpperCase()] ?? p.trim())
    .join(' / ');
}

const KIND_LABEL: Record<string, string> = {
  general: 'General',
  local: 'Local (odd-year) general',
  primary: 'Primary',
  presidentialPrimary: 'Presidential primary',
  special: 'Special',
  village: 'Village',
};

function VoterRecordInsight({ r, household }: { r: VoterRecord; household: HouseholdMember[] }) {
  const [showRaw, setShowRaw] = useState(false);
  const ins = r.insight;
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(r.raw_data) as Record<string, string>;
  } catch {
    raw = {};
  }
  const street = raw.ADDRESSLINE1 ? [raw.ADDRESSLINE1, raw.CITY, [raw.STATE, raw.ZIPCODE].filter(Boolean).join(' ')].filter(Boolean).join(', ') : raw['FULL ADDRESS'];
  const districts: [string, string | null | undefined][] = [
    ['ED', ins?.ed],
    ['CD', r.cd],
    ['SD', r.sd],
    ['AD', r.ad],
    ['LD', r.ld],
  ];
  const phone = r.phone ?? ins?.cellPhone;

  return (
    <div className="voter-insight__body">
      <div className="voter-insight__group-title">Profile</div>
      <div className="voter-tiles">
        <Tile label="Age" value={r.voter_age} />
        <Tile label="Gender" value={r.gender === 'M' ? 'Male' : r.gender === 'F' ? 'Female' : r.gender} />
        <Tile label="Born" value={fmtDate(ins?.born ?? null)} />
        <Tile label="Registered" value={fmtDate(ins?.registered ?? null) ?? r.registered_date} />
      </div>

      <div className="voter-insight__group-title">Address</div>
      <div className="voter-tiles">
        <Tile label="Street (Voter File)" value={street} wide />
        <Tile label="Phone (Voter File · Unverified)" value={phone} wide />
        <Tile label="Polling Place" value={r.polling_place} wide mono />
      </div>

      <div className="voter-insight__group-title">Political Profile</div>
      <div className="voter-tiles">
        <Tile label="Registration" value={ins?.partyName ?? r.party} />
        <Tile label="Calculated" value={r.calculated_party} />
        <Tile label="Household Party" value={r.household_party} wide />
        <Tile label="Causeway Tag" value={r.causeway_tag} wide />
        <Tile label="GOP Matrix" value={r.gop_matrix} wide mono />
      </div>

      {districts.some(([, v]) => v) && (
        <>
          <div className="voter-insight__group-title">Districts</div>
          <div className="voter-tiles voter-tiles--districts">
            {districts.map(([k, v]) => (
              <Tile key={k} label={k} value={v ? String(v).replace(new RegExp(`^${k}-?`, 'i'), '') : null} />
            ))}
          </div>
        </>
      )}

      {ins && ins.elections.length > 0 && (
        <>
          <div className="voter-insight__group-title">
            Vote History ({ins.turnout.voted}/{ins.turnout.eligible} = {pct(ins.turnout)})
          </div>
          <div className="voter-splits">
            <span>
              General <strong>{ins.splits.general.voted}/{ins.splits.general.eligible}</strong>
            </span>
            <span>
              Local (Odd-Year) <strong>{ins.splits.local.voted}/{ins.splits.local.eligible}</strong>
            </span>
            <span>
              Primaries <strong>{ins.splits.primary.eligible > 0 ? `${ins.splits.primary.voted}/${ins.splits.primary.eligible}` : `${ins.splits.primary.voted} · not counted`}</strong>
            </span>
          </div>
          <div className="vote-chips">
            {ins.elections.map((e) => {
              const state = e.voted ? 'voted' : e.eligible ? 'missed' : 'na';
              const title = `${KIND_LABEL[e.kind]} · ${e.voted ? `voted${e.method ? ` (${methodLabel(e.method)})` : ''}` : e.eligible ? 'did not vote' : 'not counted (not eligible / no primary for their party)'}`;
              return (
                <span key={e.code} className={`vote-chip vote-chip--${state}${e.kind === 'local' ? ' vote-chip--local' : ''}`} title={title}>
                  {e.code}
                </span>
              );
            })}
          </div>
          <div className="vote-chips__legend">
            <span className="vote-chip vote-chip--voted vote-chip--key">Voted</span>
            <span className="vote-chip vote-chip--missed vote-chip--key">Missed</span>
            <span className="vote-chip vote-chip--na vote-chip--key">Not Counted</span>
            <span className="vote-chips__legend-note">Underlined = local town election</span>
          </div>
        </>
      )}

      {ins && ins.insights.length > 0 && (
        <>
          <div className="voter-insight__group-title">Insights</div>
          <ul className="voter-insights">
            {ins.insights.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      )}

      {household.length > 0 && (
        <>
          <div className="voter-insight__group-title">Household</div>
          <div className="voter-household">
            {household.map((m) => (
              <Link key={m.contactId} to={`/contacts/${m.contactId}`} className="voter-household__row">
                <span className={`party-dot party-dot--${partyTone(m.partyCode)}`} aria-hidden />
                <span className="voter-household__text">
                  <span className="voter-household__name">
                    {m.name}
                    {m.personal && <span className="voter-household__tag">In Contacts</span>}
                  </span>
                  <span className="voter-household__meta">
                    {[m.party, m.age != null ? `Age ${m.age}` : null, turnoutText(m.turnout)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      <button type="button" className="voter-record__toggle" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? 'Hide' : 'Show'} All Imported Fields
      </button>
      {showRaw && (
        <div className="voter-record__raw">
          {Object.entries(raw)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="voter-record__raw-row">
                <span className="voter-record__raw-key">{k}</span>
                <span className="voter-record__raw-value">{v}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** The collapsed deep-dive. Header carries the at-a-glance numbers. */
export function VoterInsightSection({ records, household }: { records: VoterRecord[]; household: HouseholdMember[] }) {
  const [open, setOpen] = useState(false);
  if (records.length === 0) return null;
  const ins: VoterInsight | undefined = records[0].insight;
  return (
    <div className="voter-insight">
      <button type="button" className="voter-insight__header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="contact-detail__section-title voter-insight__title">Voter Insight</span>
        <span className="voter-insight__summary">
          {ins && ins.turnout.eligible > 0 && (
            <span className="voter-insight__stat">
              Turnout <strong>{pct(ins.turnout)}</strong> ({ins.turnout.voted}/{ins.turnout.eligible})
            </span>
          )}
          {ins?.lastVoted && (
            <span className="voter-insight__stat">
              Last Voted <strong>{ins.lastVoted}</strong>
            </span>
          )}
          {records[0].calculated_party && <span className="voter-insight__stat">{records[0].calculated_party}</span>}
        </span>
        <span className="voter-insight__caret">{open ? '▾' : '▸'}</span>
      </button>
      {!open && ins?.insights[0] && <p className="contact-detail__section-hint voter-insight__hint">{ins.insights[0]}</p>}
      {open &&
        records.map((r, i) => (
          <div key={r.id} className="voter-insight__card">
            {records.length > 1 && <div className="voter-insight__multi">Voter Record {i + 1} of {records.length}</div>}
            <VoterRecordInsight r={r} household={i === 0 ? household : []} />
          </div>
        ))}
    </div>
  );
}
