import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { PlexIgnoredShow } from '../../api/types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Shows Mike never wants Airing reminders for (migrations/0109). Shows are
 * ignored from the Airing row's ⋯ menu; this is only where they're undone. */
export function IgnoredShowsPanel() {
  const [shows, setShows] = useState<PlexIgnoredShow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.listPlexIgnoredShows().then(setShows).catch((e) => setError(String(e)));
  }

  useEffect(load, []);

  async function unignore(show: PlexIgnoredShow) {
    setShows((prev) => prev?.filter((s) => s.showItemId !== show.showItemId) ?? prev);
    try {
      await api.unignorePlexShow(show.showItemId);
    } catch {
      setError(`Couldn't unignore ${show.title} — try again.`);
      load();
    }
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Ignored Shows</h2>
      </div>
      <p className="settings-page__section-hint">
        These never show up in <Link to="/media?tab=airing">Media → Airing</Link> and never get a Download task. Ignore a show from
        the ⋯ menu on its Airing row. After you unignore one, its new episodes appear from the next nightly check.
      </p>

      {error && <div className="wallet-editor__error" style={{ marginBottom: 8 }}>{error}</div>}

      {!shows ? (
        <div className="empty-state">Loading…</div>
      ) : shows.length === 0 ? (
        <div className="empty-state">No ignored shows.</div>
      ) : (
        <div className="manage-list">
          {shows.map((show) => (
            <div className="manage-row" key={show.showItemId}>
              <div className="manage-row__body">
                <div className="manage-row__title">{show.title}</div>
                <div className="wallet-editor__hint">Ignored {formatDate(show.ignoredAt)}</div>
              </div>
              <div className="manage-row__actions">
                <button type="button" className="btn btn--ghost" onClick={() => unignore(show)}>
                  Unignore
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
