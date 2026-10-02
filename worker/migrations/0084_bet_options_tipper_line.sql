-- Settings-editable option lists for the Bets feature (Bet Type, Tipper,
-- Line, Result), plus two new columns on `bets` itself: `tipper` (free
-- text — who Mike got the pick from) and `line` (the ATS/Mixed/ML/o/u
-- category that replaces the old free-text `pick` field going forward).
--
-- `pick` is left in place and untouched — old bets keep whatever free text
-- they already have there (same "add new columns, deprecate the old one in
-- place" approach as bar_items.region in 0083_bar_item_color_geo.sql). New
-- bets write to `line` instead; the UI stops offering a Pick input.
--
-- One generic table for all four editable lists rather than four tables —
-- they're all "an ordered list of (value, label) pairs Mike can add to,
-- rename, or remove," nothing category-specific beyond that. No CHECK
-- constraint on `category` or `value`, same convention as bets.result/
-- bets.stake_type: validated in the worker route handler so the set of
-- categories (or values within one) can change without a migration.
--
-- `value` is what actually gets stored on a bet row; `label` is what's
-- shown. For Bet Type/Tipper/Line they're identical today. For Result
-- they deliberately differ: `value` stays the lowercase literal
-- ('win'/'loss'/'push'/'void'/'cashed_out'/'tbd') every profit/streak
-- calculation in utils/bets.ts and worker/src/index.ts pattern-matches on,
-- while `label` is the Title Case text Mike sees ('Win', 'Cashed Out', …).
-- Editing an option through Settings only ever changes `label` — `value`
-- is fixed at creation so renaming a typo never silently reclassifies
-- every bet that already used it.
CREATE TABLE IF NOT EXISTS bet_options (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bet_options_category ON bet_options(category, position);

ALTER TABLE bets ADD COLUMN tipper TEXT;
ALTER TABLE bets ADD COLUMN line TEXT;

-- Seed defaults. Deterministic ids (rather than random uids) so this
-- migration is idempotent if it's ever re-run against a fresh DB.
INSERT OR IGNORE INTO bet_options (id, category, value, label, position, created_at) VALUES
  ('bt-straight', 'bet_type', 'Straight', 'Straight', 0, datetime('now')),
  ('bt-parlay', 'bet_type', 'Parlay', 'Parlay', 1, datetime('now')),
  ('bt-sgp', 'bet_type', 'SGP', 'SGP', 2, datetime('now')),
  ('bt-sgpx', 'bet_type', 'SGPx', 'SGPx', 3, datetime('now')),
  ('bt-future', 'bet_type', 'Future', 'Future', 4, datetime('now')),
  ('bt-prop', 'bet_type', 'Prop', 'Prop', 5, datetime('now')),
  ('bt-teaser', 'bet_type', 'Teaser', 'Teaser', 6, datetime('now')),

  ('tp-eph', 'tipper', 'EPH', 'EPH', 0, datetime('now')),
  ('tp-ylose-nhl', 'tipper', 'yLose-NHL', 'yLose-NHL', 1, datetime('now')),
  ('tp-ylose-nfl', 'tipper', 'yLose-NFL', 'yLose-NFL', 2, datetime('now')),
  ('tp-walterfootball', 'tipper', 'WalterFootball', 'WalterFootball', 3, datetime('now')),
  ('tp-ai', 'tipper', 'AI', 'AI', 4, datetime('now')),

  ('ln-ats', 'line', 'ATS', 'ATS', 0, datetime('now')),
  ('ln-mixed', 'line', 'Mixed', 'Mixed', 1, datetime('now')),
  ('ln-ml', 'line', 'ML', 'ML', 2, datetime('now')),
  ('ln-ou', 'line', 'o/u', 'o/u', 3, datetime('now')),

  ('rs-win', 'result', 'win', 'Win', 0, datetime('now')),
  ('rs-loss', 'result', 'loss', 'Loss', 1, datetime('now')),
  ('rs-push', 'result', 'push', 'Push', 2, datetime('now')),
  ('rs-void', 'result', 'void', 'Void', 3, datetime('now')),
  ('rs-cashed-out', 'result', 'cashed_out', 'Cashed Out', 4, datetime('now')),
  ('rs-tbd', 'result', 'tbd', 'TBD', 5, datetime('now'));
