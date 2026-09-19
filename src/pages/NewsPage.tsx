import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { NewsArticle, NewsFeed, NewsSavedArticle } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { NewsFeedsModal } from '../components/NewsFeedsModal';
import { useSwipe, SWIPE_THRESHOLD } from '../utils/useSwipe';

type ViewMode = 'list' | 'story' | 'saved';
type Scope = { type: 'all' } | { type: 'folder'; folder: string | null } | { type: 'feed'; feedId: string };

// Articles always open in the system browser — never an inline reader. See
// App.tsx/PROJECT history: Mike was explicit that News should behave like
// every other external link in MikeOS (desktop, mobile, tablet alike).
function openExternally(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Builds the minimal Tiptap doc a saved article becomes when sent to Jots
 * or Notes — a single paragraph, the article's title as a hyperlink to its
 * source, matching the shape the shared Link mark extension expects
 * (see NoteEditor.tsx's `.setLink({ href })` usage). */
function articleToTiptapDoc(title: string, url: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: title, marks: [{ type: 'link', attrs: { href: url } }] }],
      },
    ],
  });
}

function scopeLabel(scope: Scope, feeds: NewsFeed[]): string {
  if (scope.type === 'all') return 'All';
  if (scope.type === 'folder') return scope.folder ?? 'Uncategorized';
  return feeds.find((f) => f.id === scope.feedId)?.title ?? 'Feed';
}

function groupFeedsByFolder(feeds: NewsFeed[]): { folder: string | null; feeds: NewsFeed[] }[] {
  const map = new Map<string | null, NewsFeed[]>();
  for (const f of feeds) {
    const key = f.folder;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(f);
  }
  // Named folders first (alphabetical), Uncategorized last — matches the
  // ORDER BY the feeds endpoint already uses.
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([folder, fs]) => ({ folder, feeds: fs }));
}

