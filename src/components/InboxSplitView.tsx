import { useEffect, useState } from 'react';
import { useInboxFeed } from '../hooks/useInboxFeed';
import { api } from '../api/client';
import type { Contact, EmailAccountWithCounts, EmailMessage } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { TrashIcon } from './icons';

/** Flattened (one row per email address) so a contact with two addresses
 * offers both, independently, as forward targets. */
interface ContactEmail {
  name: string;
  email: string;
}

function contactEmails(contacts: Contact[]): ContactEmail[] {
  const out: ContactEmail[] = [];
  for (const c of contacts) {
    let emails: string[] = [];
    try {
      emails = JSON.parse(c.emails);
    } catch {
      continue;
    }
    for (const email of emails) {
      if (email) out.push({ name: c.name, email });
    }
  }
  return out;
}

function absoluteDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function AccountBadge({ account, size = 22 }: { account: EmailAccountWithCounts | undefined; size?: number }) {
  if (!account) return null;
  if (account.iconImageUrl) {
    return <img src={account.iconImageUrl} alt="" className="inbox-split__avatar-img" style={{ width: size, height: size }} />;
  }
  return (
    <span className="inbox-split__avatar-emoji" style={{ width: size, height: size, color: account.color }}>
      {account.icon}
    </span>
  );
}

/** Renders a message's actual HTML in a sandboxed, auto-resizing iframe —
 * the sandbox (no allow-scripts) is what actually makes this safe to do
 * with sender-supplied markup; mimeParser's stripActivelyUnsafe on the
 * server just tidies up what lands in the srcdoc rather than doing the
 * real safety work. allow-same-origin is there only so this component can
 * read the frame's own scrollHeight to size itself — combined with no
 * allow-scripts, that grants no extra capability the sandbox doesn't
 * already block. Links get target="_blank" (via <base>) and
 * allow-popups(-to-escape-sandbox) so clicking one opens a normal new
 * tab instead of silently doing nothing. */
function EmailBodyFrame({ html }: { html: string }) {
  const [height, setHeight] = useState(120);
  const srcDoc = `<!doctype html><html><head><base target="_blank"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.55; color: #2E2A22; word-wrap: break-word; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    a { color: #2F4A3C; }
    table { max-width: 100%; }
  </style></head><body>${html}</body></html>`;
  return (
    <iframe
      className="inbox-split__body-frame"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height }}
      onLoad={(e) => {
        const doc = (e.target as HTMLIFrameElement).contentDocument;
        if (doc) setHeight(doc.documentElement.scrollHeight + 16);
      }}
      title="Email body"
    />
  );
}

/** Inbox's full-page reading experience (InboxPage only — Today keeps the
 * compact InboxWidget) — a real split view: a message list on the left,
 * a reading pane on the right that looks like an actual email (sender
 * block, subject as a heading, the sender's real HTML body, a proper
 * action toolbar) instead of a row expanding into a plain text box. One
 * flat list, no New/Needs Processing split — Mike's own call: not every
 * message needs a decision, the point of this Inbox is just not missing
 * something that landed in a mailbox he doesn't check directly. On
 * narrow viewports the two collapse into one column and selecting a
 * message replaces the list with the reading pane (a "back" arrow
 * returns to it) — see the .inbox-split CSS for the breakpoint, driven
 * by the `has-selection` class rather than any JS media-query logic. */
