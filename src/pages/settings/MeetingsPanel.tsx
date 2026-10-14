import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { MeetingSeries, PersonRef, ProjectListItem } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { ContactPicker } from '../../components/ContactPicker';
import { RealmChip, RealmToggle } from '../../components/RealmSwitch';
import { copyText } from '../../utils/clipboard';

/** Settings → Meetings: meetings Mike enters by hand (his Birches calendar
 * can't be connected). Recurring ones are set up once; one-offs too. People
 * come from Contacts so meeting prep can show what's open with each of
 * them. Occurrences show up on Today / Week / Month like any calendar. */

type Repeat = 'none' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly-weekday' | 'monthly-date' | 'custom';
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const DAY_LABEL: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const DAY_LONG: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const ORD = ['', '1st', '2nd', '3rd', '4th'];

interface Form {
  id: string | null;
  title: string;
  realm: 'personal' | 'work';
  startDate: string;
  allDay: boolean;
  startTime: string;
  durationMin: number;
  repeat: Repeat;
  days: string[];
  custom: string;
  ends: 'never' | 'on';
  untilDate: string;
  people: PersonRef[];
  projectId: string;
  link: string;
  /** Documents (Google Doc links) kept on the series — every occurrence
   * shows them in the meeting sheet and on Today's row. `id` = saved row. */
  docs: FormDoc[];
  location: string;
  description: string;
  active: boolean;
  skipDates: string[];
}

interface FormDoc {
  id?: string;
  url: string;
  title: string;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayCodeOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return DAYS[(new Date(y, m - 1, d).getDay() + 6) % 7];
}
function nthOf(iso: string): number {
  const d = Number(iso.split('-')[2]);
  const n = Math.ceil(d / 7);
  return n >= 5 ? -1 : n;
}

function blank(): Form {
  const start = todayISO();
  return {
    id: null,
    title: '',
    realm: 'work',
    startDate: start,
    allDay: false,
    startTime: '10:00',
    durationMin: 30,
    repeat: 'weekly',
    days: [dayCodeOf(start)],
    custom: '',
    ends: 'never',
    untilDate: '',
    people: [],
    projectId: '',
    link: '',
    docs: [{ url: '', title: '' }],
    location: '',
    description: '',
    active: true,
    skipDates: [],
  };
}

function rruleFor(f: Form): string | null {
  const days = (f.days.length ? f.days : [dayCodeOf(f.startDate)]).join(',');
  switch (f.repeat) {
    case 'none':
      return null;
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${days}`;
    case 'biweekly':
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${days}`;
    case 'monthly-weekday':
      return `FREQ=MONTHLY;BYDAY=${nthOf(f.startDate)}${dayCodeOf(f.startDate)}`;
    case 'monthly-date':
      return `FREQ=MONTHLY;BYMONTHDAY=${Number(f.startDate.split('-')[2])}`;
    case 'custom':
      return f.custom.trim().replace(/^RRULE:/i, '') || null;
  }
}

