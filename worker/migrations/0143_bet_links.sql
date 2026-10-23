-- Arb / Hedge links. Mike places opposite sides of one game on different
-- books (usually with promos) to lock in a profit — an arbitrage — or
-- places a later bet against an open one to guarantee something back — a
-- hedge. Each side is still its own row in `bets` (it moves money on its
-- own book, so Banking needs it); these columns just tie the sides
-- together so the dashboards can slice them.
--
-- link_id    shared by every bet in one group (NULL = not linked)
-- link_kind  'arb' | 'hedge'
-- link_role  'original' = the hedge's original pick, which still counts
--            toward Mike's record; 'side' = an arb side or a hedge bet,
--            which counts toward money but NOT toward win rate, record,
--            pick accuracy or streaks (an arb is a win + a loss by
--            construction — see utils/bets.ts countsAsPick).
--
-- Plain nullable ADD COLUMNs — no table rebuild, existing rows untouched.
ALTER TABLE bets ADD COLUMN link_id TEXT;
ALTER TABLE bets ADD COLUMN link_kind TEXT;
ALTER TABLE bets ADD COLUMN link_role TEXT;

CREATE INDEX idx_bets_link_id ON bets(link_id);
