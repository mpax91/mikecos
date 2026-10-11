import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Contact, ContactCircle, QuietContact } from '../api/types';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';
import { ContactsAskPanel } from './ContactsAskPanel';
import { autoLabelClass, displayLabels, VOTER_LABEL } from '../utils/contactLabels';

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

function ContactCard({
  contact,
  onOpen,
  onDelete,
  onTogglePin,
}: {
  contact: Contact;
  onOpen: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const { openTab, showContextMenu } = useTabs();
  const isPinned = contact.pinned === 1;
  // Mike's own Google labels; a circle only shows when there are no labels
  // and it says something (not "Other"). Company stays on the card itself.
  const labels = displayLabels(contact);
  return (
    <div
      className={`card project-card${isPinned ? ' is-pinned' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          openTab(`/contacts/${contact.id}`, { background: true, title: contact.name, kind: 'contact' });
          return;
        }
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open in New Tab', onClick: () => openTab(`/contacts/${contact.id}`, { background: true, title: contact.name, kind: 'contact' }) },
        ]);
      }}
    >
      {isPinned && <span className="entity-card__pin" title="Pinned">📌</span>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p className="project-card__title">
          <span className="project-card__title-text">{contact.name}</span>
        </p>
        {contact.headline && <p className="contact-card__headline">{contact.headline}</p>}
        {(labels.length > 0 || contact.circle !== 'other') && (
          <div className="contact-labels contact-labels--row">
            {labels.length > 0
              ? labels.map((l) => (
                  <span key={l} className={`contact-label${autoLabelClass(l)}`}>
                    {l}
                  </span>
                ))
              : <span className="contact-label contact-label--circle">{circleLabel(contact.circle)}</span>}
          </div>
        )}
      </div>
      <KebabMenu
        items={[
          { label: isPinned ? 'Unpin' : 'Pin to top', onClick: onTogglePin },
          { label: 'Delete', onClick: onDelete, danger: true, separatorBefore: true },
        ]}
      />
    </div>
  );
}

/** Contacts — the personal CRM. A browse-by-name list (pinned first, then
 * alphabetical — unlike Jots/Shelf, which sort by recency, this is a
 * lookup list you search rather than scan chronologically), each card
 * opening onto a feed of quick, unstructured notes about that person (see
 * ContactDetailPage). Circles are the light, fixed categorization scheme
 * this app favors over open tagging. */
export function ContactsListPage() {
  useReportTabMeta('Contacts', 'contacts-list');
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [circleFilter, setCircleFilter] = useState<ContactCircle | null>(null);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [allLabels, setAllLabels] = useState<{ label: string; count: number }[]>([]);
  const [remindersOnly, setRemindersOnly] = useState(false);
  // Calls & Texts: people you used to talk to regularly who've gone quiet
  // (worker/src/comms/read.ts goneQuiet). Filtered client-side by id.
  const [quiet, setQuiet] = useState<QuietContact[]>([]);
  const [quietOnly, setQuietOnly] = useState(false);
  const [backupStaleSince, setBackupStaleSince] = useState<string | null>(null);
  const [reminderCount, setReminderCount] = useState(0);
  // Standalone voter-roll entries (12k+ people Mike has never met) are
  // excluded by default — see api.listContacts' `voters` param — so the
  // list and search stay about the personal contacts this CRM is actually
  // for. This toggle is the escape hatch when he does want to look someone
  // up in the roll itself.
  const [includeVoters, setIncludeVoters] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<Contact | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    api
      .listContacts({
        q: query || undefined,
        circle: circleFilter ?? undefined,
        label: labelFilter ?? undefined,
        remindersOnly: remindersOnly || undefined,
        includeVoters: includeVoters || undefined,
      })
      .then(setContacts)
      .catch((e) => setError(String(e)));
  }, [query, circleFilter, labelFilter, remindersOnly, includeVoters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.getCommsQuiet().then(setQuiet).catch(() => {});
    api
      .getCommsStatus()
      .then((r) => setBackupStaleSince(r.backupStale ? r.latestBackupAt ?? '' : null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.listContactLabels().then((r) => setAllLabels(r.labels)).catch(() => {});
  }, []);

  // The "N need a check-in" count in the toolbar is independent of the
  // current filter/search state, so it's fetched on its own rather than
  // derived from `contacts`.
  useEffect(() => {
    api.listContacts({ remindersOnly: true }).then((r) => setReminderCount(r.length)).catch(() => {});
  }, [contacts]);

  const quietRank = new Map(quiet.map((q, i) => [q.id, i]));
  const shown = !contacts ? [] : quietOnly ? contacts.filter((c) => quietRank.has(c.id)).sort((a, b) => quietRank.get(a.id)! - quietRank.get(b.id)!) : contacts;

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const contact = await api.createContact({ name });
    setCreating(false);
    setNewName('');
    navigate(`/contacts/${contact.id}`);
  }

  async function handleTogglePin(contact: Contact) {
    const next = contact.pinned === 1 ? false : true;
    setContacts((prev) => (prev ? prev.map((c) => (c.id === contact.id ? { ...c, pinned: next ? 1 : 0 } : c)) : prev));
    await api.setContactPinned(contact.id, next);
    load();
  }

  async function handleDelete(contact: Contact) {
    setContacts((prev) => (prev ? prev.filter((c) => c.id !== contact.id) : prev));
    await api.deleteContact(contact.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load contacts: {error}</div>;

  if (asking) return <ContactsAskPanel onBack={() => setAsking(false)} />;

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Contacts
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost" onClick={() => setAsking(true)} title="Ask a question about your contacts">
            🔍 Ask
          </button>
          <button className="btn" onClick={() => setCreating(true)}>
            + New Contact
          </button>
        </div>
      </div>

      {/* Search spans the list's full width; filters sit on one line under
          it — a Labels dropdown (Mike's Google labels, A–Z;
          circles are the fallback when no labels exist yet), the check-in
          chip and the voter-roll toggle. */}
      <input
        className="contacts-search"
        type="search"
        placeholder={includeVoters ? 'Search contacts, notes, labels, and the voter roll…' : 'Search contacts, notes, and labels…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="contacts-filters">
        {allLabels.length > 0 ? (
          <label className="contacts-filter-select">
            <span className="contacts-filter-select__label">Label</span>
            <select
              value={labelFilter ?? ''}
              onChange={(e) => {
                const v = e.target.value || null;
                setLabelFilter(v);
                // "Voter" means the roll — show it.
                if (v === VOTER_LABEL) setIncludeVoters(true);
              }}
            >
              <option value="">All</option>
              {allLabels.map((l) => (
                <option key={l.label} value={l.label}>
                  {l.label} ({l.count})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="contacts-filter-select">
            <span className="contacts-filter-select__label">Circle</span>
            <select value={circleFilter ?? ''} onChange={(e) => setCircleFilter((e.target.value || null) as ContactCircle | null)}>
              <option value="">All</option>
              {CIRCLES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {reminderCount > 0 && (
          <button
            type="button"
            className={`chip chip--accent${remindersOnly ? ' is-active' : ''}`}
            onClick={() => setRemindersOnly((v) => !v)}
          >
            🔔 {reminderCount} need{reminderCount === 1 ? 's' : ''} a check-in
          </button>
        )}
        {quiet.length > 0 && (
          <button
            type="button"
            className={`chip${quietOnly ? ' is-active' : ''}`}
            onClick={() => setQuietOnly((v) => !v)}
            title="People you called or texted most months last year, but not in the last 60 days"
          >
            📞 {quiet.length} gone quiet
          </button>
        )}
        <button
          type="button"
          className={`chip contacts-filters__voters${includeVoters ? ' is-active' : ''}`}
          onClick={() => setIncludeVoters((v) => !v)}
          title="Include people from the voter roll who aren't already one of your contacts"
        >
          🗳️ Voter Roll {includeVoters ? 'Shown' : 'Hidden'}
        </button>
      </div>

      {backupStaleSince !== null && (
        <div className="fin-dash__flag fin-dash__flag--warn comms-stale">
          <span className="fin-dash__flag-icon">⚠</span>
          <span className="fin-dash__flag-msg">
            No new phone backup since{' '}
            {backupStaleSince ? new Date(backupStaleSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'a while'} — Calls &amp; Texts on
            contact cards aren’t updating. Check SMS Backup &amp; Restore on your phone.{' '}
            <a href="/settings?cat=comms" onClick={(e) => { e.preventDefault(); navigate('/settings?cat=comms'); }}>
              Details
            </a>
          </span>
        </div>
      )}
      {quietOnly && contacts && (
        <p className="contacts-quiet-note">
          Called or texted in at least 4 months of the year before, nothing in the last 60 days — busiest first. Last in touch:{' '}
          {quiet
            .slice(0, 3)
            .map((q) => `${q.name} ${q.lastTouch ? new Date(q.lastTouch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}`)
            .join(' · ')}
          {quiet.length > 3 ? ' …' : ''}
        </p>
      )}
      {!contacts ? (
        <div className="empty-state">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          {query || circleFilter || labelFilter || remindersOnly || quietOnly
            ? 'No contacts match.'
            : 'No contacts yet — add someone to start keeping notes and staying in touch.'}
        </div>
      ) : (
        <div className="project-card-list">
          {shown.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              onOpen={() => navigate(`/contacts/${c.id}`)}
              onDelete={() => setDeleting(c)}
              onTogglePin={() => handleTogglePin(c)}
            />
          ))}
        </div>
      )}

      {creating && (
        <Modal title="New Contact" onClose={() => setCreating(false)}>
          <input
            autoFocus
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleCreate} disabled={!newName.trim()}>
              Create
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete contact?"
          body={`"${deleting.name}" and all notes on them will be permanently deleted.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
