-- news_article_feeds: fixes the cross-feed duplicate problem Mike hit with
-- his NYT feeds — he subscribes to several of NYT's category feeds
-- (Business, Technology, Top Stories, Politics, US News) and the same
-- story routinely gets syndicated into more than one of them under the
-- exact same URL. news_articles' old uniqueness was (feed_id, guid/url),
-- scoped to a single feed, so the same story landed as two separate
-- unread rows the moment it appeared in a second feed.
--
-- news_articles.feed_id stays the "owning" feed — whichever feed happened
-- to carry this URL first, unchanged from before. This table just records
-- every OTHER feed that also currently carries the same story, purely so
-- that feed's/folder's article list and unread count can still include
-- it. Read/saved state was already keyed off news_articles.id, not
-- feed_id, so a single mark-as-read on the one canonical row now
-- correctly clears it everywhere it would otherwise have shown up again.
--
-- Deleting a feed cascades here same as it always did on news_articles
-- itself: if the OWNING feed is removed, the article (and any
-- news_article_feeds rows pointing at it) goes away entirely, even if
-- another still-subscribed feed also carried the same story — an
-- acceptably rare edge case, not worth reassigning ownership over.
CREATE TABLE IF NOT EXISTS news_article_feeds (
  article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES news_feeds(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_news_article_feeds_feed ON news_article_feeds (feed_id);
