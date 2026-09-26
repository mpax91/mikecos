import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EmailInboxFeed, EmailMessage } from '../api/types';

/** Shared data + actions for Inbox's feed — used by both the compact
 * Today widget (InboxWidget) and the full-page split view (InboxSplitView)
 * so the archive/delete/convert/reply network calls and refresh-after
 * logic live in exactly one place instead of two copies drifting apart. */
interface PeekedBody {
  text: string;
  html: string | null;
}

export function useInboxFeed(accountId?: string) {
  const [feed, setFeed] = useState<EmailInboxFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, PeekedBody>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getInboxFeed(accountId)
      .then((res) => {
        setFeed(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  async function peek(m: EmailMessage): Promise<PeekedBody> {
    if (bodies[m.id] !== undefined) return bodies[m.id];
    try {
      const res = await api.peekEmail(m.id);
      const peeked: PeekedBody = { text: res.body, html: res.bodyHtml };
      setBodies((prev) => ({ ...prev, [m.id]: peeked }));
      load(); // flips is_read locally — refresh unread counts/badges
      return peeked;
    } catch (e) {
      const peeked: PeekedBody = { text: `Couldn't load this message: ${String(e)}`, html: null };
      setBodies((prev) => ({ ...prev, [m.id]: peeked }));
      return peeked;
    }
  }

  async function archive(id: string) {
    setBusyId(id);
    try {
      await api.archiveEmail(id);
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteMessage(id: string) {
    setBusyId(id);
    try {
      await api.deleteEmail(id);
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function convert(id: string, as: 'task' | 'note') {
    setBusyId(id);
    try {
      await api.convertEmail(id, { as });
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function reply(id: string, body: string, archiveAfter = false) {
    await api.replyToEmail(id, { body, archive: archiveAfter });
    load();
  }

  async function forward(id: string, to: string, note?: string) {
    await api.forwardEmail(id, { to, note });
  }

  return { feed, error, bodies, busyId, load, peek, archive, deleteMessage, convert, reply, forward };
}
