-- A rotating bonus can beat the flat-rate floor and still not be worth
-- carrying the card for, if Mike knows he isn't going to use that specific
-- category this quarter (Discover it's Entertainment bonus, say). This
-- flag lets him say so per-bonus without deactivating the card or the
-- bonus itself — it still counts normally everywhere else (Find, the "All
-- reward cards" ranking, the category table), it's excluded only from the
-- carryPlan() rotating-bonus pass (src/utils/rewards.ts).
ALTER TABLE rewards_bonuses ADD COLUMN exclude_from_carry INTEGER NOT NULL DEFAULT 0;
