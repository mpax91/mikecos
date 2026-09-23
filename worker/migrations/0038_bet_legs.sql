-- Leg-aware parlay/SGP tracking. Money (risked/won/lost/net/ROI) stays at
-- the bet row level, exactly as it works today — a parlay is one wager,
-- win or lose as a whole, and that's what actually happened to your
-- bankroll. Pick accuracy is a different, leg-aware question ("am I
-- actually good at NBA player props" independent of whether the parlay
-- around it cashed), so it gets its own child rows rather than being
-- folded into the bet's own sport/pick fields, which stay single-valued
-- and don't make sense for a bet spanning several games/sports.
--
-- Only ever populated for a bet whose bet_type is 'Parlay', 'Same Game
-- Parlay', or 'SGP+' — a straight single bet keeps using bets.pick/odds
-- directly, unchanged. bet_type on a leg reuses the same fixed list as
-- bets.bet_type (Moneyline/Spread/Total/Player Prop/etc.) rather than a
-- separate enum.
--
-- Brand-new table, so plain CREATE TABLE is safe (see 0011_task_completions
-- .sql for why that's always true for a new table).
CREATE TABLE bet_legs (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  sport TEXT NOT NULL,
  bet_type TEXT NOT NULL,
  pick TEXT, -- freeform description, e.g. "Mahomes" or "Chiefs"
  line REAL, -- the spread/total number, when this leg has one
  over_under TEXT CHECK (over_under IN ('over', 'under')), -- only set for a total/prop leg with a direction
  odds INTEGER, -- this leg's own odds, if known — the parlay's combined odds still lives on bets.odds
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'push', 'void')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_bet_legs_bet ON bet_legs(bet_id);