export function NewsPage() {
  useReportTabMeta('News', 'news');

  const [feeds, setFeeds] = useState<NewsFeed[]>([]);
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [saved, setSaved] = useState<NewsSavedArticle[]>([]);
  const [scope, setScope] = useState<Scope>({ type: 'all' });
  const [view, setView] = useState<ViewMode>('list');
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [staleFeedIds, setStaleFeedIds] = useState<string[]>([]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [manageFeedsOpen, setManageFeedsOpen] = useState(false);

  const loadFeeds = useCallback(async () => {
    const list = await api.listNewsFeeds();
    setFeeds(list);
  }, []);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const opts =
        scope.type === 'feed'
          ? { feedId: scope.feedId, unreadOnly }
          : scope.type === 'folder'
            ? { folder: scope.folder ?? '', unreadOnly }
            : { unreadOnly };
      const res = await api.listNewsArticles(opts);
      setArticles(res.articles);
      setStaleFeedIds(res.stale_feeds);
    } finally {
      setLoading(false);
    }
  }, [scope, unreadOnly]);

  const loadSaved = useCallback(async () => {
    setSaved(await api.listNewsSaved());
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  useEffect(() => {
    if (view === 'saved') loadSaved();
    else loadArticles();
  }, [view, loadArticles, loadSaved]);

  const totalUnread = useMemo(() => feeds.reduce((sum, f) => sum + f.unread_count, 0), [feeds]);

  async function markRead(articleId: string, read: boolean) {
    setArticles((prev) => prev.map((a) => (a.id === articleId ? { ...a, is_read: read } : a)));
    await api.markNewsArticleRead(articleId, read);
    loadFeeds(); // refresh unread badges
  }

  async function saveArticle(article: NewsArticle) {
    setArticles((prev) => prev.map((a) => (a.id === article.id ? { ...a, is_saved: true } : a)));
    await api.saveNewsArticle(article.id);
  }

  async function markAllRead() {
    const opts = scope.type === 'feed' ? { feedId: scope.feedId } : scope.type === 'folder' ? { folder: scope.folder ?? '' } : undefined;
    await api.markAllNewsRead(opts);
    loadFeeds();
    loadArticles();
  }

  async function sendSaved(item: NewsSavedArticle, to: 'note' | 'jot') {
    const content = articleToTiptapDoc(item.title, item.url);
    if (to === 'jot') {
      const jot = await api.createJot(content);
      await api.updateEntity(jot.id, { title: item.title });
    } else {
      await api.createNote(item.title, content);
    }
    await api.deleteNewsSaved(item.id);
    loadSaved();
  }

  async function removeSaved(item: NewsSavedArticle) {
    await api.deleteNewsSaved(item.id);
    setSaved((prev) => prev.filter((s) => s.id !== item.id));
  }

  return (
    <div className="news-page">
      <div className="toolbar-row">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: 0 }}>
          News
        </h1>
        <div className="news-page__view-switch">
          <button className={`btn btn--ghost btn--sm${view === 'list' ? ' is-active' : ''}`} onClick={() => setView('list')}>
            Feed
          </button>
          <button className={`btn btn--ghost btn--sm${view === 'story' ? ' is-active' : ''}`} onClick={() => setView('story')}>
            Story
          </button>
          <button className={`btn btn--ghost btn--sm${view === 'saved' ? ' is-active' : ''}`} onClick={() => setView('saved')}>
            Saved{saved.length > 0 ? ` (${saved.length})` : ''}
          </button>
        </div>
        <div className="news-page__toolbar-spacer" />
        <button className="btn btn--sm btn--ghost" onClick={() => setManageFeedsOpen(true)}>
          Manage Feeds
        </button>
      </div>

      {staleFeedIds.length > 0 && (
        <p className="news-page__stale-note">
          {staleFeedIds.length === 1 ? "One feed didn't" : `${staleFeedIds.length} feeds didn't`} refresh just now — showing the last
          cached copy.
        </p>
      )}

      {view === 'saved' ? (
        <SavedView saved={saved} onSend={sendSaved} onRemove={removeSaved} />
      ) : (
        <div className="news-page__layout">
          <button className="news-page__mobile-nav-toggle" onClick={() => setMobileNavOpen((v) => !v)}>
            {mobileNavOpen ? '✕ Close' : `☰ ${scopeLabel(scope, feeds)}${totalUnread > 0 ? ` (${totalUnread})` : ''}`}
          </button>
          <nav className={`news-page__folders${mobileNavOpen ? ' is-open' : ''}`}>
            <FolderNav
              feeds={feeds}
              scope={scope}
              onSelect={(s) => {
                setScope(s);
                setMobileNavOpen(false);
              }}
            />
          </nav>

          {view === 'list' ? (
            <ListView
              articles={articles}
              loading={loading}
              unreadOnly={unreadOnly}
              onUnreadOnlyChange={setUnreadOnly}
              onMarkAllRead={markAllRead}
              onOpen={openExternally}
              onMarkRead={markRead}
              onSave={saveArticle}
            />
          ) : (
            <StoryView
              articles={articles.filter((a) => !a.is_read)}
              loading={loading}
              onMarkRead={markRead}
              onSave={saveArticle}
              onOpen={openExternally}
            />
          )}
        </div>
      )}

      {manageFeedsOpen && (
        <NewsFeedsModal
          feeds={feeds}
          onClose={() => setManageFeedsOpen(false)}
          onChanged={loadFeeds}
        />
      )}
    </div>
  );
}

function FolderNav({ feeds, scope, onSelect }: { feeds: NewsFeed[]; scope: Scope; onSelect: (s: Scope) => void }) {
  const groups = useMemo(() => groupFeedsByFolder(feeds), [feeds]);
  const totalUnread = feeds.reduce((sum, f) => sum + f.unread_count, 0);

  return (
    <>
      <button
        className={`news-page__folder-item news-page__folder-item--all${scope.type === 'all' ? ' is-active' : ''}`}
        onClick={() => onSelect({ type: 'all' })}
      >
        <span>All</span>
        {totalUnread > 0 && <span className="news-page__unread-badge">{totalUnread}</span>}
      </button>
      {groups.map(({ folder, feeds: folderFeeds }) => {
        const unread = folderFeeds.reduce((sum, f) => sum + f.unread_count, 0);
        const isActiveFolder = scope.type === 'folder' && scope.folder === folder;
        return (
          <div key={folder ?? '__none__'} className="news-page__folder-group">
            <button
              className={`news-page__folder-item${isActiveFolder ? ' is-active' : ''}`}
              onClick={() => onSelect({ type: 'folder', folder })}
            >
              <span>{folder ?? 'Uncategorized'}</span>
              {unread > 0 && <span className="news-page__unread-badge">{unread}</span>}
            </button>
            {folderFeeds.map((f) => (
              <button
                key={f.id}
                className={`news-page__feed-item${scope.type === 'feed' && scope.feedId === f.id ? ' is-active' : ''}`}
                onClick={() => onSelect({ type: 'feed', feedId: f.id })}
                title={f.last_fetch_error ?? undefined}
              >
                <span className="news-page__feed-item-title">
                  {f.last_fetch_error && <span className="news-page__feed-error-dot" title={f.last_fetch_error} />}
                  {f.title}
                </span>
                {f.unread_count > 0 && <span className="news-page__unread-badge news-page__unread-badge--sm">{f.unread_count}</span>}
              </button>
            ))}
          </div>
        );
      })}
      {feeds.length === 0 && <p className="news-page__empty-hint">No feeds yet — add one from Manage Feeds.</p>}
    </>
  );
}

function ArticleImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="news-article-card__image news-article-card__image--placeholder">📰</div>;
  return <img className="news-article-card__image" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

function ListView({
  articles,
  loading,
  unreadOnly,
  onUnreadOnlyChange,
  onMarkAllRead,
  onOpen,
  onMarkRead,
  onSave,
}: {
  articles: NewsArticle[];
  loading: boolean;
  unreadOnly: boolean;
  onUnreadOnlyChange: (v: boolean) => void;
  onMarkAllRead: () => void;
  onOpen: (url: string) => void;
  onMarkRead: (id: string, read: boolean) => void;
  onSave: (article: NewsArticle) => void;
}) {
  return (
    <div className="news-page__list">
      <div className="news-page__list-toolbar">
        <label className="news-page__unread-toggle">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => onUnreadOnlyChange(e.target.checked)} />
          Unread only
        </label>
        <button className="btn btn--sm btn--ghost" onClick={onMarkAllRead}>
          Mark all read
        </button>
      </div>
      {loading && articles.length === 0 ? (
        <p className="news-page__empty-hint">Loading&hellip;</p>
      ) : articles.length === 0 ? (
        <p className="news-page__empty-hint">{unreadOnly ? "You're all caught up." : 'No articles here yet.'}</p>
      ) : (
        <div className="news-article-list">
          {articles.map((a) => (
            <ArticleRow key={a.id} article={a} onOpen={onOpen} onMarkRead={onMarkRead} onSave={onSave} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleRow({
  article,
  onOpen,
  onMarkRead,
  onSave,
}: {
  article: NewsArticle;
  onOpen: (url: string) => void;
  onMarkRead: (id: string, read: boolean) => void;
  onSave: (article: NewsArticle) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [settled, setSettled] = useState(false);
  // Whether the drag has crossed SWIPE_THRESHOLD — i.e. releasing right now
  // would fire the action. This is the one thing the old version got wrong:
  // its "Read"/"Save" label popped to full opacity at 20px, a full 40px
  // before the swipe actually fired at the real 60px threshold, so the row
  // was already visually "committed" for a third of the drag while release
  // would still just cancel it — the mismatch between what you saw and what
  // would happen is most of why this read as clunky. Tying the armed state
  // to the exact same SWIPE_THRESHOLD useSwipe fires at fixes that, and the
  // CSS bounce on .is-armed (see .news-article-row__icon) gives a distinct,
  // deliberate "got it, now I'll fire" pop right at that real commit point —
  // the same kind of tactile confirmation Feedly's own swipe gives before
  // release, rather than nothing but a snap-back after the fact.
  const armed = Math.abs(dragX) >= SWIPE_THRESHOLD;

  // Feedly's cards resist rather than sliding indefinitely once you've
  // already dragged far enough to fire — pulling further doesn't reveal
  // more, it just feels like there's real weight to the gesture. Below the
  // threshold this passes the raw drag through 1:1 (immediate, responsive);
  // past it, only a damped fraction of the extra distance is added, capped
  // a little past the threshold itself. Without this, a fast/long swipe
  // could drag the card clean off the edge of its own colored reveal panel,
  // exposing raw page background behind it — the other big part of the
  // "odd" feeling, distinct from the label-timing issue above.
  function handleDragX(dx: number) {
    const abs = Math.abs(dx);
    const sign = Math.sign(dx);
    const clamped = abs <= SWIPE_THRESHOLD ? dx : sign * (SWIPE_THRESHOLD + (abs - SWIPE_THRESHOLD) * 0.25);
    setDragX(clamped);
  }

  // Main-feed gestures, per Mike's spec: swipe left marks read, swipe
  // right saves. Drag position tracked live so the row reveals which
  // action is about to fire, then springs back once released — nothing
  // here needs the article to physically leave the list the way an email
  // client's dismiss does (it stays, just dimmed via .is-read).
  const swipeHandlers = useSwipe({
    onDragX: handleDragX,
    onSwipeLeft: () => {
      onMarkRead(article.id, true);
      setSettled(true);
    },
    onSwipeRight: () => {
      onSave(article);
      setSettled(true);
    },
    onCancel: () => setSettled(true),
  });

  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => {
      setDragX(0);
      setSettled(false);
    }, 180);
    return () => clearTimeout(t);
  }, [settled]);

  // Both panels' reveal opacity is continuous and near-instant (a fast
  // ramp over the first 16px of drag, not a hard on/off toggle at some
  // arbitrary pixel) — the color should already be there confirming which
  // direction does what almost the moment the drag starts, the same way
  // Feedly's own swipe backgrounds appear immediately rather than fading in
  // slowly. What's reserved for the real threshold-crossing moment is the
  // icon's own bounce (via .is-armed), not the panel's visibility.
  const readOpacity = Math.min(Math.max(-dragX, 0) / 16, 1);
  const saveOpacity = Math.min(Math.max(dragX, 0) / 16, 1);

  return (
    <div className="news-article-row-wrap">
      <div className="news-article-row__action news-article-row__action--read" style={{ opacity: readOpacity }}>
        <span className={`news-article-row__icon${dragX < 0 && armed ? ' is-armed' : ''}`}>✓</span>
        <span className="news-article-row__label">Read</span>
      </div>
      <div className="news-article-row__action news-article-row__action--save" style={{ opacity: saveOpacity }}>
        <span className={`news-article-row__icon${dragX > 0 && armed ? ' is-armed' : ''}`}>🔖</span>
        <span className="news-article-row__label">Save</span>
      </div>
      <div
        className={`news-article-card${article.is_read ? ' is-read' : ''}`}
        style={{ transform: `translateX(${dragX}px)`, transition: settled ? 'transform 180ms ease' : undefined }}
        {...swipeHandlers}
        onClick={() => onOpen(article.url)}
      >
        <ArticleImage src={article.image_url} alt="" />
        <div className="news-article-card__body">
          <div className="news-article-card__meta">
            <span>{article.feed_title}</span>
            {article.published_at && <span> · {formatRelativeTime(article.published_at)}</span>}
            {article.is_saved && <span className="news-article-card__saved-flag">★ Saved</span>}
          </div>
          <div className="news-article-card__title">{article.title}</div>
          {article.description && <div className="news-article-card__desc">{article.description}</div>}
        </div>
        <div className="news-article-card__actions">
          <button
            className="btn btn--icon"
            title={article.is_read ? 'Mark unread' : 'Mark read'}
            onClick={(e) => {
              e.stopPropagation();
              onMarkRead(article.id, !article.is_read);
            }}
          >
            {article.is_read ? '○' : '●'}
          </button>
          <button
            className="btn btn--icon"
            title="Save"
            disabled={article.is_saved}
            onClick={(e) => {
              e.stopPropagation();
              onSave(article);
            }}
          >
            {article.is_saved ? '★' : '☆'}
          </button>
        </div>
      </div>
    </div>
  );
}

// TikTok-style story mode: one article at a time, title + image (+ a short
// description snippet), advanced by gesture rather than clicking a "next"
// button. Only ever shows unread articles — reading one via story mode is
// itself the "I looked, I'm passing on this" signal (swipe up = read),
// while a genuine read-it click still opens externally and leaves it
// alone, matching the list view's same tap-never-marks-read rule.
function StoryView({
  articles,
  loading,
  onMarkRead,
  onSave,
  onOpen,
}: {
  articles: NewsArticle[];
  loading: boolean;
  onMarkRead: (id: string, read: boolean) => void;
  onSave: (article: NewsArticle) => void;
  onOpen: (url: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<{ id: string; markedRead: boolean }[]>([]);
  const [dragY, setDragY] = useState(0);
  const [flash, setFlash] = useState<'read' | 'saved' | null>(null);
  const wheelLock = useRef(false);

  useEffect(() => {
    setIndex(0);
    setHistory([]);
  }, [articles.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = articles[index];

  function showFlash(kind: 'read' | 'saved') {
    setFlash(kind);
    setTimeout(() => setFlash(null), 500);
  }

  function advance(markedRead: boolean) {
    if (!current) return;
    if (markedRead) onMarkRead(current.id, true);
    setHistory((h) => [...h, { id: current.id, markedRead }]);
    setIndex((i) => i + 1);
    setDragY(0);
  }

  function goBack() {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    if (last.markedRead) onMarkRead(last.id, false);
    setHistory((h) => h.slice(0, -1));
    setIndex((i) => Math.max(0, i - 1));
    setDragY(0);
  }

  function save() {
    if (!current) return;
    onSave(current);
    showFlash('saved');
  }

  const swipeHandlers = useSwipe({
    onDragY: setDragY,
    onSwipeUp: () => {
      showFlash('read');
      advance(true);
    },
    onSwipeDown: () => goBack(),
    onSwipeLeft: save,
    onSwipeRight: save,
    onCancel: () => setDragY(0),
  });

  // Desktop: mouse wheel drives story mode the same way a vertical swipe
  // does — wheel-down (scrolling toward you) advances/marks read,
  // wheel-up goes back, mirroring the touch gesture Mike asked to keep on
  // desktop's story flow specifically.
  function onWheel(e: React.WheelEvent) {
    if (wheelLock.current) return;
    if (Math.abs(e.deltaY) < 20) return;
    wheelLock.current = true;
    setTimeout(() => (wheelLock.current = false), 250);
    if (e.deltaY > 0) {
      showFlash('read');
      advance(true);
    } else {
      goBack();
    }
  }

  if (loading && articles.length === 0) return <p className="news-page__empty-hint">Loading&hellip;</p>;
  if (articles.length === 0) return <p className="news-page__empty-hint">No unread articles here — nothing left to flip through.</p>;
  if (!current) {
    return (
      <div className="news-story">
        <p className="news-page__empty-hint">That's everything unread here.</p>
        <button className="btn btn--sm" onClick={goBack} disabled={history.length === 0}>
          ↺ Back
        </button>
      </div>
    );
  }

  return (
    <div className="news-story" onWheel={onWheel}>
      <div
        className="news-story__card"
        style={{ transform: `translate(${0}px, ${dragY}px)`, transition: dragY === 0 ? 'transform 150ms ease' : undefined }}
        {...swipeHandlers}
        onClick={() => onOpen(current.url)}
      >
        <ArticleImage src={current.image_url} alt="" />
        <div className="news-story__scrim" />
        <div className="news-story__meta">{current.feed_title}</div>
        <div className="news-story__title">{current.title}</div>
        {flash && <div className={`news-story__flash news-story__flash--${flash}`}>{flash === 'read' ? '✓ Read' : '★ Saved'}</div>}
      </div>
      <div className="news-story__controls">
        <button className="btn btn--icon" title="Back / undo" onClick={goBack} disabled={history.length === 0}>
          ↑
        </button>
        <button className="btn btn--icon" title="Save" onClick={save}>
          ★
        </button>
        <button
          className="btn btn--icon"
          title="Mark read"
          onClick={() => {
            showFlash('read');
            advance(true);
          }}
        >
          ↓
        </button>
      </div>
      <p className="news-story__hint">Swipe up to mark read · down to undo · left/right to save · tap to open</p>
    </div>
  );
}

function SavedView({
  saved,
  onSend,
  onRemove,
}: {
  saved: NewsSavedArticle[];
  onSend: (item: NewsSavedArticle, to: 'note' | 'jot') => void;
  onRemove: (item: NewsSavedArticle) => void;
}) {
  if (saved.length === 0) return <p className="news-page__empty-hint">Nothing saved yet — swipe right (or ☆) on an article to save it here.</p>;
  return (
    <div className="news-article-list">
      {saved.map((s) => (
        <div key={s.id} className="news-article-card" onClick={() => openExternally(s.url)}>
          <ArticleImage src={s.image_url} alt="" />
          <div className="news-article-card__body">
            <div className="news-article-card__meta">
              {s.feed_title && <span>{s.feed_title}</span>}
              <span> · saved {formatRelativeTime(s.saved_at)}</span>
            </div>
            <div className="news-article-card__title">{s.title}</div>
          </div>
          <div className="news-article-card__actions news-article-card__actions--saved">
            <button className="btn btn--sm btn--ghost" onClick={(e) => { e.stopPropagation(); onSend(s, 'jot'); }}>
              → Jots
            </button>
            <button className="btn btn--sm btn--ghost" onClick={(e) => { e.stopPropagation(); onSend(s, 'note'); }}>
              → Notes
            </button>
            <button className="btn btn--icon" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(s); }}>
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
