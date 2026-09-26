import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EmailAccountWithCounts, EmailInboxFeed, EmailMessage } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { ConfirmModal } from './ConfirmModal';
import { TrashIcon } from './icons';

/** Today's Inbox section — a live status board over every connected
 * mailbox (see Settings → Email Accounts), Thunderbird-style: an "All"
 * tab alongside one tab per account, each with its own icon/color for
 * quick visual scanning. Not a mail client — no folder browsing, no
 * compose-from-scratch — just a flat list of everything still sitting in
 * these mailboxes (not archived, deleted, or converted). No New/Needs
 * Processing split: Mike's own call — the point of this feature is just
 * not missing something in an inbox he doesn't check directly, not
 * tracking a per-message processed state. */
export function InboxWidget() {
  const [feed, setFeed] = useState<EmailInboxFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAccount, setActiveAccount] = useState<string | null>(null); // null = All
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EmailMessage | null>(null);

  function load() {
    api
      .getInboxFeed(activeAccount ?? undefined)
      .then((res) => {
        setFeed(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount]);

  async function togglePeek(m: EmailMessage) {
    if (expandedId === m.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(m.id);
    if (bodies[m.id] !== undefined) return;
    try {
      const res = await api.peekEmail(m.id);
      setBodies((prev) => ({ ...prev, [m.id]: res.body }));
      load(); // it just flipped to read — refreshes the unread badge
    } catch (e) {
      setBodies((prev) => ({ ...prev, [m.id]: `Couldn't load this message: ${String(e)}` }));
    }
  }

  async function archive(id: string) {
    setBusyId(id);
    try {
      await api.archiveEmail(id);
      if (expandedId === id) setExpandedId(null);
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    setBusyId(id);
    try {
      await api.deleteEmail(id);
      if (expandedId === id) setExpandedId(null);
      setDeleting(null);
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function convert(id: string, as: 'task' | 'note') {
    setBusyId(id);
    try {
      await api.convertEmail(id, { as });
      if (expandedId === id) setExpandedId(null);
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function sendReply(id: string) {
    const body = (replyDrafts[id] ?? '').trim();
    if (!body) return;
    setSendingReplyId(id);
    try {
      await api.replyToEmail(id, { body, archive: true });
      setReplyDrafts((prev) => ({ ...prev, [id]: '' }));
      setExpandedId(null);
      load();
    } catch (e) {
      alert(`Couldn't send reply: ${String(e)}`);
    } finally {
      setSendingReplyId(null);
    }
  }

  function renderRow(m: EmailMessage, accounts: EmailAccountWithCounts[]) {
    const account = accounts.find((a) => a.id === m.account_id);
    const isExpanded = expandedId === m.id;
    return (
      <div key={m.id} className={`inbox-widget__row${isExpanded ? ' is-expanded' : ''}`}>
        <div className="inbox-widget__row-main" onClick={() => togglePeek(m)}>
          {!activeAccount && account && (
            <span className="inbox-widget__row-account" style={{ color: account.color }} title={account.label}>
              {account.iconImageUrl ? <img src={account.iconImageUrl} alt="" className="inbox-widget__row-account-img" /> : account.icon}
            </span>
          )}
          <div className="inbox-widget__row-text">
            <span className="inbox-widget__row-from">{m.from_name || m.from_email || 'Unknown sender'}</span>
            <span className="inbox-widget__row-subject">{m.subject || '(no subject)'}</span>
            {!isExpanded && m.snippet && <span className="inbox-widget__row-snippet">{m.snippet}</span>}
          </div>
          <span className="inbox-widget__row-time">{formatRelativeTime(m.received_at)}</span>
        </div>

        {isExpanded && (
          <div className="inbox-widget__peek">
            <div className="inbox-widget__peek-body">{bodies[m.id] ?? 'Loading…'}</div>
            <div className="inbox-widget__peek-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => archive(m.id)} disabled={busyId === m.id}>
                📥 Archive
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => convert(m.id, 'task')} disabled={busyId === m.id}>
                ✅ Make a Task
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => convert(m.id, 'note')} disabled={busyId === m.id}>
                📝 Save as Note
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm inbox-widget__delete-btn"
                onClick={() => setDeleting(m)}
                disabled={busyId === m.id}
                title="Delete"
              >
                <TrashIcon size={12} /> Delete
              </button>
            </div>
            <div className="inbox-widget__reply">
              <textarea
                placeholder={`Reply to ${m.from_email ?? 'sender'}…`}
                value={replyDrafts[m.id] ?? ''}
                onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                rows={3}
              />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => sendReply(m.id)}
                disabled={!(replyDrafts[m.id] ?? '').trim() || sendingReplyId === m.id || !m.from_email}
              >
                {sendingReplyId === m.id ? 'Sending…' : 'Send & Archive'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Always renders something visible (a loading/error/connect-prompt state,
  // never a silent null) — an earlier version returned null for all three
  // of these, which is indistinguishable from "this feature isn't here" and
  // is exactly what made a genuinely-empty state (no account connected yet)
  // impossible to tell apart from something being broken. Matches the
  // house convention other Today sections already follow (see the Meetings
  // section's own "always shown" comment).
  if (error) return <div className="empty-state empty-state--section">Couldn't load Inbox: {error}</div>;
  if (!feed) return <div className="empty-state empty-state--section">Loading…</div>;
  if (feed.accounts.length === 0) {
    return (
      <div className="empty-state empty-state--section">
        No email accounts connected yet — add one in Settings → Email Accounts.
      </div>
    );
  }

  const totalUnread = feed.accounts.reduce((sum, a) => sum + a.unreadCount, 0);

  return (
    <div className="inbox-widget card">
      <div className="inbox-widget__tabs">
        <button
            type="button"
            className={`inbox-widget__tab${activeAccount === null ? ' is-active' : ''}`}
            onClick={() => setActiveAccount(null)}
          >
            All
            {totalUnread > 0 && <span className="inbox-widget__tab-badge">{totalUnread}</span>}
          </button>
          {feed.accounts.map((a) => (
            <button
              type="button"
              key={a.id}
              className={`inbox-widget__tab${activeAccount === a.id ? ' is-active' : ''}`}
              onClick={() => setActiveAccount(a.id)}
              title={a.label}
            >
              {a.iconImageUrl ? (
                <img src={a.iconImageUrl} alt="" className="inbox-widget__tab-img" />
              ) : (
                <span style={{ color: a.color }}>{a.icon}</span>
              )}{' '}
              {a.label}
              {a.unreadCount > 0 && <span className="inbox-widget__tab-badge">{a.unreadCount}</span>}
            </button>
          ))}
        </div>

        {feed.items.length === 0 ? (
          <div className="empty-state empty-state--section">Inbox zero. 🎉</div>
        ) : (
          <div className="inbox-widget__group">{feed.items.map((m) => renderRow(m, feed.accounts))}</div>
        )}

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

