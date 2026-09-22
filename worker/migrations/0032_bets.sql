-- Sports betting dashboard — Mike logs each wager the day after it's made
-- (odds, sport, sportsbook, bet type, stake, result) and MikeOS tracks
-- performance over time: money risked/won/lost, win rate, ROI, biggest
-- win/loss, and breakdowns by sport / bet type / sportsbook. This is
-- deliberately its own small table, not folded onto the Entity schema —
-- same reasoning as Contacts (0017_contacts.sql): every row has a fixed,
-- typed shape (odds, wager, result) that doesn't map onto Entity's
-- freeform content, and there's no need for it to live in a folder/project
-- hierarchy.
--
-- Profit is NOT stored — it's computed live from odds/wager/result (see
-- src/utils/bets.ts's computeProfit), same "D1 is the source of truth, no
-- stale derived values" principle used for Contacts' household
-- connections. `manual_profit`, when set, overrides that computation
-- entirely — covers odds boosts, free bets, and other promos where the
-- actual payout doesn't match a plain American-odds calculation.
--
-- Brand-new table, so CREATE TABLE is safe (see 0011_task_completions.sql
-- for why that's always true for a new table).
CREATE TABLE bets (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- 'YYYY-MM-DD' — the date of the wager/event, not when it was logged
  sport TEXT NOT NULL,
  sportsbook TEXT NOT NULL,
  bet_type TEXT NOT NULL,
  pick TEXT, -- freeform description of the actual wager, e.g. "Chiefs -3.5" or "Mahomes o275.5 pass yds"
  odds INTEGER NOT NULL, -- American odds, e.g. -110, +150
  wager REAL NOT NULL,
  result TEXT NOT NULL, -- 'win' | 'loss' | 'push' | 'void'
  manual_profit REAL, -- override for the computed profit; NULL = auto-calculate from odds/wager/result
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_bets_date ON bets(date);
