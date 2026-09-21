import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Contact, ContactCircle } from '../api/types';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { KebabMenu } from '../components/KebabMenu';
import { useTabs, useReportTabMeta } from '../contexts/TabsContext';

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
        <div className="project-card__stats">
          <span>{circleLabel(contact.circle)}</span>
          {contact.company && <span>{contact.company}</span>}
        </div>
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
  const [remindersOnly, setRemindersOnly] = useState(false);
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

  const load = useCallback(() => {
    api
      .listContacts({
        q: query || undefined,
        circle: circleFilter ?? undefined,
        remindersOnly: remindersOnly || undefined,
        includeVoters: includeVoters || undefined,
      })
      .then(setContacts)
      .catch((e) => setError(String(e)));
  }, [query, circleFilter, remindersOnly, includeVoters]);

  useEffect(() => {
    load();
  }, [load]);

  // The "N need a check-in" count in the toolbar is independent of the
  // current filter/search state, so it's fetched on its own rather than
  // derived from `contacts`.
  useEffect(() => {
    api.listContacts({ remindersOnly: true }).then((r) => setReminderCount(r.length)).catch(() => {});
  }, [contacts]);

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

  return (
    <div>
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          Contacts
        </h1>
        <button className="btn" onClick={() => setCreating(true)}>
          + New Contact
        </button>
      </div>

      <div className="toolbar-row" style={{ marginTop: 4, flexWrap: 'wrap', gap: 8 }}>
        <input
          placeholder={includeVoters ? 'Search contacts, notes, and the voter roll…' : 'Search contacts and notes…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`chip${circleFilter === null ? ' is-active' : ''}`}
            onClick={() => setCircleFilter(null)}
          >
            All
          </button>
          {CIRCLES.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`chip${circleFilter === c.value ? ' is-active' : ''}`}
              onClick={() => setCircleFilter(circleFilter === c.value ? null : c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {reminderCount > 0 && (
          <button
            type="button"
            className={`chip chip--accent${remindersOnly ? ' is-active' : ''}`}
            onClick={() => setRemindersOnly((v) => !v)}
          >
            🔔 {reminderCount} need{reminderCount === 1 ? 's' : ''} a check-in
          </button>
        )}
        <button
          type="button"
          className={`chip${includeVoters ? ' is-active' : ''}`}
          onClick={() => setIncludeVoters((v) => !v)}
          title="Include people from the voter roll who aren't already one of your contacts"
        >
          🗳️ Voter Roll {includeVoters ? 'shown' : 'hidden'}
        </button>
      </div>

      {!contacts ? (
        <div className="empty-state">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="empty-state">
          {query || circleFilter || remindersOnly
            ? 'No contacts match.'
            : 'No contacts yet — add someone to start keeping notes and staying in touch.'}
        </div>
      ) : (
        <div className="project-card-list">
          {contacts.map((c) => (
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
