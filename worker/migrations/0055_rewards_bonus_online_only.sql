-- Marks a bonus category as applying to online purchases specifically
-- (Amazon.com, "Online Shopping", Chase Travel's own booking portal) as
-- opposed to an in-person one (Dining, Gas, Groceries) — the physical
-- card only needs to be in Mike's wallet for the latter, since an online
-- purchase just needs the card's number, wherever it happens to be. Drives
-- both the "Carry in your wallet" selection (an online-only bonus never
-- earns a card a slot on its own) and a "if this is an online purchase"
-- callout in Find. Defaults to 0/false since most bonus categories really
-- are in-person ones.
ALTER TABLE rewards_bonuses ADD COLUMN online_only INTEGER NOT NULL DEFAULT 0;
