import { useEffect, useState } from 'react';
import { useReportTabMeta } from '../contexts/TabsContext';
import { api } from '../api/client';
import type { BookmarkNode, QuickLink } from '../api/types';
import { formatRelativeTime } from '../utils/formatRelativeTime';

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

function safeBookmarkHref(url: string): string {
  return safeUrl(url);
}

/** One folder node in the Bookmarks tree — collapsed by default, same as
 * the top-level section itself, so opening "Bookmarks" doesn't immediately
 * dump a full Chrome bookmarks bar's worth of nested folders on screen.
 * Recurses into its own children (mixed folders/links, rendered in the
 * order Chrome had them in). */
function BookmarkFolderRow({ node, depth }: { node: BookmarkNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const linkCount = node.children.filter((c) => c.type === 'link').length;
  const folderCount = node.children.filter((c) => c.type === 'folder').length;
  const countLabel = [linkCount > 0 ? `${linkCount} link${linkCount === 1 ? '' : 's'}` : null, folderCount > 0 ? `${folderCount} folder${folderCount === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="bookmarks-tree__folder" style={{ '--bookmark-depth': depth } as React.CSSProperties}>
      <button type="button" className="bookmarks-tree__folder-row" onClick={() => setOpen((v) => !v)}>
        <span className={`bookmarks-tree__chevron${open ? ' is-open' : ''}`}>▸</span>
        <span className="bookmarks-tree__folder-icon">📁</span>
        <span className="bookmarks-tree__folder-title">{node.title || 'Untitled folder'}</span>
        {countLabel && <span className="bookmarks-tree__folder-count">{countLabel}</span>}
      </button>
      {open && node.children.length === 0 && <div className="bookmarks-tree__empty">Empty folder</div>}
      {open &&
        node.children.map((child) =>
          child.type === 'folder' ? (
            <BookmarkFolderRow key={child.id} node={child} depth={depth + 1} />
          ) : (
            <BookmarkLinkRow key={child.id} node={child} depth={depth + 1} />
          )
        )}
    </div>
  );
}

function BookmarkLinkRow({ node, depth }: { node: BookmarkNode; depth: number }) {
  if (!node.url) return null;
  return (
    <a
      className="bookmarks-tree__link"
      style={{ '--bookmark-depth': depth } as React.CSSProperties}
      href={safeBookmarkHref(node.url)}
      target="_blank"
      rel="noopener noreferrer"
      title={node.url}
    >
      <span className="bookmarks-tree__link-icon">🔗</span>
      <span className="bookmarks-tree__link-title">{node.title || node.url}</span>
    </a>
  );
}

/** Bookmarks — a periodic, manual mirror of a Chrome bookmarks export
 * (Settings → Links → Bookmarks), shown as its own collapsed section below
 * Quick Links. Read-only here on purpose: the actual edits happen in
 * Chrome, and the next import just replaces this wholesale — see
 * BookmarksImportPanel and worker/migrations/0060_bookmarks.sql. */
function BookmarksSection() {
  const [nodes, setNodes] = useState<BookmarkNode[] | null>(null);
  const [linkCount, setLinkCount] = useState(0);
  const [lastImportedAt, setLastImportedAt] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listBookmarks()
      .then((res) => {
        setNodes(res.nodes);
        setLinkCount(res.linkCount);
        setLastImportedAt(res.lastImportedAt);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return null; // a broken bookmarks fetch shouldn't take the whole Links page down with it
  if (!nodes) return null; // still loading — the section just doesn't appear yet rather than flashing a "0 bookmarks" collapsed header

  return (
    <div className="link-section bookmarks-section">
      <button type="button" className="bookmarks-section__header" onClick={() => setOpen((v) => !v)}>
        <span className={`bookmarks-tree__chevron${open ? ' is-open' : ''}`}>▸</span>
        <span className="link-section__title" style={{ margin: 0 }}>
          Bookmarks
        </span>
        <span className="bookmarks-section__meta">
          {linkCount > 0 ? `${linkCount} link${linkCount === 1 ? '' : 's'}` : 'none imported yet'}
          {lastImportedAt && ` · last imported ${formatRelativeTime(lastImportedAt)}`}
        </span>
      </button>
      {open && (
        <div className="bookmarks-tree">
          {nodes.length === 0 ? (
            <div className="empty-state empty-state--section">No bookmarks imported yet — add some in Settings → Links.</div>
          ) : (
            nodes.map((n) =>
              n.type === 'folder' ? (
                <BookmarkFolderRow key={n.id} node={n} depth={0} />
              ) : (
                <BookmarkLinkRow key={n.id} node={n} depth={0} />
              )
            )
          )}
        </div>
      )}
    </div>
  );
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
        <BookmarksSection />
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

      <BookmarksSection />

      <div className={`links-page__toast${toast ? ' is-shown' : ''}`}>{toast}</div>
    </div>
  );
}