function formFrom(s: MeetingSeries): Form {
  const r = s.rrule ?? '';
  const byday = /BYDAY=([A-Z,]+)/.exec(r)?.[1]?.split(',') ?? [];
  let repeat: Repeat = 'custom';
  if (!r) repeat = 'none';
  else if (r === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') repeat = 'weekdays';
  else if (/^FREQ=WEEKLY;BYDAY=[A-Z,]+$/.test(r)) repeat = 'weekly';
  else if (/^FREQ=WEEKLY;INTERVAL=2;BYDAY=[A-Z,]+$/.test(r)) repeat = 'biweekly';
  else if (/^FREQ=MONTHLY;BYDAY=-?\d[A-Z]{2}$/.test(r)) repeat = 'monthly-weekday';
  else if (/^FREQ=MONTHLY;BYMONTHDAY=\d+$/.test(r)) repeat = 'monthly-date';
  return {
    id: s.id,
    title: s.title,
    realm: s.realm,
    startDate: s.startDate,
    allDay: !s.startTime,
    startTime: s.startTime ?? '10:00',
    durationMin: s.durationMin,
    repeat,
    days: byday.filter((d) => (DAYS as readonly string[]).includes(d)),
    custom: repeat === 'custom' ? r : '',
    ends: s.untilDate ? 'on' : 'never',
    untilDate: s.untilDate ?? '',
    people: s.people.map((p) => ({ id: p.id, name: p.name })),
    projectId: s.projectId ?? '',
    link: s.link ?? '',
    docs: [],
    location: s.location ?? '',
    description: s.description ?? '',
    active: s.active,
    skipDates: s.skipDates,
  };
}

function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function describeSeries(s: Pick<MeetingSeries, 'rrule' | 'startDate' | 'startTime' | 'durationMin' | 'untilDate'>): string {
  const r = s.rrule ?? '';
  const when = s.startTime ? `${fmtTime(s.startTime)} · ${s.durationMin} min` : 'All Day';
  const byday = (/BYDAY=([A-Z,0-9-]+)/.exec(r)?.[1] ?? '').split(',').filter(Boolean);
  const plural = (codes: string[]) => codes.map((c) => DAY_LONG[c] + 's').join(', ');
  let rep: string;
  if (!r) rep = fmtDate(s.startDate);
  else if (r === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') rep = 'Every Weekday';
  else if (/INTERVAL=2/.test(r) && /FREQ=WEEKLY/.test(r)) rep = `Every Other ${byday.map((c) => DAY_LONG[c]).join(', ')}`;
  else if (/FREQ=WEEKLY/.test(r)) rep = plural(byday);
  else if (/FREQ=MONTHLY;BYDAY=/.test(r)) {
    const m = /^(-?\d)([A-Z]{2})$/.exec(byday[0] ?? '');
    rep = m ? `Monthly, ${m[1] === '-1' ? 'Last' : ORD[Number(m[1])]} ${DAY_LONG[m[2]]}` : 'Monthly';
  } else if (/BYMONTHDAY=(\d+)/.test(r)) rep = `Monthly on the ${/BYMONTHDAY=(\d+)/.exec(r)![1]}`;
  else rep = r;
  return `${rep} · ${when}${s.untilDate ? ` · until ${fmtDate(s.untilDate)}` : ''}`;
}

export function MeetingsPanel() {
  const [params, setParams] = useSearchParams();
  const [series, setSeries] = useState<MeetingSeries[] | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<MeetingSeries | null>(null);
  const [myNames, setMyNames] = useState('');
  const [workLabel, setWorkLabel] = useState('');
  const [peopleCopied, setPeopleCopied] = useState<string | null>(null);
  const [noteTemplate, setNoteTemplate] = useState(true);
  const [noteTip, setNoteTip] = useState(true);
  const [namesSaved, setNamesSaved] = useState(false);
  const [docsLoaded, setDocsLoaded] = useState<FormDoc[]>([]);
  const formId = form?.id;
  // Editing a series → load its saved documents into the form (empty row if none).
  useEffect(() => {
    setDocsLoaded([]);
    if (!formId) return;
    let live = true;
    api
      .listMeetingDocs(`ms-${formId}`)
      .then(({ docs }) => {
        if (!live) return;
        const rows = docs.map((d) => ({ id: d.id, url: d.url, title: d.title }));
        setDocsLoaded(rows);
        setForm((f) => (f && f.id === formId ? { ...f, docs: rows.length ? rows : [{ url: '', title: '' }] } : f));
      })
      .catch(() => setForm((f) => (f && f.id === formId ? { ...f, docs: [{ url: '', title: '' }] } : f)));
    return () => {
      live = false;
    };
  }, [formId]);

  function load() {
    api
      .listMeetingSeries()
      .then((r) => setSeries(r.series))
      .catch((e) => setError(String(e)));
  }
  useEffect(() => {
    load();
    api.listProjects(false, true).then(setProjects).catch(() => setProjects([]));
    api
      .getWorkSettings()
      .then((s) => (setMyNames(s.myNames), setWorkLabel(s.workLabel), setNoteTemplate(s.noteTemplate), setNoteTip(s.noteTip)))
      .catch(() => undefined);
  }, []);

  // Deep link from Today's "+ Add" (a one-off on that day).
  const newOn = params.get('new');
  useEffect(() => {
    if (!newOn || !/^\d{4}-\d{2}-\d{2}$/.test(newOn)) return;
    setForm({ ...blank(), startDate: newOn, repeat: 'none', days: [dayCodeOf(newOn)] });
    params.delete('new');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOn]);

  // Deep link from a meeting's "Edit Meeting" button.
  const wanted = params.get('series');
  useEffect(() => {
    if (!wanted || !series) return;
    const s = series.find((x) => x.id === wanted);
    if (s) setForm(formFrom(s));
    params.delete('series');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, series]);

  async function save() {
    if (!form) return;
    if (!form.title.trim()) return setError('Give the meeting a name.');
    setSaving(true);
    setError(null);
    const body = {
      title: form.title.trim(),
      realm: form.realm,
      startDate: form.startDate,
      startTime: form.allDay ? null : form.startTime,
      durationMin: form.durationMin,
      rrule: rruleFor(form),
      untilDate: form.repeat !== 'none' && form.ends === 'on' && form.untilDate ? form.untilDate : null,
      peopleIds: form.people.map((p) => p.id),
      projectId: form.projectId || null,
      link: form.link.trim() || null,
      location: form.location.trim() || null,
      description: form.description.trim() || null,
      active: form.active,
      skipDates: form.skipDates,
    };
    try {
      const saved = form.id ? await api.updateMeetingSeries(form.id, body) : await api.createMeetingSeries(body);
      await saveDocs(`ms-${saved.id}`, form.docs, docsLoaded);
      setForm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+: /, '').replace(/^\{"error":"(.*)"\}$/, '$1') : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Documents: compare with what was loaded, then add / update / remove.
  async function saveDocs(seriesKey: string, docs: FormDoc[], before: FormDoc[]) {
    const keep = docs.filter((d) => d.url.trim());
    const keptIds = new Set(keep.map((d) => d.id).filter(Boolean));
    for (const d of before) if (d.id && !keptIds.has(d.id)) await api.deleteMeetingDoc(d.id);
    for (const d of keep) {
      if (!d.id) await api.addMeetingDoc(seriesKey, d.url.trim(), d.title.trim());
      else {
        const was = before.find((b) => b.id === d.id);
        if (!was || was.url !== d.url.trim() || was.title !== d.title.trim()) await api.updateMeetingDoc(d.id, { url: d.url.trim(), title: d.title.trim() });
      }
    }
  }

  async function saveNoteSetting(patch: { noteTemplate?: boolean; noteTip?: boolean }) {
    const r = await api.updateWorkSettings(patch);
    setNoteTemplate(r.noteTemplate);
    setNoteTip(r.noteTip);
  }

  async function saveNames() {
    const r = await api.updateWorkSettings({ myNames, workLabel });
    setMyNames(r.myNames);
    setWorkLabel(r.workLabel);
    setNamesSaved(true);
    window.setTimeout(() => setNamesSaved(false), 1500);
  }

  const groups = useMemo(() => {
    const list = series ?? [];
    return { active: list.filter((s) => s.active), paused: list.filter((s) => !s.active) };
  }, [series]);
  const sortedProjects = useMemo(() => [...projects].sort((a, b) => Number(b.realm === 'work') - Number(a.realm === 'work') || a.title.localeCompare(b.title)), [projects]);

  function row(s: MeetingSeries) {
    return (
      <div key={s.id} className={`settings-page__calendar-row${s.active ? '' : ' is-inactive'}`}>
        <div className="settings-page__calendar-main" onClick={() => setForm(formFrom(s))}>
          <div className="settings-page__calendar-label">
            {s.title} <RealmChip realm={s.realm} always />
          </div>
          <div className="settings-page__calendar-meta">{describeSeries(s)}</div>
          {(s.people.length > 0 || s.projectTitle) && (
            <div className="settings-page__calendar-meta">
              {s.people.map((p) => p.name).join(', ')}
              {s.people.length > 0 && s.projectTitle ? ' · ' : ''}
              {s.projectTitle ? `Tasks → ${s.projectTitle}` : ''}
            </div>
          )}
        </div>
        <button type="button" className="settings-page__recurring-delete" title="Delete" onClick={() => setDeleting(s)}>
          ✕
        </button>
      </div>
    );
  }

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Meetings</h2>
        <button className="btn" onClick={() => (setError(null), setForm(blank()))}>
          + Add Meeting
        </button>
      </div>
      <p className="settings-page__section-hint">
        Meetings you add here show on Today, Week and Month next to your Google calendars. Add the people from Contacts so each meeting's prep shows what you owe them, what
        you're waiting on, and last time's notes. Set up a recurring meeting once; one-offs work the same way.
      </p>
      {error && !form && <div className="settings-page__rrule-error">{error}</div>}

      {series === null ? (
        <div className="empty-state">Loading…</div>
      ) : series.length === 0 ? (
        <div className="empty-state">No meetings yet — add your first recurring one (e.g. your weekly 1:1).</div>
      ) : (
        <>
          <div className="settings-page__calendar-list card">{groups.active.map(row)}</div>
          {groups.paused.length > 0 && (
            <>
              <div className="settings-page__field-label">Paused</div>
              <div className="settings-page__calendar-list card">{groups.paused.map(row)}</div>
            </>
          )}
        </>
      )}

      <div className="mtg-settings__names card">
        <div className="settings-page__field-label">Your Name In Meeting Notes</div>
        <p className="settings-page__section-hint">How you appear in Gemini's notes, comma-separated — next steps assigned to any of these become your tasks.</p>
        <div className="mtg-settings__names-row">
          <input value={myNames} onChange={(e) => setMyNames(e.target.value)} placeholder="Mike Palladino, Mike" />
        </div>
        <div className="settings-page__field-label" style={{ marginTop: 12 }}>
          Work Contacts Label
        </div>
        <p className="settings-page__section-hint">Contacts with this Google Contacts label count as Work. Contacts you add in Work mode get it automatically.</p>
        <div className="mtg-settings__names-row">
          <input value={workLabel} onChange={(e) => setWorkLabel(e.target.value)} placeholder="Birches" />
          <button type="button" className="btn btn--ghost" onClick={saveNames}>
            {namesSaved ? 'Saved' : 'Save'}
          </button>
        </div>
        <div className="settings-page__field-label" style={{ marginTop: 12 }}>
          Meeting Notes
        </div>
        <p className="settings-page__section-hint">
          A new 📝 note on a meeting starts with Notes / Decisions / Next Steps and a "Name will …" line per person. Nothing in it is turned into to-dos automatically — highlight any text to make it a task, waiting item, project,
          list item, jot, link, or something to raise with a person.
        </p>
        <label className="mtg-settings__check">
          <input type="checkbox" checked={noteTemplate} onChange={(e) => saveNoteSetting({ noteTemplate: e.target.checked })} /> Start Meeting Notes From the Template
        </label>
        <label className="mtg-settings__check">
          <input type="checkbox" checked={noteTip} disabled={!noteTemplate} onChange={(e) => saveNoteSetting({ noteTip: e.target.checked })} /> Show the Tip Line at the Top
        </label>
        <div className="settings-page__field-label" style={{ marginTop: 12 }}>
          Work Claude Project
        </div>
        <p className="settings-page__section-hint">
          Briefs from your work Claude go in with 📋 Paste Brief on Today (or Add Meeting Notes on a meeting). Copy your Work contacts as a table for the project's People knowledge — Notes holds the latest things learned from briefs.
        </p>
        <div className="mtg-settings__names-row">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={async () => {
              const r = await api.getWorkPeopleTable();
              if (await copyText(r.markdown)) {
                setPeopleCopied(`Copied ${r.count} people ✓`);
                window.setTimeout(() => setPeopleCopied(null), 2200);
              }
            }}
          >
            {peopleCopied ?? '📋 Copy People Table'}
          </button>
        </div>
      </div>

      {form && (
        <Modal title={form.id ? 'Edit Meeting' : 'Add Meeting'} onClose={() => setForm(null)} className="mtg-form-modal">
          <div className="mtg-form">
            <input autoFocus placeholder="Meeting name (e.g. 1:1 with Sarah)" value={form.title} onChange={(e) => set({ title: e.target.value })} />
            <RealmToggle value={form.realm} onChange={(realm) => set({ realm })} />

            <div className="mtg-form__grid">
              <label>
                <span className="settings-page__field-label">{form.repeat === 'none' ? 'Date' : 'First Date'}</span>
                <input type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value, days: form.repeat === 'weekly' || form.repeat === 'biweekly' ? (form.days.length <= 1 ? [dayCodeOf(e.target.value)] : form.days) : form.days })} />
              </label>
              {!form.allDay && (
                <>
                  <label>
                    <span className="settings-page__field-label">Time</span>
                    <input type="time" step={300} value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} />
                  </label>
                  <label>
                    <span className="settings-page__field-label">Length</span>
                    <select value={form.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })}>
                      {[15, 20, 25, 30, 45, 50, 60, 75, 90, 120, 180].map((n) => (
                        <option key={n} value={n}>
                          {n < 60 ? `${n} min` : `${n / 60} hr${n === 60 ? '' : 's'}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            <label className="mtg-form__check">
              <input type="checkbox" checked={form.allDay} onChange={(e) => set({ allDay: e.target.checked })} /> All Day
            </label>

            <label>
              <span className="settings-page__field-label">Repeats</span>
              <select value={form.repeat} onChange={(e) => set({ repeat: e.target.value as Repeat, days: form.days.length ? form.days : [dayCodeOf(form.startDate)] })}>
                <option value="none">Doesn't Repeat</option>
                <option value="weekdays">Every Weekday</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every Other Week</option>
                <option value="monthly-weekday">
                  Monthly ({nthOf(form.startDate) === -1 ? 'Last' : ORD[nthOf(form.startDate)]} {DAY_LONG[dayCodeOf(form.startDate)]})
                </option>
                <option value="monthly-date">Monthly (on the {Number(form.startDate.split('-')[2])})</option>
                <option value="custom">Custom (RRULE)</option>
              </select>
            </label>
            {(form.repeat === 'weekly' || form.repeat === 'biweekly') && (
              <div className="mtg-form__days">
                {DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`mtg-form__day${form.days.includes(d) ? ' is-on' : ''}`}
                    onClick={() => set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d] })}
                  >
                    {DAY_LABEL[d]}
                  </button>
                ))}
              </div>
            )}
            {form.repeat === 'custom' && <input placeholder="FREQ=WEEKLY;INTERVAL=3;BYDAY=TH" value={form.custom} onChange={(e) => set({ custom: e.target.value })} />}
            {form.repeat !== 'none' && (
              <div className="mtg-form__grid">
                <label>
                  <span className="settings-page__field-label">Ends</span>
                  <select value={form.ends} onChange={(e) => set({ ends: e.target.value as Form['ends'] })}>
                    <option value="never">Never</option>
                    <option value="on">On a Date</option>
                  </select>
                </label>
                {form.ends === 'on' && (
                  <label>
                    <span className="settings-page__field-label">Last Date</span>
                    <input type="date" value={form.untilDate} min={form.startDate} onChange={(e) => set({ untilDate: e.target.value })} />
                  </label>
                )}
              </div>
            )}

            <div>
              <span className="settings-page__field-label">People</span>
              <ContactPicker value={form.people} onChange={(people) => set({ people })} newRealm={form.realm} scope={form.realm === 'work' ? 'work' : 'all'} placeholder="Search Contacts or type a new name…" />
            </div>

            <label>
              <span className="settings-page__field-label">Project (Tasks From Its Notes Go Here)</span>
              <select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })}>
                <option value="">None — standalone tasks</option>
                {sortedProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.realm === 'work' ? ' (Work)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <div className="mtg-form__grid">
              <label>
                <span className="settings-page__field-label">Video Link</span>
                <input placeholder="https://meet.google.com/…" value={form.link} onChange={(e) => set({ link: e.target.value })} />
              </label>
              <label>
                <span className="settings-page__field-label">Location</span>
                <input placeholder="Room / address" value={form.location} onChange={(e) => set({ location: e.target.value })} />
              </label>
            </div>
            <div>
              <span className="settings-page__field-label">Documents</span>
              <div className="mtg-form__docs">
                {form.docs.map((d, i) => (
                  <div key={d.id ?? `new-${i}`} className="mtg-form__doc">
                    <input
                      className="mtg-form__doc-url"
                      type="url"
                      inputMode="url"
                      placeholder="Paste a link — https://docs.google.com/document/d/…"
                      value={d.url}
                      onChange={(e) => set({ docs: form.docs.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })}
                    />
                    <input
                      className="mtg-form__doc-title"
                      placeholder="Name (optional)"
                      value={d.title}
                      onChange={(e) => set({ docs: form.docs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                    />
                    <button type="button" className="btn btn--ghost btn--sm" title="Remove" onClick={() => set({ docs: form.docs.length > 1 ? form.docs.filter((_, j) => j !== i) : [{ url: '', title: '' }] })}>
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn--ghost btn--sm mtg-form__doc-add" onClick={() => set({ docs: [...form.docs, { url: '', title: '' }] })}>
                  + Add Another Document
                </button>
              </div>
            </div>

            <label>
              <span className="settings-page__field-label">Notes</span>
              <textarea rows={2} value={form.description} placeholder="What this meeting is for" onChange={(e) => set({ description: e.target.value })} />
            </label>

            {form.skipDates.length > 0 && (
              <div>
                <span className="settings-page__field-label">Skipped</span>
                <div className="mtg-form__skips">
                  {form.skipDates.map((d) => (
                    <span key={d} className="contact-picker__chip">
                      {fmtDate(d)}
                      <button type="button" title="Restore" onClick={() => set({ skipDates: form.skipDates.filter((x) => x !== d) })}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {form.id && (
              <label className="mtg-form__check">
                <input type="checkbox" checked={!form.active} onChange={(e) => set({ active: !e.target.checked })} /> Paused (hidden from the calendar)
              </label>
            )}

            {form.title && (
              <div className="settings-page__section-hint">
                {describeSeries({ rrule: rruleFor(form), startDate: form.startDate, startTime: form.allDay ? null : form.startTime, durationMin: form.durationMin, untilDate: form.ends === 'on' ? form.untilDate || null : null })}
              </div>
            )}
            {error && <div className="settings-page__rrule-error">{error}</div>}
          </div>
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : form.id ? 'Save' : 'Add Meeting'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete Meeting"
          body={`Delete "${deleting.title}"? It comes off the calendar. Notes, summaries and tasks from past meetings stay.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteMeetingSeries(deleting.id);
            setDeleting(null);
            load();
          }}
        />
      )}
    </div>
  );
}
