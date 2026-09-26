import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EmailInboxFeed, EmailMessage } from '../api/types';

/** Shared data + actions for Inbox's feed — used by both the compact
 * Today widget (InboxWidget) and the full-page split view (InboxSplitView)
 * so the archive/delete/convert/reply network calls and refresh-after
 * logic live in exactly one place instead of two copies drifting apart. */
export function useInboxFeed(accountId?: string) {
  const [feed, setFeed] = useState<EmailInboxFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
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

  async function peek(m: EmailMessage): Promise<string> {
    if (bodies[m.id] !== undefined) return bodies[m.id];
    try {
      const res = await api.peekEmail(m.id);
      setBodies((prev) => ({ ...prev, [m.id]: res.body }));
      load(); // it just moved from New to Needs Processing (or disappears if it was already there)
      return res.body;
    } catch (e) {
      const msg = `Couldn't load this message: ${String(e)}`;
      setBodies((prev) => ({ ...prev, [m.id]: msg }));
      return msg;
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

  async function reply(id: string, body: string, archiveAfter = true) {
    await api.replyToEmail(id, { body, archive: archiveAfter });
    load();
  }

  return { feed, error, bodies, busyId, load, peek, archive, deleteMessage, convert, reply };
}
