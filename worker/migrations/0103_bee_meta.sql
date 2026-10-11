-- Bedford Bee: Meta (Facebook Page + Instagram) (2026-10-11). Mike's own
-- Meta app ("MikeOS", Development mode, Bedford portfolio); App ID +
-- secret pasted in Settings, OAuth through the shared cloud callback.
-- worker/src/bee/meta.ts.

CREATE TABLE bee_meta_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id TEXT,
  app_secret_enc TEXT,
  user_name TEXT,
  user_token_enc TEXT,
  user_token_expires TEXT,
  page_id TEXT,
  page_name TEXT,
  page_token_enc TEXT,              -- from a long-lived user token: doesn't expire
  pages_json TEXT,
  ig_id TEXT,
  ig_username TEXT,
  scopes TEXT,
  status TEXT,
  connected_at TEXT,
  last_sync_at TEXT,
  last_recent_at TEXT,
  last_error TEXT
);
INSERT INTO bee_meta_account (id) VALUES (1);

-- Every Facebook post and Instagram post/reel, latest numbers.
CREATE TABLE bee_meta_posts (
  platform TEXT NOT NULL,           -- fb | ig
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,         -- ISO UTC
  text TEXT,
  permalink TEXT,
  format TEXT,                      -- link | photo | video | reel | carousel | text | other
  link_url TEXT,
  likes INTEGER,                    -- FB: all reactions; IG: likes
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,                    -- IG only
  views INTEGER,                    -- Meta "views" (media views)
  reach INTEGER,
  raw_json TEXT,
  manual_tags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, id)
);
CREATE INDEX idx_bee_meta_posts_created ON bee_meta_posts(created_at);

-- Numbers at fixed ages (24h / 3d / 7d) for the early read.
CREATE TABLE bee_meta_snaps (
  platform TEXT NOT NULL,
  id TEXT NOT NULL,
  bucket TEXT NOT NULL,             -- 24h | 3d | 7d
  age_hours REAL NOT NULL,
  likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, views INTEGER,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (platform, id, bucket)
);

-- Account-level daily values: fb page_media_view / page_post_engagements /
-- page_follows / followers; ig reach / follower_count / followers.
CREATE TABLE bee_meta_days (
  platform TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (platform, date, metric)
);

-- Topic rules (editable in Settings): one row per topic, comma-separated keywords.
CREATE TABLE bee_topic_rules (
  topic TEXT PRIMARY KEY,
  keywords TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bee_topic_rules (topic, keywords, position) VALUES
  ('Town Board', 'town board,supervisor,councilmember,council member,board meeting,town hall', 0),
  ('Elections', 'election,ballot,vote,voting,candidate,campaign,primary,polls', 1),
  ('Police & Safety', 'police,cop,bpd,crime,safety,fire,ambulance', 2),
  ('Bedford 2030', 'bedford 2030,2030', 3),
  ('Roads & Traffic', 'route 172,route 22,road,traffic,pothole,sidewalk,parking,bus', 4),
  ('Business & Development', 'business,store,storefront,restaurant,shake shack,development,zoning,planning board,housing', 5),
  ('Taxes & Budget', 'tax,budget,spending,fee,cost,money', 6),
  ('Events & Community', 'event,festival,parade,holiday,veterans,library,school,community', 7);
