import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { NewsArticle, NewsFeed, NewsSavedArticle } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { formatRelativeTime } from '../utils/formatRelativeTime';
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
  // The main feed is always unread-only now — marking something read
  // removes it from view immediately rather than leaving it dimmed in
  // place (see markRead below). "Recently Read" is the fail-safe for
  // that: check it to see the last 25 articles marked read instead of
  // the normal feed, so an accidental swipe/tap is easy to find and flip
  // back with the same ○/● toggle. Only meaningful in the Feed tab —
  // Story mode always wants unread articles to flip through regardless
  // of this (see loadArticles' effectiveRecentlyRead below).
  const [recentlyRead, setRecentlyRead] = useState(false);
  const [loading, setLoading] = useState(false);
  const [staleFeedIds, setStaleFeedIds] = useState<string[]>([]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Every article NewsPage has ever fetched, by id — not just the ones
  // currently visible. markRead's local patch below needs an article's
  // full data (feed_id, in particular) even after it's been filtered out
  // of `articles`, e.g. to put it back in view when a Story-mode "undo"
  // marks it unread again — a plain prev.map can't resurrect an entry
  // that's no longer in the array at all.
  const articleCacheRef = useRef<Map<string, NewsArticle>>(new Map());
  // Guards against an earlier-started loadFeeds() resolving AFTER a later
  // one and clobbering fresher counts with stale ones — exactly the race
  // a quick burst of story-mode swipes (each firing its own markRead ->
  // loadFeeds) could hit, which is what made the unread badges only look
  // right after a manual refresh.
  const feedsRequestRef = useRef(0);

  const loadFeeds = useCallback(async () => {
    const requestId = ++feedsRequestRef.current;
    const list = await api.listNewsFeeds();
    if (requestId === feedsRequestRef.current) setFeeds(list);
  }, []);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      // Story mode ignores the Feed tab's "Recently Read" toggle — it
      // always wants unread articles to flip through, never the last-25
      // fail-safe list.
      const effectiveRecentlyRead = view === 'list' && recentlyRead;
      const opts =
        scope.type === 'feed'
          ? { feedId: scope.feedId, unreadOnly: true, recentlyRead: effectiveRecentlyRead }
          : scope.type === 'folder'
            ? { folder: scope.folder ?? '', unreadOnly: true, recentlyRead: effectiveRecentlyRead }
            : { unreadOnly: true, recentlyRead: effectiveRecentlyRead };
      const res = await api.listNewsArticles(opts);
      setArticles(res.articles);
      setStaleFeedIds(res.stale_feeds);
      for (const a of res.articles) articleCacheRef.current.set(a.id, a);
    } finally {
      setLoading(false);
    }
  }, [scope, view, recentlyRead]);

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
    // The normal feed only ever shows unread articles, and the Recently
    // Read fail-safe only ever shows read ones — so whichever way an
    // article's read state just changed, if it no longer belongs in the
    // list it's currently shown in, it's removed immediately rather than
    // updated in place and left dangling.
    const shouldRemove = recentlyRead ? !read : read;
    const cached = articleCacheRef.current.get(articleId);
    setArticles((prev) => {
      if (shouldRemove) return prev.filter((a) => a.id !== articleId);
      if (prev.some((a) => a.id === articleId)) return prev.map((a) => (a.id === articleId ? { ...a, is_read: read } : a));
      // Not currently in the list at all — e.g. Story mode's "undo" just
      // marked a previously-removed article unread again. Put it back at
      // the front (Story mode always reads off articles[0]) using the
      // cached copy, rather than silently dropping it until the next full
      // reload.
      return cached ? [{ ...cached, is_read: read }, ...prev] : prev;
    });
    // Instant feedback for the folder/feed unread badges, rather than
    // waiting on loadFeeds' round trip — see feedsRequestRef above for why
    // that round trip alone wasn't reliably instant either.
    if (cached) {
      setFeeds((prev) => prev.map((f) => (f.id === cached.feed_id ? { ...f, unread_count: Math.max(0, f.unread_count + (read ? -1 : 1)) } : f)));
    }
    await api.markNewsArticleRead(articleId, read);
    loadFeeds(); // reconciles with the server in case of drift
  }

  async function saveArticle(article: NewsArticle) {
    setArticles((prev) => prev.map((a) => (a.id === article.id ? { ...a, is_saved: true } : a)));
    const savedArticle = await api.saveNewsArticle(article.id);
    // Without this, the Saved tab's (N) badge only ever picked up a new
    // save the next time the Saved tab itself was opened (loadSaved runs
    // on a view switch, not on save) — so a swipe-to-save on Feed/Story
    // looked like it hadn't registered until you happened to tap over.
    setSaved((prev) => (prev.some((s) => s.id === savedArticle.id) ? prev : [savedArticle, ...prev]));
  }

  async function markAllRead() {
    const opts = scope.type === 'feed' ? { feedId: scope.feedId } : scope.type === 'folder' ? { folder: scope.folder ?? '' } : undefined;
    // Instant feedback — zero out whichever feeds are in scope rather than
    // waiting on the round trip before the badges update.
    setFeeds((prev) =>
      prev.map((f) => {
        const inScope = scope.type === 'feed' ? f.id === scope.feedId : scope.type === 'folder' ? f.folder === scope.folder : true;
        return inScope ? { ...f, unread_count: 0 } : f;
      })
    );
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
        {/* Feed management now lives in Settings (see NewsFeedsPanel) —
            this is just a deep-link over, not a popup, since it's only
            going to get more to manage (folders, sources) as it grows. */}
        <Link to="/settings?cat=news-feeds" className="news-page__settings-link" title="Manage News Feeds" aria-label="Manage News Feeds">
          ⚙️
        </Link>
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
              recentlyRead={recentlyRead}
              onRecentlyReadChange={setRecentlyRead}
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
      {feeds.length === 0 && (
        <p className="news-page__empty-hint">
          No feeds yet — add one from <Link to="/settings?cat=news-feeds">News Feeds settings</Link>.
        </p>
      )}
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
  recentlyRead,
  onRecentlyReadChange,
  onMarkAllRead,
  onOpen,
  onMarkRead,
  onSave,
}: {
  articles: NewsArticle[];
  loading: boolean;
  recentlyRead: boolean;
  onRecentlyReadChange: (v: boolean) => void;
  onMarkAllRead: () => void;
  onOpen: (url: string) => void;
  onMarkRead: (id: string, read: boolean) => void;
  onSave: (article: NewsArticle) => void;
}) {
  return (
    <div className="news-page__list">
      <div className="news-page__list-toolbar">
        <label className="news-page__unread-toggle" title="The last 25 articles you've marked read — a fail-safe for an accidental swipe or tap, since read articles now vanish from the feed instantly">
          <input type="checkbox" checked={recentlyRead} onChange={(e) => onRecentlyReadChange(e.target.checked)} />
          Recently Read
        </label>
        {/* Doesn't apply to the Recently Read fail-safe view — there's
            nothing left to mark read there. */}
        {!recentlyRead && (
          <button className="btn btn--sm btn--ghost" onClick={onMarkAllRead}>
            Mark all read
          </button>
        )}
      </div>
      {loading && articles.length === 0 ? (
        <p className="news-page__empty-hint">Loading&hellip;</p>
      ) : articles.length === 0 ? (
        <p className="news-page__empty-hint">
          {recentlyRead ? "You haven't marked anything read yet." : "You're all caught up."}
        </p>
      ) : (
        <div className="news-article-list">
          {articles.map((a) => (
            <ArticleRow key={a.id} article={a} recentlyRead={recentlyRead} onOpen={onOpen} onMarkRead={onMarkRead} onSave={onSave} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleRow({
  article,
  recentlyRead = false,
  onOpen,
  onMarkRead,
  onSave,
}: {
  article: NewsArticle;
  /** True in the Recently Read fail-safe view, where every row is read by
   * definition (so it stays dimmed same as anywhere else — see .is-read
   * below) but the swipe/tap action means the opposite of what it means
   * in the normal feed: putting it BACK to unread rather than marking it
   * read, since it's already read. */
  recentlyRead?: boolean;
  onOpen: (url: string) => void;
  onMarkRead: (id: string, read: boolean) => void;
  onSave: (article: NewsArticle) => void;
}) {
  // The previous version drove this drag through React state — setDragX on
  // every single pointermove, which re-renders this whole row (image, text,
  // buttons) on every pixel of finger movement. That's fine on a fast
  // desktop browser (which is all any synthetic/dev testing ever exercised)
  // but on real phone/tablet hardware, a full React re-render per touch
  // event can't keep up with a 60-120Hz stream of them — the visible result
  // is exactly "slightly better but still not fluid": correct now, just
  // still dropping frames. This drives the drag entirely outside React
  // instead — refs + direct DOM style writes, coalesced to one update per
  // animation frame — the same approach a native/hand-rolled high-perf drag
  // uses, so the card can track the finger at the display's actual frame
  // rate regardless of how heavy the rest of the row's markup is. React
  // state is never involved during the gesture itself, only for the actual
  // mark-read/save side effects once it resolves.
  const cardRef = useRef<HTMLDivElement>(null);
  const readPanelRef = useRef<HTMLDivElement>(null);
  const savePanelRef = useRef<HTMLDivElement>(null);
  const readIconRef = useRef<HTMLSpanElement>(null);
  const saveIconRef = useRef<HTMLSpanElement>(null);
  const dragXRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Feedly's own cards track the finger directly — no damping, no fighting
  // the gesture — right up to a hard stop, rather than getting progressively
  // "stickier" the further you pull. This clamps to a flat max a bit past
  // the fire threshold (so a fast/long swipe still can't drag the card off
  // the edge of its own full-width reveal panel, see
  // .news-article-row__action below) and otherwise gets completely out of
  // the way of the raw drag distance.
  const MAX_DRAG = SWIPE_THRESHOLD * 2;

  // Applies the current drag offset straight to the DOM. `animate` is only
  // true for the post-release spring-back, so mid-drag updates stay
  // instant (a transition on every frame would itself add a frame of lag
  // behind the finger). Only touches `transition`'s transform term —
  // `.news-article-card`'s own opacity transition (the is-read dimming)
  // stays intact either way.
  function applyDrag(dx: number, animate: boolean) {
    const card = cardRef.current;
    if (card) {
      card.style.transition = animate ? 'opacity 200ms ease, transform 180ms ease' : 'opacity 200ms ease';
      card.style.transform = `translateX(${dx}px)`;
    }
    // Continuous, near-instant reveal (a fast ramp over the first 16px of
    // drag) — the color should already be there confirming which direction
    // does what almost the moment the drag starts, the same way Feedly's
    // own swipe backgrounds appear immediately rather than fading in.
    const readOpacity = Math.min(Math.max(-dx, 0) / 16, 1);
    const saveOpacity = Math.min(Math.max(dx, 0) / 16, 1);
    if (readPanelRef.current) readPanelRef.current.style.opacity = String(readOpacity);
    if (savePanelRef.current) savePanelRef.current.style.opacity = String(saveOpacity);
    // Whether the drag has crossed SWIPE_THRESHOLD — i.e. releasing right
    // now would fire the action. Tied to the exact same threshold
    // useSwipe fires at (not a second, easy-to-drift-out-of-sync guess) so
    // what you see lines up with what release actually does; the CSS
    // bounce on .is-armed gives a distinct "got it, now I'll fire" pop
    // right at that real commit point.
    const armed = Math.abs(dx) >= SWIPE_THRESHOLD;
    readIconRef.current?.classList.toggle('is-armed', dx < 0 && armed);
    saveIconRef.current?.classList.toggle('is-armed', dx > 0 && armed);
  }

  function handleDragX(dx: number) {
    dragXRef.current = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dx));
    // Coalesce a burst of pointermove events into at most one DOM write per
    // frame — a high-frequency touch digitizer can fire well past 60
    // events/sec, and applying every single one synchronously is its own
    // source of jank even with React out of the loop.
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        applyDrag(dragXRef.current, false);
      });
    }
  }

  function springBack() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragXRef.current = 0;
    applyDrag(0, true);
  }

  // The commit timer for a read/unread action — see commitReadAction
  // below. Tracked so a row that gets unmounted mid-exit (e.g. Mike
  // switches feeds while the animation is still playing) doesn't fire a
  // stale mark-read/unread call afterward.
  const exitTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (exitTimeoutRef.current != null) window.clearTimeout(exitTimeoutRef.current);
    },
    []
  );

  // Slides the card the rest of the way off (continuing whatever drag was
  // already in progress, or starting fresh from a button tap) and fades
  // it out, holding the reveal panel at full opacity throughout — unlike
  // springBack, which fades the panel back down WITH the card as if the
  // gesture had been cancelled. This is deliberately its own motion
  // rather than the row just vanishing the instant the action commits:
  // the swipe/tap should read as something visibly happening, not a
  // silent state flip.
  function exitCard() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const card = cardRef.current;
    if (card) {
      card.style.transition = 'opacity 220ms ease, transform 220ms ease';
      card.style.transform = `translateX(${-(MAX_DRAG + 80)}px)`;
      card.style.opacity = '0';
    }
    if (readPanelRef.current) readPanelRef.current.style.opacity = '1';
  }

  // Every read-state change fired from this row — swipe or the ○/● tap —
  // ends up removing it from whichever list it's currently shown in: the
  // normal feed only ever holds unread articles, Recently Read only ever
  // holds read ones, so flipping either one always means "this no longer
  // belongs here" (see NewsPage's markRead). So rather than calling
  // onMarkRead immediately and letting the row disappear the instant
  // React re-renders, this plays the exit animation first and only
  // updates the actual list state once it's visually gone.
  function commitReadAction(read: boolean) {
    exitCard();
    exitTimeoutRef.current = window.setTimeout(() => {
      exitTimeoutRef.current = null;
      onMarkRead(article.id, read);
    }, 220);
  }

  // Main-feed gestures, per Mike's spec: swipe left marks read (or, in
  // Recently Read, marks unread — the fail-safe's whole purpose), swipe
  // right saves. Drag position tracked live so the row reveals which
  // action is about to fire; releasing past the threshold commits it via
  // commitReadAction above rather than springing back.
  const swipeHandlers = useSwipe({
    onDragX: handleDragX,
    onSwipeLeft: () => commitReadAction(!recentlyRead),
    onSwipeRight: () => {
      onSave(article);
      springBack();
    },
    onCancel: () => springBack(),
  });

  return (
    <div className="news-article-row-wrap">
      <div ref={readPanelRef} className="news-article-row__action news-article-row__action--read" style={{ opacity: 0 }}>
        <span ref={readIconRef} className="news-article-row__icon">{recentlyRead ? '↺' : '✓'}</span>
        <span className="news-article-row__label">{recentlyRead ? 'Unread' : 'Read'}</span>
      </div>
      <div ref={savePanelRef} className="news-article-row__action news-article-row__action--save" style={{ opacity: 0 }}>
        <span ref={saveIconRef} className="news-article-row__icon">🔖</span>
        <span className="news-article-row__label">Save</span>
      </div>
      <div
        ref={cardRef}
        className={`news-article-card${article.is_read ? ' is-read' : ''}`}
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
        {/* A tiny icon-only button here (just a ●/○ dot) reads fine once you
            know it's there, but the tooltip ("Mark read") is the only place
            that word actually appears — a click aimed at where that label
            implies a button should be, rather than the dot itself, falls
            through to the card underneath and opens the article instead.
            Real visible text removes the ambiguity: there's no invisible
            target to miss. */}
        <div className="news-article-card__actions">
          <button
            className="btn btn--ghost btn--sm news-article-card__action-btn"
            onClick={(e) => {
              e.stopPropagation();
              commitReadAction(!article.is_read);
            }}
          >
            {article.is_read ? '○ Mark Unread' : '● Mark Read'}
          </button>
          <button
            className="btn btn--ghost btn--sm news-article-card__action-btn"
            disabled={article.is_saved}
            onClick={(e) => {
              e.stopPropagation();
              onSave(article);
            }}
          >
            {article.is_saved ? '★ Saved' : '☆ Save'}
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
  const [history, setHistory] = useState<{ id: string; markedRead: boolean }[]>([]);
  const [dragY, setDragY] = useState(0);
  const [flash, setFlash] = useState<'read' | 'saved' | null>(null);
  const wheelLock = useRef(false);

  useEffect(() => {
    setHistory([]);
  }, [articles.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // `articles` here is already unread-only, and a swipe that marks one
  // read removes it from this same array up in NewsPage (see markRead) —
  // so the "next" card is always whichever one is now at the front, not a
  // separately-tracked numeric index. Tracking index as its own piece of
  // state used to double-advance (the array shrinks by one AND the index
  // incremented by one), silently skipping every other article — which is
  // exactly what made Story mode claim "that's everything" while unread
  // articles it had skipped over were still sitting there unread.
  const current = articles[0];

  function showFlash(kind: 'read' | 'saved') {
    setFlash(kind);
    setTimeout(() => setFlash(null), 500);
  }

  function advance(markedRead: boolean) {
    if (!current) return;
    // Marking it read removes it from `articles` up in NewsPage, which
    // alone brings the next article to the front — no index bump needed
    // (see the comment on `current` above).
    if (markedRead) onMarkRead(current.id, true);
    setHistory((h) => [...h, { id: current.id, markedRead }]);
    setDragY(0);
  }

  function goBack() {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    // Marking it unread again puts it back at the front of `articles` (see
    // markRead's resurrection case in NewsPage), which is what brings it
    // back into view here — again, no index bookkeeping needed.
    if (last.markedRead) onMarkRead(last.id, false);
    setHistory((h) => h.slice(0, -1));
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
        <div className="news-story__info">
          <div className="news-story__meta">{current.feed_title}</div>
          <div className="news-story__title">{current.title}</div>
        </div>
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
        <div key={s.id} className="news-article-card news-article-card--saved-row" onClick={() => openExternally(s.url)}>
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
