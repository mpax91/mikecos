import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PlexMissingEpisode } from '../api/types';

function formatAired(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Replaces the daily TrackSeries.tv check — episodes TVMaze says have
 * aired for a show in Mike's Plex library, that the nightly sync hasn't
 * found in the library yet (see worker/src/plexAiring.ts). The same list
 * also feeds the Daily Briefing's "worth a glance" section; this tab is
 * the full history plus the ability to dismiss one Mike doesn't actually
 * want (a clip show, a special). */
export function PlexAiringPanel() {
  const [episodes, setEpisodes] = useState<PlexMissingEpisode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  function load() {
    api.listPlexMissingEpisodes().then(setEpisodes).catch((e) => setError(String(e)));
  }

  useEffect(load, []);

  async function dismiss(ep: PlexMissingEpisode) {
    setEpisodes((prev) => prev?.filter((e) => e.id !== ep.id) ?? prev);
    try {
      await api.dismissPlexMissingEpisode(ep.id, true);
    } catch {
      load(); // put it back if the dismiss didn't actually land
    }
  }

  async function handleCheck() {
    setChecking(true);
    setCheckMessage(null);
    setError(null);
    try {
      const result = await api.runPlexAiringCheck();
      setCheckMessage(
        result.newlyFlagged > 0
          ? `Found ${result.newlyFlagged} newly aired episode${result.newlyFlagged === 1 ? '' : 's'} not in your library yet.`
          : 'Nothing new — up to date.'
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : "Couldn't check — try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <div className="wallet-page__toolbar">
        <div className="wallet-editor__hint" style={{ flex: 1 }}>
          Runs automatically every night. Shows in your Plex library are checked against TVMaze's schedule for what
          aired recently.
        </div>
        <button type="button" className="btn" onClick={handleCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {checkMessage && <div className="wallet-editor__hint" style={{ marginBottom: 8 }}>{checkMessage}</div>}
      {error && <div className="wallet-editor__error" style={{ marginBottom: 8 }}>{error}</div>}

      {!episodes ? (
        <div className="empty-state">Loading…</div>
      ) : episodes.length === 0 ? (
        <div className="empty-state">Nothing outstanding — every recently aired episode you track is already in your library.</div>
      ) : (
        <div className="plex-issues__list">
          {episodes.map((ep) => (
            <div key={ep.id} className="plex-issues__row">
              <div className="plex-issues__row-title">
                {ep.showTitle} — {String(ep.seasonNumber).padStart(2, '0')}×{String(ep.episodeNumber).padStart(2, '0')}
                {ep.episodeName ? ` “${ep.episodeName}”` : ''}
              </div>
              <div className="plex-issues__row-tags">
                <span className="plex-issues__tag">Aired {formatAired(ep.airedOn)}</span>
                <button type="button" className="wallet-editor__manage-link" onClick={() => dismiss(ep)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
