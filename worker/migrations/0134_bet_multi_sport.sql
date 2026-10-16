-- Parlays whose legs span more than one sport (e.g. NHL + NFL) get the
-- bet-level sport 'Multi-Sport', so "Performance by sport" stops lumping
-- them under Other or whichever sport was picked by hand. From now on the
-- worker derives this on every parlay save (deriveParlaySport); this just
-- backfills existing rows. Single-sport parlays are left as they were —
-- they pick up their leg sport the next time they're edited.
UPDATE bets
SET sport = 'Multi-Sport'
WHERE id IN (
  SELECT bet_id FROM bet_legs GROUP BY bet_id HAVING COUNT(DISTINCT sport) > 1
);
