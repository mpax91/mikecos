import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Contact, ContactCircle, ContactDetail, ContactNote, VoterHistoryEntry, VoterRecord } from '../api/types';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { useReportTabMeta } from '../contexts/TabsContext';

const CIRCLES: { value: ContactCircle; label: string }[] = [
  { value: 'family', label: 'Family' },
  { value: 'friends', label: 'Friends' },
  { value: 'neighbors', label: 'Neighbors' },
  { value: 'community', label: 'Community' },
  { value: 'professional', label: 'Professional' },
  { value: 'other', label: 'Other' },
];

function circleLabel(circle: ContactCircle): string {
  return CIRCLES.find((c) => c.value === circle)?.label ?? 'Other';
}

function formatDate(month: number | null, day: number | null, year: number | null): string | null {
  if (!month || !day) return null;
  const monthName = new Date(2000, month - 1, 1).toLocaleString(undefined, { month: 'long' });
  return year ? `${monthName} ${day}, ${year}` : `${monthName} ${day}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function EditDetailsModal({ contact, onSave, onClose }: { contact: ContactDetail; onSave: (patch: Record<string, unknown>) => void; onClose: () => void }) {
  const emails = JSON.parse(contact.emails || '[]') as string[];
  const phones = JSON.parse(contact.phones || '[]') as string[];
  const [name, setName] = useState(contact.name);
  const [circle, setCircle] = useState<ContactCircle>(contact.circle);
  const [company, setCompany] = useState(contact.company ?? '');
  const [title, setTitle] = useState(contact.title ?? '');
  const [emailsText, setEmailsText] = useState(emails.join(', '));
  const [phonesText, setPhonesText] = useState(phones.join(', '));
  const [address, setAddress] = useState(contact.address ?? '');
  const [bMonth, setBMonth] = useState(contact.birthday_month?.toString() ?? '');
  const [bDay, setBDay] = useState(contact.birthday_day?.toString() ?? '');
  const [bYear, setBYear] = useState(contact.birthday_year?.toString() ?? '');
  const [aMonth, setAMonth] = useState(contact.anniversary_month?.toString() ?? '');
  const [aDay, setADay] = useState(contact.anniversary_day?.toString() ?? '');
  const [aYear, setAYear] = useState(contact.anniversary_year?.toString() ?? '');

  function num(s: string): number | null {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function commit() {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      circle,
      company: company.trim() || null,
      title: title.trim() || null,
      emails: emailsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      phones: phonesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      address: address.trim() || null,
      birthday_month: num(bMonth),
      birthday_day: num(bDay),
      birthday_year: num(bYear),
      anniversary_month: num(aMonth),
      anniversary_day: num(aDay),
      anniversary_year: num(aYear),
    });
    onClose();
  }

  return (
    <Modal title="Edit Contact" onClose={onClose}>
      <div className="contact-edit-form">
        <input autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={circle} onChange={(e) => setCircle(e.target.value as ContactCircle)}>
          {CIRCLES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} />
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="Emails (comma separated)" value={emailsText} onChange={(e) => setEmailsText(e.target.value)} />
        <input placeholder="Phones (comma separated)" value={phonesText} onChange={(e) => setPhonesText(e.target.value)} />
        <input placeholder="Address" value={address} onChange={(e) => setAddress(e.target.value)} />

        <label className="contact-edit-form__label">Birthday</label>
        <div className="contact-edit-form__date-row">
          <input placeholder="Month" inputMode="numeric" value={bMonth} onChange={(e) => setBMonth(e.target.value)} />
          <input placeholder="Day" inputMode="numeric" value={bDay} onChange={(e) => setBDay(e.target.value)} />
          <input placeholder="Year (optional)" inputMode="numeric" value={bYear} onChange={(e) => setBYear(e.target.value)} />
        </div>

        <label className="contact-edit-form__label">Anniversary</label>
        <div className="contact-edit-form__date-row">
          <input placeholder="Month" inputMode="numeric" value={aMonth} onChange={(e) => setAMonth(e.target.value)} />
          <input placeholder="Day" inputMode="numeric" value={aDay} onChange={(e) => setADay(e.target.value)} />
          <input placeholder="Year (optional)" inputMode="numeric" value={aYear} onChange={(e) => setAYear(e.target.value)} />
        </div>
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={commit} disabled={!name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

/** The voter-file data blended into this contact — kept in its own
 * section, visually separate from the personal info Mike maintains
 * himself (see migrations/0018_contact_import.sql). `raw_data` is shown
 * as a collapsible "all imported fields" list so whatever columns a
 * given voter file happens to have — even ones we don't parse into a
 * dedicated field — are still there to look up, not silently dropped.
 *
 * Collapsed by default: personal contact info is the primary thing this
 * card is about, and voter data — even when it's there — is secondary
 * reference material, not something that should compete with it for
 * attention the moment the page loads. */
function VoterRecordSection({ records }: { records: VoterRecord[] }) {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  if (records.length === 0) return null;

  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="voter-record-section">
      {/* Collapsed by default with just the party affiliation visible —
          Mike's call after comparing this against the Bedford Voter
          Intelligence app's much richer (but always-expanded) card: this
          data is useful to have but not something he wants taking up
          space on every voter-sourced contact by default. */}
      <button
        type="button"
        className="voter-record-section__header"
        onClick={() => setSectionOpen((v) => !v)}
        aria-expanded={sectionOpen}
      >
        <span className="contact-detail__section-title voter-record-section__title">
          Voter Record
          {records[0]?.party && <span className="chip chip--accent voter-record-section__party">{records[0].party}</span>}
        </span>
        <span className="voter-record-section__caret">{sectionOpen ? '▾' : '▸'}</span>
      </button>

      {!sectionOpen && (
        <p className="contact-detail__section-hint voter-record-section__hint">
          From the Bedford voter file — click to view registration, address, and voting history.
        </p>
      )}

      {sectionOpen &&
      records.map((r) => {
        const history = r.voting_history ? (JSON.parse(r.voting_history) as VoterHistoryEntry[]) : [];
        const voted = history.filter((h) => !h.code.toUpperCase().startsWith('VOTE METHOD'));
        const raw = JSON.parse(r.raw_data) as Record<string, string>;
        const isOpen = openIds.has(r.id);
        // Raw values already carry their own prefix ("CD-17", not "17") —
        // don't re-prefix, or it doubles up as "CD-CD-17".
        const districts = [r.cd, r.sd, r.ad, r.ld].filter(Boolean);
        return (
          <div key={r.id} className="voter-record">
            <div className="voter-record__group">
              <div className="voter-record__group-title">Profile</div>
              <div className="voter-record__grid">
                {r.voter_age != null && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Age</span> {r.voter_age}
                  </div>
                )}
                {r.gender && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Gender</span> {r.gender}
                  </div>
                )}
                {r.registered_date && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Registered</span> {r.registered_date}
                  </div>
                )}
              </div>
            </div>

            {(r.phone || r.polling_place) && (
              <div className="voter-record__group">
                <div className="voter-record__group-title">Contact &amp; Polling</div>
                {r.phone && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Phone</span> {r.phone}
                  </div>
                )}
                {r.polling_place && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Polling Place</span> {r.polling_place}
                  </div>
                )}
              </div>
            )}

            {(r.party || r.calculated_party || r.household_party || r.causeway_tag || r.gop_matrix) && (
              <div className="voter-record__group">
                <div className="voter-record__group-title">Political Profile</div>
                <div className="voter-record__grid">
                  {r.party && (
                    <div className="voter-record__field">
                      <span className="voter-record__field-label">Registration</span> {r.party}
                    </div>
                  )}
                  {r.calculated_party && (
                    <div className="voter-record__field">
                      <span className="voter-record__field-label">Calculated</span> {r.calculated_party}
                    </div>
                  )}
                </div>
                {r.household_party && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Household Party</span> {r.household_party}
                  </div>
                )}
                {r.causeway_tag && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">Causeway Tag</span> {r.causeway_tag}
                  </div>
                )}
                {r.gop_matrix && (
                  <div className="voter-record__field">
                    <span className="voter-record__field-label">GOP Matrix</span> {r.gop_matrix}
                  </div>
                )}
              </div>
            )}

            {districts.length > 0 && (
              <div className="voter-record__field">
                <span className="voter-record__field-label">Districts</span> {districts.join(' · ')}
              </div>
            )}

            {voted.length > 0 && (
              <div className="voter-record__field">
                <span className="voter-record__field-label">Voting History ({voted.length})</span>
                <div className="voter-record__history">
                  {voted.map((h) => (
                    <span key={h.code} className="chip" title={h.value !== h.code ? h.value : undefined}>
                      {h.code}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <button type="button" className="voter-record__toggle" onClick={() => toggle(r.id)}>
              {isOpen ? 'Hide' : 'Show'} all imported fields
            </button>

            {isOpen && (
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
      })}
    </div>
  );
}

/** Manual duplicate cleanup — for the pairs the import matcher's automatic
 * name/nickname rules still can't catch (a misspelling, a nickname it
 * doesn't know). Search picks the OTHER contact; that one gets folded into
 * the contact you're currently viewing (additive-only) and deleted. */
function MergeDuplicateModal({
  currentContact,
  onMerge,
  onClose,
}: {
  currentContact: ContactDetail;
  onMerge: (mergeFromId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Contact | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      api
        .listContacts({ q: query, includeVoters: true })
        .then((r) => setResults(r.filter((c) => c.id !== currentContact.id)))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, currentContact.id]);

  return (
    <Modal title={`Merge a Duplicate into "${currentContact.name}"`} onClose={onClose}>
      {!selected ? (
        <>
          <p className="contact-detail__section-hint" style={{ marginTop: 0 }}>
            Search for the duplicate contact — it'll be folded into "{currentContact.name}" (filling in anything
            blank, keeping everything already here) and then removed.
          </p>
          <input autoFocus placeholder="Search contacts and the voter roll…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {searching && <div className="empty-state empty-state--section">Searching…</div>}
          {!searching && query.trim() && results.length === 0 && <div className="empty-state empty-state--section">No matches.</div>}
          {results.length > 0 && (
            <div className="contact-import__review-list" style={{ marginTop: 12 }}>
              {results.slice(0, 20).map((c) => (
                <button key={c.id} type="button" className="contact-import__review-row" style={{ cursor: 'pointer', width: '100%', textAlign: 'left' }} onClick={() => setSelected(c)}>
                  <strong>{c.name}</strong>
                  <span className="contact-import__review-hint"> {circleLabel(c.circle)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <p>
          Merge <strong>{selected.name}</strong> into <strong>{currentContact.name}</strong>? "{selected.name}" will be
          removed; anything it has that "{currentContact.name}" doesn't (emails, phone, address, birthday, voter
          record) will move over.
        </p>
      )}
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={selected ? () => setSelected(null) : onClose}>
          {selected ? 'Back' : 'Cancel'}
        </button>
        {selected && (
          <button className="btn" onClick={() => onMerge(selected.id)}>
            Merge
          </button>
        )}
      </div>
    </Modal>
  );
}

function NoteRow({ note, onResolve, onDelete }: { note: ContactNote; onResolve: (resolved: boolean) => void; onDelete: () => void }) {
  const hasReminder = !!note.remind_at && !note.remind_resolved;
  return (
    <div className="contact-note">
      <div className="contact-note__body">
        <div className="contact-note__text">{note.text}</div>
        <div className="contact-note__meta">
          <span className="last-modified-badge">{formatRelativeTime(note.created_at)}</span>
          {hasReminder && (
            <span className="contact-note__reminder">
              🔔 check in {new Date(note.remind_at as string).toLocaleDateString()}
              <button type="button" className="contact-note__reminder-done" onClick={() => onResolve(true)}>
                Done
              </button>
            </span>
          )}
        </div>
      </div>
      <button type="button" className="contact-note__delete" title="Delete note" onClick={onDelete}>
        ✕
      </button>
    </div>
  );
}

/** A contact's detail page. The structured fields (phone, email, address,
 * birthday, etc.) read like a normal phone/address-book contact card —
 * an avatar, then one row per field, each a tap-to-act link (call, email,
 * map) — same as Google/Apple/Samsung contacts, not squeezed into a
 * summary line. They're still edited via one modal rather than a dozen
 * inline fields (see migrations/0017_contacts.sql for the data shape).
 * Below that card sits the note feed — quick, unstructured jots, kept as
 * its own clearly-labeled section rather than competing with the card for
 * attention. */
export function ContactDetailPage() {
  const { id } = useParams();
  const contactId = id!;
  const navigate = useNavigate();
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [remindMe, setRemindMe] = useState(false);

  useReportTabMeta(contact?.name, 'contact');

  function load() {
    api.getContact(contactId).then(setContact).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function handleSaveDetails(patch: Record<string, unknown>) {
    const updated = await api.updateContact(contactId, patch);
    setContact((prev) => (prev ? { ...prev, ...updated } : prev));
  }

  async function handleTogglePin() {
    if (!contact) return;
    const next = contact.pinned === 1 ? false : true;
    await api.setContactPinned(contactId, next);
    setContact((prev) => (prev ? { ...prev, pinned: next ? 1 : 0 } : prev));
  }

  async function handleDelete() {
    await api.deleteContact(contactId);
    navigate('/contacts');
  }

  async function handleMerge(mergeFromId: string) {
    const merged = await api.mergeContact(contactId, mergeFromId);
    setMerging(false);
    setContact((prev) => (prev ? { ...prev, ...merged } : prev));
    load(); // notes/voterRecords moved over by the merge — refetch to pick them up
  }

  async function handleAddNote() {
    const text = noteDraft.trim();
    if (!text) return;
    const note = await api.addContactNote(contactId, text, remindMe ? 14 : undefined);
    setContact((prev) => (prev ? { ...prev, notes: [note, ...prev.notes] } : prev));
    setNoteDraft('');
    setRemindMe(false);
  }

  async function handleResolveReminder(note: ContactNote, resolved: boolean) {
    setContact((prev) =>
      prev ? { ...prev, notes: prev.notes.map((n) => (n.id === note.id ? { ...n, remind_resolved: resolved ? 1 : 0 } : n)) } : prev
    );
    await api.resolveContactNoteReminder(contactId, note.id, resolved);
  }

  async function handleDeleteNote(note: ContactNote) {
    setContact((prev) => (prev ? { ...prev, notes: prev.notes.filter((n) => n.id !== note.id) } : prev));
    await api.deleteContactNote(contactId, note.id);
  }

  if (error) return <div className="empty-state">Couldn't load this contact: {error}</div>;
  if (!contact) return <div className="empty-state">Loading…</div>;

  const emails = JSON.parse(contact.emails || '[]') as string[];
  const phones = JSON.parse(contact.phones || '[]') as string[];
  const birthday = formatDate(contact.birthday_month, contact.birthday_day, contact.birthday_year);
  const anniversary = formatDate(contact.anniversary_month, contact.anniversary_day, contact.anniversary_year);
  const isPinned = contact.pinned === 1;

  return (
    <div className="contact-detail">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/contacts')} title="Back to Contacts" aria-label="Back to Contacts">
          ‹
        </button>
        <Link to="/contacts" className="breadcrumb__link">
          Contacts
        </Link>
      </div>

      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          {contact.name}
          {isPinned && (
            <span className="entity-card__pin" title="Pinned" style={{ marginLeft: 8 }}>
              📌
            </span>
          )}
        </h1>
        <KebabMenu
          items={[
            { label: 'Edit', onClick: () => setEditing(true) },
            { label: isPinned ? 'Unpin' : 'Pin to top', onClick: handleTogglePin },
            { label: 'Merge a Duplicate into This Contact…', onClick: () => setMerging(true) },
            { label: 'Delete', onClick: () => setDeleting(true), danger: true, separatorBefore: true },
          ]}
        />
      </div>

      <div className="contact-detail__meta">
        <span className="chip">{circleLabel(contact.circle)}</span>
      </div>

      <div className="contact-detail__card">
        <div className="contact-detail__avatar">{initials(contact.name)}</div>
        <div className="contact-detail__fields">
          {phones.map((p) => {
            const clean = p.replace(/[^\d+]/g, '');
            return (
              <div key={p} className="contact-detail__field">
                <span className="contact-detail__field-icon">📞</span>
                <span className="contact-detail__field-value">{p}</span>
                <span className="contact-detail__field-actions">
                  <a className="contact-detail__field-action" href={`tel:${clean}`} title="Call" aria-label={`Call ${p}`}>
                    📞
                  </a>
                  <a className="contact-detail__field-action" href={`sms:${clean}`} title="Text" aria-label={`Text ${p}`}>
                    💬
                  </a>
                </span>
              </div>
            );
          })}
          {emails.map((e) => (
            <div key={e} className="contact-detail__field">
              <span className="contact-detail__field-icon">✉️</span>
              <span className="contact-detail__field-value">{e}</span>
              <span className="contact-detail__field-actions">
                <a className="contact-detail__field-action" href={`mailto:${e}`} title="Email" aria-label={`Email ${e}`}>
                  ✉️
                </a>
              </span>
            </div>
          ))}
          {contact.address && (
            <div className="contact-detail__field">
              <span className="contact-detail__field-icon">📍</span>
              <span className="contact-detail__field-value">{contact.address}</span>
              <span className="contact-detail__field-actions">
                <a
                  className="contact-detail__field-action"
                  href={`https://maps.google.com/?q=${encodeURIComponent(contact.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in Maps"
                  aria-label="Open in Maps"
                >
                  🗺️
                </a>
              </span>
            </div>
          )}
          {(contact.company || contact.title) && (
            <div className="contact-detail__field">
              <span className="contact-detail__field-icon">💼</span>
              <span className="contact-detail__field-value">
                {contact.title && contact.company ? `${contact.title}, ${contact.company}` : contact.title || contact.company}
              </span>
            </div>
          )}
          {birthday && (
            <div className="contact-detail__field">
              <span className="contact-detail__field-icon">🎂</span>
              <span className="contact-detail__field-value">{birthday}</span>
            </div>
          )}
          {anniversary && (
            <div className="contact-detail__field">
              <span className="contact-detail__field-icon">💍</span>
              <span className="contact-detail__field-value">{anniversary}</span>
            </div>
          )}
          {phones.length === 0 && emails.length === 0 && !contact.address && !contact.company && !contact.title && !birthday && !anniversary && (
            <div className="contact-detail__field contact-detail__field--empty">No contact info yet — click Edit to add some.</div>
          )}
        </div>
      </div>

      <VoterRecordSection records={contact.voterRecords} />

      <h2 className="contact-detail__section-title">Notes</h2>

      <div className="contact-note-composer">
        <input
          placeholder="Jot a quick note…"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
        />
        <label className="contact-note-composer__remind">
          <input type="checkbox" checked={remindMe} onChange={(e) => setRemindMe(e.target.checked)} />
          Check back on this
        </label>
        <button className="btn" onClick={handleAddNote} disabled={!noteDraft.trim()}>
          Add
        </button>
      </div>

      {contact.notes.length === 0 ? (
        <div className="empty-state empty-state--section">Nothing jotted yet.</div>
      ) : (
        <div className="contact-note-feed">
          {contact.notes.map((n) => (
            <NoteRow key={n.id} note={n} onResolve={(resolved) => handleResolveReminder(n, resolved)} onDelete={() => handleDeleteNote(n)} />
          ))}
        </div>
      )}

      {editing && <EditDetailsModal contact={contact} onSave={handleSaveDetails} onClose={() => setEditing(false)} />}

      {merging && <MergeDuplicateModal currentContact={contact} onMerge={handleMerge} onClose={() => setMerging(false)} />}

      {deleting && (
        <ConfirmModal
          title="Delete contact?"
          body={`"${contact.name}" and all notes on them will be permanently deleted.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
