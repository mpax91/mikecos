import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PlexIssue, PlexLibrary } from '../api/types';

/** "Needs attention" — a plain rules pass over the synced library (see
 * worker/src/plex.ts's detectIssues) surfacing anything Plex itself won't
 * flag for you: unmatched items, missing artwork/summary/genres, tracks
 * missing a number, "Various Artists" albums that probably need per-track
 * tagging. Nothing here gets fixed automatically — MikeOS can't reach
 * into the actual files — this is purely a punch list for Mike to work
 * through in Plex itself. */
export function PlexIssuesPanel() {
  const [libraries, setLibraries] = useState<PlexLibrary[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [issues, setIssues] = useState<PlexIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPlexLibraries()
      .then((libs) => {
        setLibraries(libs);
        if (libs.length) setLibraryId(libs[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!libraryId) return;
    setIssues(null);
    api.getPlexIssues(libraryId).then(setIssues).catch((e) => setError(String(e)));
  }, [libraryId]);

  if (error) return <div className="empty-state">Couldn't load: {error}</div>;
  if (!libraries) return <div className="empty-state">Loading…</div>;
  if (libraries.length === 0) return <div className="empty-state">Sync your library from the Library tab first.</div>;

  return (
    <div>
      <div className="plex-library-chips">
        {libraries.map((l) => (
          <button key={l.id} type="button" className={`plex-library-chip${l.id === libraryId ? ' is-active' : ''}`} onClick={() => setLibraryId(l.id)}>
            {l.title}
          </button>
        ))}
      </div>

      {!issues ? (
        <div className="empty-state">Loading…</div>
      ) : issues.length === 0 ? (
        <div className="empty-state">Nothing flagged in this library — metadata looks clean.</div>
      ) : (
        <div className="plex-issues__count">{issues.length} item{issues.length === 1 ? '' : 's'} to look at</div>
      )}

      {issues && issues.length > 0 && (
        <div className="plex-issues__list">
          {issues.map((issue) => (
            <div key={issue.id} className="plex-issues__row">
              <div className="plex-issues__row-title">{issue.title}</div>
              <div className="plex-issues__row-tags">
                {issue.issues.map((tag) => (
                  <span key={tag} className="plex-issues__tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
