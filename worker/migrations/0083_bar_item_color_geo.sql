-- Wine-specific structured fields for filtering, replacing the old
-- free-text "Varietal/blend" + "Region" pair (see the Add/Edit form
-- redesign — Mike wants to actually filter "all red wines" / "all Italian
-- wines" / "all Barolos", which free text with a datalist can't guarantee).
--
-- `category` keeps doing double duty, same as always, but its meaning
-- tightens up: for wine it now holds "Type" (an appellation or varietal —
-- Barolo, Cabernet Sauvignon — picked from a locked dropdown, not typed
-- free text); for spirits it's still the base spirit (Gin/Vodka/Whiskey/
-- etc), also now locked; for beer it's still the style. `region` (the old
-- finer-grained free-text field, e.g. "Piedmont, Italy") is superseded by
-- `geo` below and kept around unused only so no existing row's data is
-- destroyed — nothing writes to it anymore.
ALTER TABLE bar_items ADD COLUMN color TEXT; -- wine only: Red/White/Rosé/Sparkling/Orange
ALTER TABLE bar_items ADD COLUMN geo TEXT;   -- wine only: country of origin, e.g. Italy/France/USA
