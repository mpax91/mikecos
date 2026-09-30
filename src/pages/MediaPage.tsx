import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { MediaLibraryPanel } from '../components/MediaLibraryPanel';
import { PlexIssuesPanel } from '../components/PlexIssuesPanel';
import { PlexAiringPanel } from '../components/PlexAiringPanel';

type MediaTab = 'library' | 'issues' | 'airing';

/** Media — a browsable mirror of Mike's Plex library (see worker/
 * migrations/0051_plex.sql) plus his hand-entered physical/digital
 * catalog (see worker/migrations/0073_media_catalog.sql), together with
 * two things Plex itself won't tell him: what's missing metadata ("Needs
 * attention") and what aired that isn't downloaded yet ("Airing").
 * Those two stay Plex-only by design — a physical or digital book has no
 * metadata gaps or air dates to track. Same tab-shell-over-one-page
 * pattern as Wallet, and for the same reason — related views, one nav
 * entry. Was "Plex" — renamed once physical/digital joined it, since
 * Plex became just one of three sources rather than the whole section. */
export function MediaPage() {
  useReportTabMeta('Media', 'media-list');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<MediaTab>(initialTab === 'issues' ? 'issues' : initialTab === 'airing' ? 'airing' : 'library');

  function switchTab(next: MediaTab) {
    setTab(next);
    setSearchParams(next === 'library' ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="wallet-page">
      <div className="wallet-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Media
        </h1>
        <div className="wallet-page__tabs">
          <button type="button" className={`wallet-page__tab${tab === 'library' ? ' is-active' : ''}`} onClick={() => switchTab('library')}>
            Library
          </button>
          <button type="button" className={`wallet-page__tab${tab === 'issues' ? ' is-active' : ''}`} onClick={() => switchTab('issues')}>
            Needs Attention
          </button>
          <button type="button" className={`wallet-page__tab${tab === 'airing' ? ' is-active' : ''}`} onClick={() => switchTab('airing')}>
            Airing
          </button>
        </div>
      </div>

      {tab === 'library' ? <MediaLibraryPanel /> : tab === 'issues' ? <PlexIssuesPanel /> : <PlexAiringPanel />}
    </div>
  );
}
