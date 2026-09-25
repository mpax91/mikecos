import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReportTabMeta } from '../contexts/TabsContext';
import { PlexLibraryPanel } from '../components/PlexLibraryPanel';
import { PlexIssuesPanel } from '../components/PlexIssuesPanel';
import { PlexAiringPanel } from '../components/PlexAiringPanel';

type PlexTab = 'library' | 'issues' | 'airing';

/** Plex — a browsable mirror of Mike's Plex library (see worker/
 * migrations/0051_plex.sql), plus two things Plex itself won't tell him:
 * what's missing metadata ("Needs attention") and what aired that isn't
 * downloaded yet ("Airing"). Same tab-shell-over-one-page pattern as
 * Wallet, and for the same reason — three related views, one nav entry. */
export function PlexPage() {
  useReportTabMeta('Plex', 'plex-list');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<PlexTab>(initialTab === 'issues' ? 'issues' : initialTab === 'airing' ? 'airing' : 'library');

  function switchTab(next: PlexTab) {
    setTab(next);
    setSearchParams(next === 'library' ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="wallet-page">
      <div className="wallet-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Plex
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

      {tab === 'library' ? <PlexLibraryPanel /> : tab === 'issues' ? <PlexIssuesPanel /> : <PlexAiringPanel />}
    </div>
  );
}
