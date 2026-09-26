import { useState } from 'react';
import { useInboxFeed } from '../hooks/useInboxFeed';
import type { EmailAccountWithCounts, EmailMessage } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { ConfirmModal } from './ConfirmModal';
import { TrashIcon } from './icons';

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
  const { feed, error, bodies, busyId, peek, archive, deleteMessage, convert, reply } = useInboxFeed(activeAccount ?? undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [deleting, setDeleting] = useState<EmailMessage | null>(null);

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

  async function confirmDelete() {
    if (!deleting) return;
    await deleteMessage(deleting.id);
    if (selectedId === deleting.id) setSelectedId(null);
    setDeleting(null);
  }

  async function sendReply() {
    if (!selected || !replyDraft.trim()) return;
    setSendingReply(true);
    try {
      await reply(selected.id, replyDraft.trim(), true);
      setReplyDraft('');
      setReplyOpen(false);
      setSelectedId(null);
    } catch (e) {
      alert(`Couldn't send reply: ${String(e)}`);
    } finally {
      setSendingReply(false);
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
                onClick={() => setReplyOpen((v) => !v)}
                disabled={!selected.from_email}
                title={selected.from_email ? undefined : 'No parseable sender address to reply to'}
              >
                ↩ Reply
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm inbox-split__delete-btn"
                onClick={() => setDeleting(selected)}
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
                <button type="button" className="btn btn--sm" onClick={sendReply} disabled={!replyDraft.trim() || sendingReply}>
                  {sendingReply ? 'Sending…' : 'Send & Archive'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {deleting && (
        <ConfirmModal
          title="Delete this email?"
          body={`"${deleting.subject || '(no subject)'}" will move to Trash in Gmail — recoverable there for 30 days, same as deleting it in Gmail itself.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