export function InboxSplitView() {
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const { feed, error, bodies, busyId, peek, archive, deleteMessage, convert, reply, forward } = useInboxFeed(activeAccount ?? undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [replyArchiveAfter, setReplyArchiveAfter] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardTo, setForwardTo] = useState('');
  const [forwardNote, setForwardNote] = useState('');
  const [sendingForward, setSendingForward] = useState(false);
  // Not Gmail — Inbox has no address book of its own to autocomplete from,
  // so this borrows MikeOS's own Contacts (personal ones only, the same
  // default listContacts already uses elsewhere — the voter-roll import
  // would otherwise dump thousands of unrelated names into the picker).
  // Loaded once, lazily, the first time Forward is opened rather than on
  // every page load.
  const [contactEmailList, setContactEmailList] = useState<ContactEmail[] | null>(null);
  useEffect(() => {
    if (forwardOpen && contactEmailList === null) {
      api.listContacts().then((cs) => setContactEmailList(contactEmails(cs)));
    }
  }, [forwardOpen, contactEmailList]);

  if (error) return <div className="empty-state">Couldn't load Inbox: {error}</div>;
  if (!feed) return <div className="empty-state">Loading…</div>;
  if (feed.accounts.length === 0) {
    return <div className="empty-state">No email accounts connected yet — add one in Settings → Email Accounts.</div>;
  }

  const selected = feed.items.find((m) => m.id === selectedId) ?? null;
  const selectedAccount = feed.accounts.find((a) => a.id === selected?.account_id);
  const totalUnread = feed.accounts.reduce((sum, a) => sum + a.unreadCount, 0);

  async function selectMessage(m: EmailMessage) {
    setSelectedId(m.id);
    setReplyOpen(false);
    setReplyDraft('');
    setForwardOpen(false);
    setForwardTo('');
    setForwardNote('');
    if (bodies[m.id] === undefined) {
      setLoadingSelected(true);
      await peek(m);
      setLoadingSelected(false);
    }
  }

  async function handleArchive(id: string) {
    await archive(id);
    if (selectedId === id) setSelectedId(null);
  }

  async function handleConvert(id: string, as: 'task' | 'note') {
    await convert(id, as);
    if (selectedId === id) setSelectedId(null);
  }

  // No confirm dialog: a delete moves the message to Gmail Trash, recoverable
  // there for 30 days same as deleting it in Gmail itself, so the extra step
  // wasn't buying anything — Mike's own call. Errors are still surfaced
  // (rather than left silent) since this hits real IMAP state.
  async function handleDelete(id: string) {
    try {
      await deleteMessage(id);
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      alert(`Couldn't delete this message: ${String(e)}`);
    }
  }

  async function sendReply() {
    if (!selected || !replyDraft.trim()) return;
    setSendingReply(true);
    try {
      await reply(selected.id, replyDraft.trim(), replyArchiveAfter);
      setReplyDraft('');
      setReplyOpen(false);
      if (replyArchiveAfter) setSelectedId(null);
    } catch (e) {
      alert(`Couldn't send reply: ${String(e)}`);
    } finally {
      setSendingReply(false);
    }
  }

  async function sendForward() {
    if (!selected || !forwardTo.trim()) return;
    setSendingForward(true);
    try {
      await forward(selected.id, forwardTo.trim(), forwardNote.trim() || undefined);
      setForwardTo('');
      setForwardNote('');
      setForwardOpen(false);
    } catch (e) {
      alert(`Couldn't forward this message: ${String(e)}`);
    } finally {
      setSendingForward(false);
    }
  }

  function renderListRow(m: EmailMessage) {
    const account = feed!.accounts.find((a) => a.id === m.account_id);
    const isUnread = !m.is_read;
    return (
      <button
        type="button"
        key={m.id}
        className={`inbox-split__row${selectedId === m.id ? ' is-selected' : ''}${isUnread ? ' is-unread' : ''}`}
        onClick={() => selectMessage(m)}
      >
        {!activeAccount && <AccountBadge account={account} size={18} />}
        <span className="inbox-split__row-main">
          <span className="inbox-split__row-top">
            <span className="inbox-split__row-from">{m.from_name || m.from_email || 'Unknown sender'}</span>
            <span className="inbox-split__row-time">{formatRelativeTime(m.received_at)}</span>
          </span>
          <span className="inbox-split__row-subject">{m.subject || '(no subject)'}</span>
          {m.snippet && <span className="inbox-split__row-snippet">{m.snippet}</span>}
        </span>
      </button>
    );
  }

  const peeked = selected ? bodies[selected.id] : undefined;

  return (
    <div className={`inbox-split${selectedId ? ' has-selection' : ''}`}>
      <div className="inbox-split__list">
        <div className="inbox-split__tabs">
          <button
            type="button"
            className={`inbox-split__tab${activeAccount === null ? ' is-active' : ''}`}
            onClick={() => {
              setActiveAccount(null);
              setSelectedId(null);
            }}
            title="All accounts"
          >
            All
            {totalUnread > 0 && <span className="inbox-split__tab-badge">{totalUnread}</span>}
          </button>
          {feed.accounts.map((a) => (
            <button
              type="button"
              key={a.id}
              className={`inbox-split__tab${activeAccount === a.id ? ' is-active' : ''}`}
              onClick={() => {
                setActiveAccount(a.id);
                setSelectedId(null);
              }}
              title={a.label}
            >
              {a.iconImageUrl ? <img src={a.iconImageUrl} alt="" className="inbox-split__tab-img" /> : <span style={{ color: a.color }}>{a.icon}</span>}
              {a.unreadCount > 0 && <span className="inbox-split__tab-badge">{a.unreadCount}</span>}
            </button>
          ))}
        </div>

        {feed.items.length === 0 ? (
          <div className="empty-state empty-state--section">Inbox zero. 🎉</div>
        ) : (
          feed.items.map(renderListRow)
        )}
      </div>

      <div className="inbox-split__pane">
        {!selected ? (
          <div className="inbox-split__empty">Select a message to read it.</div>
        ) : (
          <>
            <button type="button" className="inbox-split__back" onClick={() => setSelectedId(null)} aria-label="Back to list">
              ← Back
            </button>
            <div className="inbox-split__header">
              <AccountBadge account={selectedAccount} size={36} />
              <div className="inbox-split__header-text">
                <div className="inbox-split__from">{selected.from_name || selected.from_email || 'Unknown sender'}</div>
                {selected.from_email && <div className="inbox-split__email">{selected.from_email}</div>}
              </div>
              <div className="inbox-split__date">{absoluteDate(selected.received_at)}</div>
            </div>
            <h2 className="inbox-split__subject">{selected.subject || '(no subject)'}</h2>

            <div className="inbox-split__toolbar">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => handleArchive(selected.id)} disabled={busyId === selected.id}>
                📥 Archive
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => handleConvert(selected.id, 'task')} disabled={busyId === selected.id}>
                ✅ Make a Task
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => handleConvert(selected.id, 'note')} disabled={busyId === selected.id}>
                📝 Save as Note
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm inbox-split__reply-toggle"
                onClick={() => {
                  setReplyOpen((v) => !v);
                  setForwardOpen(false);
                }}
                disabled={!selected.from_email}
                title={selected.from_email ? undefined : 'No parseable sender address to reply to'}
              >
                ↩ Reply
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setForwardOpen((v) => !v);
                  setReplyOpen(false);
                }}
              >
                ➜ Forward
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm inbox-split__delete-btn"
                onClick={() => handleDelete(selected.id)}
                disabled={busyId === selected.id}
              >
                <TrashIcon size={12} /> Delete
              </button>
            </div>

            {loadingSelected || !peeked ? (
              <div className="inbox-split__body">Loading…</div>
            ) : peeked.html ? (
              <EmailBodyFrame html={peeked.html} />
            ) : (
              <div className="inbox-split__body">{peeked.text || '(empty message)'}</div>
            )}

            {replyOpen && (
              <div className="inbox-split__reply">
                <textarea
                  placeholder={`Reply to ${selected.from_email ?? 'sender'}…`}
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  rows={4}
                  autoFocus
                />
                <div className="inbox-split__reply-actions">
                  {/* Sending no longer auto-archives by default — Mike's own
                      call: archiving is one click away in the same toolbar
                      once he's actually done with the message, and a send
                      that quietly also archived was surprising more often
                      than it saved a step. */}
                  <label className="inbox-split__archive-toggle">
                    <input type="checkbox" checked={replyArchiveAfter} onChange={(e) => setReplyArchiveAfter(e.target.checked)} />
                    Archive after sending
                  </label>
                  <button type="button" className="btn btn--sm" onClick={sendReply} disabled={!replyDraft.trim() || sendingReply}>
                    {sendingReply ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            )}

            {forwardOpen && (
              <div className="inbox-split__reply">
                <input
                  type="email"
                  className="inbox-split__forward-to"
                  placeholder="Forward to…"
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  list="inbox-forward-contacts"
                  autoFocus
                />
                {/* Gmail autocompletes a forward's recipient from its own
                    Contacts; Inbox has no equivalent address book, so this
                    borrows MikeOS's own Contacts instead (see
                    contactEmailList above) — start typing a name or email
                    and matching people show up here same as any native
                    autocomplete. Nothing stops typing an address that isn't
                    a saved contact at all. */}
                <datalist id="inbox-forward-contacts">
                  {(contactEmailList ?? []).map((c) => (
                    <option key={c.email} value={c.email} label={c.name} />
                  ))}
                </datalist>
                <textarea
                  placeholder="Add a note (optional)…"
                  value={forwardNote}
                  onChange={(e) => setForwardNote(e.target.value)}
                  rows={3}
                />
                <button type="button" className="btn btn--sm" onClick={sendForward} disabled={!forwardTo.trim() || sendingForward}>
                  {sendingForward ? 'Sending…' : 'Send'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
