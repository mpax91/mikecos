-- Banking, promos, and the daily game-planning scratchpad ("Workspace" tab)
-- for the Bets section — the rest of the Google Sheets "Gambling Scorecard"
-- this feature replaces (bets/legs themselves already exist as of
-- 0032_bets.sql / 0038_bet_legs.sql).

-- Deposits/withdrawals/bonuses/adjustments, one row per sportsbook
-- transaction. A book's current balance is never stored — same
-- source-of-truth rule as bet profit (0032_bets.sql): it's derived live as
-- the sum of a book's transactions plus that book's net bet profit.
CREATE TABLE bet_transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- 'YYYY-MM-DD'
  sportsbook TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'bonus', 'adjustment')),
  amount REAL NOT NULL, -- always a positive magnitude for deposit/withdrawal/bonus; an
                         -- adjustment's sign is whatever direction the correction goes
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bet_transactions_date ON bet_transactions(date);
CREATE INDEX idx_bet_transactions_sportsbook ON bet_transactions(sportsbook);

-- Promos/odds boosts available to apply to bets — sportsbooks don't expose
-- these over any API, so this is a manually-maintained reference list,
-- mirroring the spreadsheet's "Promos" tab.
CREATE TABLE bet_promos (
  id TEXT PRIMARY KEY,
  sportsbook TEXT NOT NULL,
  description TEXT NOT NULL,
  promo_type TEXT NOT NULL DEFAULT 'Boost',
  expires_at TEXT, -- 'YYYY-MM-DD', nullable = no known expiration
  legs TEXT, -- free text: '2+', '3+', '-' — not every promo is leg-gated
  odds TEXT, -- free text: '+400', '-250/Leg' — not always a clean American-odds number
  amount TEXT, -- free text: '10%', '30%', '25-110%'
  max_bonus REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bet_promos_sportsbook ON bet_promos(sportsbook);
CREATE INDEX idx_bet_promos_status ON bet_promos(status);

-- One row per game per day — the Workspace tab's daily game-planning
-- board. `external_id` links back to the auto-pulled schedule (see
-- GET /api/bets/games, which hits ESPN's public scoreboard endpoint — no
-- API key) so a freshly fetched game merges with any notes/lines already
-- saved against it; a manually-added game (a sport ESPN's free scoreboard
-- doesn't cover) leaves it null.
CREATE TABLE bet_game_notes (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  sport TEXT NOT NULL,
  external_id TEXT,
  matchup TEXT NOT NULL, -- 'Away @ Home' display string
  start_time TEXT, -- ISO datetime from the schedule source, nullable
  note TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bet_game_notes_date ON bet_game_notes(date);
CREATE INDEX idx_bet_game_notes_external ON bet_game_notes(date, external_id);

-- Per-sportsbook lines logged against a game note, for the side-by-side
-- value comparison the spreadsheet's "Scratchpad" tab was built around.
CREATE TABLE bet_game_lines (
  id TEXT PRIMARY KEY,
  game_note_id TEXT NOT NULL REFERENCES bet_game_notes(id) ON DELETE CASCADE,
  sportsbook TEXT NOT NULL,
  line TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bet_game_lines_game ON bet_game_lines(game_note_id);
