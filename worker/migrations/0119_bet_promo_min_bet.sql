-- Promos can require a minimum wager to qualify (e.g. BetMGM Hat Trick
-- Jackpot: $10+ bet). Stored in dollars; NULL = no minimum.
ALTER TABLE bet_promos ADD COLUMN min_bet REAL;
