-- Bet slip redesign (Mike, 2026-10-15). Every leg now says what KIND of
-- bet it is — market ML / Spread / Total / Prop — instead of reusing the
-- bet-level bet_type list (Straight/Future/Prop/Teaser made no sense on a
-- leg). A leg can also be 'pending': bets are logged before the games and
-- settled later (Won = every leg a hit; Lost = tap the leg that missed).
-- Straight bets get one leg too (the slip's single pick card).
--
-- SQLite can't change a CHECK constraint in place, so the table is rebuilt.
-- Nothing references bet_legs, so drop + rename is safe. bet_type stays
-- (nullable) for old rows; new legs leave it NULL.
CREATE TABLE bet_legs_new (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  sport TEXT NOT NULL,
  market TEXT CHECK (market IN ('ML', 'Spread', 'Total', 'Prop')),
  bet_type TEXT,
  pick TEXT,
  line REAL, -- spread: signed (+2.5 / -2.5); total/prop: the number, side in over_under
  over_under TEXT CHECK (over_under IN ('over', 'under')),
  odds INTEGER, -- signed American odds
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('win', 'loss', 'push', 'void', 'pending')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

INSERT INTO bet_legs_new (id, bet_id, sport, market, bet_type, pick, line, over_under, odds, result, position, created_at)
SELECT id, bet_id, sport,
  CASE
    WHEN bet_type = 'Prop' THEN 'Prop'
    WHEN over_under IS NOT NULL THEN 'Total'
    WHEN line IS NOT NULL THEN 'Spread'
    ELSE 'ML'
  END,
  bet_type, pick, line, over_under, odds, result, position, created_at
FROM bet_legs;

DROP TABLE bet_legs;
ALTER TABLE bet_legs_new RENAME TO bet_legs;
CREATE INDEX idx_bet_legs_bet ON bet_legs(bet_id);
