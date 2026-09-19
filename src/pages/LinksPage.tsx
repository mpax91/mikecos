import { useEffect, useState } from 'react';
import { useReportTabMeta } from '../contexts/TabsContext';
import { api } from '../api/client';
import type { QuickLink } from '../api/types';

// Groups tiles by `category`, preserving the order categories first appear
// in (which is `sortOrder` order overall) rather than alphabetizing — so
// moving a whole group is just moving its first member.
function groupByCategory(links: QuickLink[]): Array<{ category: string; links: QuickLink[] }> {
  const groups: Array<{ category: string; links: QuickLink[] }> = [];
  const index = new Map<string, number>();
  for (const link of links) {
    let i = index.get(link.category);
    if (i === undefined) {
      i = groups.length;
      index.set(link.category, i);
      groups.push({ category: link.category, links: [] });
    }
    groups[i].links.push(link);
  }
  return groups;
}

function LinkTile({ link, onCopied }: { link: QuickLink; onCopied: (name: string) => void }) {
  const [justCopied, setJustCopied] = useState(false);

  function handleClick() {
    if (link.type === 'copy') {
      navigator.clipboard.writeText(link.url).then(() => {
        setJustCopied(true);
        onCopied(link.name);
        setTimeout(() => setJustCopied(false), 1300);
      });
    } else {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    }
  }

  const isCopyTile = link.type === 'copy';

  return (
    <button
      type="button"
      className={`link-tile${isCopyTile ? ' link-tile--copy' : ''}${justCopied ? ' is-copied' : ''}`}
      onClick={handleClick}
    >
      <span className="link-tile__icon">
        {link.thumbnailUrl ? <img src={link.thumbnailUrl} alt="" /> : link.icon || '🔗'}
      </span>
      <span className="link-tile__text">
        <span className="link-tile__name">{link.name}</span>
        <span className="link-tile__sub">{subtitleOf(link.url)}</span>
      </span>
      {isCopyTile && <span className="link-tile__action">{justCopied ? 'Copied ✓' : 'Copy'}</span>}
    </button>
  );
}

function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Host + a trimmed path, e.g. "cal.com/mikepalladino" — enough to recognize
// the destination without the tile turning into a raw-URL wall of text.
function subtitleOf(url: string): string {
  try {
    const u = new URL(safeUrl(url));
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

/** Links — a self-service tray of quick jumps to things that otherwise get
 * buried inside their own apps (Claude Projects, ChatGPT GPTs, the Cal.com
 * booking link). Read-only/click-only by design: all add/edit/remove
 * management happens in Settings → Links, not here, so this page stays
 * clean. */
export function LinksPage() {
  useReportTabMeta('Links', 'links');
  const [links, setLinks] = useState<QuickLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api
      .listQuickLinks()
      .then((res) => setLinks(res.links))
      .catch((e) => setError(String(e)));
  }, []);

  function flashToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 1300);
  }

  if (error) return <div className="empty-state">Couldn't load links: {error}</div>;
  if (!links) return <div className="empty-state">Loading…</div>;

  if (links.length === 0) {
    return (
      <div>
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Links
        </h1>
        <div className="empty-state">No links yet — add some in Settings → Links.</div>
      </div>
    );
  }

  const groups = groupByCategory(links);

  return (
    <div>
      <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
        Links
      </h1>
      <p className="links-page__subhead">Quick jumps to the things that get buried — click to open, or copy where marked.</p>

      {groups.map((group) => (
        <div className="link-section" key={group.category}>
          <div className="link-section__title">{group.category}</div>
          <div className="link-grid">
            {group.links.map((link) => (
              <LinkTile key={link.id} link={link} onCopied={(name) => flashToast(`${name} copied`)} />
            ))}
          </div>
        </div>
      ))}

      <div className={`links-page__toast${toast ? ' is-shown' : ''}`}>{toast}</div>
    </div>
  );
}
