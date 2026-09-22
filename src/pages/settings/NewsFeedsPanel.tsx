import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { NewsFeed } from '../../api/types';
import { ConfirmModal } from '../../components/ConfirmModal';

/** News Feeds — add/edit/remove RSS feeds and their folder. Used to live as
 * a "Manage Feeds" modal launched from the News page itself; moved here
 * because it's only going to get more to manage (folders, sources) and a
 * popup felt like the wrong home for that — News itself just keeps a gear
 * icon that deep-links to this panel (see NewsPage.tsx's link to
 * `/settings?cat=news-feeds` and SettingsPage's `?cat=` handling). */
export function NewsFeedsPanel() {
  const [feeds, setFeeds] = useState<NewsFeed[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { title: string; folder: string }>>({});
  const [confirmDelete, setConfirmDelete] = useState<NewsFeed | null>(null);

  function load() {
    api
      .listNewsFeeds()
      .then((list) => {
        setFeeds(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  const existingFolders = [...new Set((feeds ?? []).map((f) => f.folder).filter((f): f is string => !!f))].sort();

  async function addFeed() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    setAddError(null);
    try {
      const feed = await api.addNewsFeed(trimmed, folder.trim() || null);
      if ((feed as unknown as { error?: string }).error) {
        setAddError((feed as unknown as { error: string }).error);
      } else {
        setUrl('');
        setFolder('');
      }
      load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add that feed.');
    } finally {
      setAdding(false);
    }
  }

  function startEdit(feed: NewsFeed) {
    setEditing((e) => ({ ...e, [feed.id]: { title: feed.title, folder: feed.folder ?? '' } }));
  }

  async function saveEdit(feed: NewsFeed) {
    const draft = editing[feed.id];
    if (!draft) return;
    await api.updateNewsFeed(feed.id, { title: draft.title.trim() || feed.title, folder: draft.folder.trim() || null });
    setEditing((e) => {
      const next = { ...e };
      delete next[feed.id];
      return next;
    });
    load();
  }

  async function deleteFeed(feed: NewsFeed) {
    await api.deleteNewsFeed(feed.id);
    setConfirmDelete(null);
    load();
  }

  if (error) return <div className="empty-state">Couldn't load feeds: {error}</div>;
  if (!feeds) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">News Feeds</h2>
      </div>
      <p className="settings-page__section-hint">
        Add, rename, re-folder, or remove the RSS feeds that populate the News page. Folders group feeds in News'
        sidebar — type an existing one or a new name.
      </p>

      <div className="news-feeds-modal">
        <div className="news-feeds-modal__add">
          <input
            className="news-feeds-modal__url-input"
            placeholder="Feed URL (https://example.com/feed.xml)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFeed()}
          />
          <input
            className="news-feeds-modal__folder-input"
            placeholder="Folder (optional)"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            list="news-existing-folders"
            onKeyDown={(e) => e.key === 'Enter' && addFeed()}
          />
          <datalist id="news-existing-folders">
            {existingFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <button className="btn btn--sm" onClick={addFeed} disabled={adding || !url.trim()}>
            {adding ? 'Adding…' : 'Add Feed'}
          </button>
        </div>
        {addError && <p className="news-feeds-modal__error">{addError}</p>}

        <div className="news-feeds-modal__list">
          {feeds.length === 0 && <p className="news-page__empty-hint">No feeds yet.</p>}
          {feeds.map((f) => {
            const draft = editing[f.id];
            return (
              <div key={f.id} className="news-feeds-modal__row">
                {draft ? (
                  <>
                    <input
                      className="news-feeds-modal__row-input"
                      value={draft.title}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [f.id]: { ...ed[f.id], title: e.target.value } }))}
                    />
                    <input
                      className="news-feeds-modal__row-input news-feeds-modal__row-input--folder"
                      value={draft.folder}
                      placeholder="Folder"
                      list="news-existing-folders"
                      onChange={(e) => setEditing((ed) => ({ ...ed, [f.id]: { ...ed[f.id], folder: e.target.value } }))}
                    />
                    <button className="btn btn--sm" onClick={() => saveEdit(f)}>
                      Save
                    </button>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() =>
                        setEditing((e) => {
                          const n = { ...e };
                          delete n[f.id];
                          return n;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <div className="news-feeds-modal__row-info">
                      <div className="news-feeds-modal__row-title">
                        {f.last_fetch_error && <span className="news-page__feed-error-dot" title={f.last_fetch_error} />}
                        {f.title}
                      </div>
                      <div className="news-feeds-modal__row-sub">
                        {f.folder ?? 'Uncategorized'} · {f.url}
                      </div>
                    </div>
                    <button className="btn btn--sm btn--ghost" onClick={() => startEdit(f)}>
                      Edit
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => setConfirmDelete(f)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Remove feed?"
          body={`This removes "${confirmDelete.title}" and its cached articles. Anything you've saved from it stays in Saved.`}
          confirmLabel="Remove"
          onConfirm={() => deleteFeed(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
